import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * 验证 Docker 部署/升级脚本的分支行为。
 *
 * 本机（和 CI）通常没有 Docker daemon，所以这里把一个**桩 docker** 放到 PATH 最前面：
 * 它记录收到的参数，并能按 STUB_HEALTH 模拟健康检查成功/失败。
 * 这样就能覆盖真正危险的分支——升级失败回滚、本地改动拒绝、detached HEAD。
 *
 * 这些分支不是假想的：桩测试实际抓出过三个 bug（.env 挡住升级、--ref 后无法再升级、
 * .ps1 缺 UTF-8 BOM 导致中文脚本语法错误）。
 */

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

/**
 * 找可用的 POSIX shell（Windows 上用 Git 自带的 bash）。
 *
 * @returns {Promise<string|null>}
 */
async function findPosixShell() {
  const candidates = IS_WINDOWS
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    : ['/bin/sh', '/usr/bin/sh'];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/**
 * 建一个测试工作区：桩 docker + 两份仓库副本。
 *
 * 关键：升级用的仓库是**从当前工作树**建出来的本地仓库（而不是 `git clone` 本仓库）。
 * clone 只会拿到已提交的代码，未提交的改动测不到——曾经因此让测试一直在验证旧版本。
 * 这里建一个 bare 的 origin 并推上去，这样脚本里的 `git fetch` / `git pull --ff-only`
 * 都有真实的远端可交互；同时造一个 v1.0.0 tag 供 `--ref` 与回滚用例使用。
 *
 * @param {string} workspace
 */
async function prepareWorkspace(workspace) {
  const binDir = path.join(workspace, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  // 桩 docker（POSIX）：记录调用，按 STUB_HEALTH 决定健康检查成败
  const shStub = `#!/usr/bin/env sh
echo "docker $*" >> "$STUB_LOG"
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then exit 0; fi
if [ "$1" = "compose" ] && [ "$2" = "exec" ]; then
  if [ "\${STUB_HEALTH:-ok}" = "ok" ]; then exit 0; else exit 1; fi
fi
if [ "$1" = "compose" ] && [ "$2" = "ps" ]; then echo "torrent-search  Up (healthy)"; exit 0; fi
if [ "$1" = "compose" ] && [ "$2" = "logs" ]; then echo "种子搜索服务已启动"; exit 0; fi
exit 0
`;
  await fs.writeFile(path.join(binDir, 'docker'), shStub, 'utf8');
  await fs.chmod(path.join(binDir, 'docker'), 0o755).catch(() => {});

  // 桩 docker（Windows）：同样的行为，用 cmd 批处理。
  // 注意：这里用 goto 而不是把逻辑写在 ( ) 块里——cmd 的括号块内 `exit /b 1`
  // 不可靠（实测进入了分支却返回 0），用标签跳转才稳定。
  const cmdStub = [
    '@echo off',
    'echo docker %*>> "%STUB_LOG%"',
    'if "%1"=="compose" if "%2"=="version" exit /b 0',
    'if "%1"=="compose" if "%2"=="exec" goto exec_branch',
    'if "%1"=="compose" if "%2"=="ps" echo torrent-search  Up (healthy)',
    'if "%1"=="compose" if "%2"=="logs" echo started',
    'exit /b 0',
    ':exec_branch',
    'if "%STUB_HEALTH%"=="fail" exit /b 1',
    'exit /b 0',
    '',
  ].join('\r\n');
  await fs.writeFile(path.join(binDir, 'docker.cmd'), cmdStub, 'utf8');

  /** 把当前工作树复制到目标目录（排除不该进测试仓库的东西）。 */
  const copyTree = async (target) => {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
      if (['.git', '.cache', 'downloads', 'node_modules'].includes(entry.name)) continue;
      await fs.cp(path.join(ROOT, entry.name), path.join(target, entry.name), { recursive: true });
    }
  };

  const git = (args, cwd) =>
    execFileAsync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd,
      windowsHide: true,
    });

  // ① 模拟 tarball 安装：只有文件，没有 .git
  const deployDir = path.join(workspace, 'repo-deploy');
  await copyTree(deployDir);

  // ② 升级用：本地仓库 + bare origin，工作树内容即当前代码
  const upgradeDir = path.join(workspace, 'repo-upgrade');
  const originDir = path.join(workspace, 'origin.git');
  await copyTree(upgradeDir);
  await git(['init', '--quiet', '-b', 'main'], upgradeDir);
  await git(['add', '-A'], upgradeDir);
  await git(['commit', '--quiet', '-m', '旧版本'], upgradeDir);
  await git(['tag', 'v1.0.0'], upgradeDir);

  // 再提交一次，让 main 比 v1.0.0 新（这样"从旧版本升级"才有真实变化）
  await fs.appendFile(path.join(upgradeDir, 'README.md'), '\n<!-- 新版本 -->\n', 'utf8');
  await git(['add', '-A'], upgradeDir);
  await git(['commit', '--quiet', '-m', '新版本'], upgradeDir);

  await execFileAsync('git', ['init', '--bare', '--quiet', originDir], { windowsHide: true });
  await git(['remote', 'add', 'origin', originDir], upgradeDir);
  await git(['push', '--quiet', '-u', 'origin', 'main'], upgradeDir);
  await git(['push', '--quiet', 'origin', '--tags'], upgradeDir);

  return { binDir, deployDir, upgradeDir };
}

/**
 * 跑一次部署脚本，返回退出码与输出。
 *
 * @param {{binDir: string, dir: string, shell: string|null, health: string, logFile: string, command: string[]}} params
 */
async function runScript(params) {
  const env = {
    ...process.env,
    PATH: `${params.binDir}${path.delimiter}${process.env.PATH}`,
    STUB_LOG: params.logFile,
    STUB_HEALTH: params.health,
    // 让健康检查快速结束，测试不必等 60 秒
    TORRENT_SEARCH_HEALTH_ATTEMPTS: '2',
    TORRENT_SEARCH_HEALTH_INTERVAL: '0',
  };

  const [file, args] = IS_WINDOWS
    ? [
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(params.dir, 'scripts', 'docker.ps1'), ...params.command],
      ]
    : [params.shell, [path.join(params.dir, 'scripts', 'docker.sh'), ...params.command]];

  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: params.dir,
      env,
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      output: `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    };
  }
}

async function readCalls(logFile) {
  try {
    return await fs.readFile(logFile, 'utf8');
  } catch {
    return '';
  }
}

/** 在临时工作区里跑一组测试，跑完清理。 */
async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-docker-'));
  const shell = await findPosixShell();

  try {
    const { binDir, deployDir, upgradeDir } = await prepareWorkspace(workspace);
    await run({
      workspace,
      shell,
      logFile: path.join(workspace, 'calls.log'),
      binDir,
      deployDir,
      upgradeDir,
      run: (dir, command, health = 'ok') =>
        runScript({ binDir, dir, shell, health, logFile: path.join(workspace, 'calls.log'), command }),
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 平台无关：脚本文件的编码约定                                          */
/* ------------------------------------------------------------------ */

test('部署脚本：.sh 不能有 BOM，.ps1 必须有 BOM', async () => {
  const sh = await fs.readFile(path.join(ROOT, 'scripts', 'docker.sh'));
  const ps1 = await fs.readFile(path.join(ROOT, 'scripts', 'docker.ps1'));

  // BOM 会破坏 shebang
  assert.equal(sh[0], 0x23, '.sh 应以 # 开头（不能带 BOM）');
  assert.equal(sh.subarray(0, 2).toString(), '#!', '.sh 应以 shebang 开头');

  // Windows PowerShell 5.1 没有 BOM 时会按 ANSI 解码，中文脚本会直接语法错误
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], '.ps1 必须带 UTF-8 BOM');
});

test('部署脚本：两个脚本都在（sh 与 ps1 行为要保持一致）', async () => {
  for (const name of ['docker.sh', 'docker.ps1']) {
    await fs.access(path.join(ROOT, 'scripts', name));
  }
  // compose 与 Dockerfile 是部署脚本的前提
  for (const name of ['docker-compose.yml', 'Dockerfile', '.env.example']) {
    await fs.access(path.join(ROOT, name));
  }
});

test('部署脚本：.env 已被 gitignore（否则生成的 .env 会挡住升级）', async () => {
  const ignore = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m, '.env 必须在 .gitignore 里');
});

/* ------------------------------------------------------------------ */
/* POSIX sh 脚本：完整分支覆盖                                          */
/* ------------------------------------------------------------------ */

test('docker.sh：deploy 成功时构建、健康检查并给出访问地址', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    const result = await ctx.run(ctx.deployDir, ['deploy'], 'ok');
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /部署完成/);
    assert.match(result.output, /Web UI/);

    const calls = await readCalls(ctx.logFile);
    assert.match(calls, /compose up -d --build/);
    await fs.access(path.join(ctx.deployDir, '.env')); // 自动从 .env.example 生成
  });
});

test('docker.sh：deploy 健康检查失败时打印日志并以 1 退出', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    const result = await ctx.run(ctx.deployDir, ['deploy'], 'fail');
    assert.equal(result.code, 1);
    assert.match(result.output, /健康检查未通过/);
    assert.match(result.output, /种子搜索服务已启动/); // 自动带出容器日志

    const calls = await readCalls(ctx.logFile);
    assert.equal((calls.match(/compose exec/g) ?? []).length, 2, '应按配置重试 2 次');
  });
});

test('docker.sh：upgrade 拉取代码、重建并健康检查', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    const result = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /升级完成/);

    const calls = await readCalls(ctx.logFile);
    assert.match(calls, /compose up -d --build/);
  });
});

test('docker.sh：生成的 .env 不会挡住升级', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    // 模拟 deploy 留下的未跟踪 .env
    await fs.copyFile(path.join(ctx.upgradeDir, '.env.example'), path.join(ctx.upgradeDir, '.env'));

    const result = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(result.code, 0, `未跟踪的 .env 不应阻止升级：${result.output}`);
    assert.match(result.output, /升级完成/);
  });
});

test('docker.sh：本地有未提交改动时拒绝升级', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    await fs.appendFile(path.join(ctx.upgradeDir, 'README.md'), '\n本地改动\n', 'utf8');

    const result = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(result.code, 1);
    assert.match(result.output, /检测到本地未提交的改动/);

    // 用户的改动必须原样保留
    const readme = await fs.readFile(path.join(ctx.upgradeDir, 'README.md'), 'utf8');
    assert.match(readme, /本地改动/);
  });
});

test('docker.sh：升级后健康检查失败会回滚到升级前的提交', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    // 先退到旧 tag，让升级真的会改变提交
    await execFileAsync('git', ['checkout', '--quiet', 'v1.0.0'], { cwd: ctx.upgradeDir, windowsHide: true });
    const { stdout: before } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ctx.upgradeDir,
      windowsHide: true,
    });

    const result = await ctx.run(ctx.upgradeDir, ['upgrade'], 'fail');
    assert.equal(result.code, 1);
    assert.match(result.output, /回滚到/);

    const { stdout: after } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ctx.upgradeDir,
      windowsHide: true,
    });
    assert.equal(after.trim(), before.trim(), '应回到升级前的提交');

    const calls = await readCalls(ctx.logFile);
    assert.equal((calls.match(/compose up -d --build/g) ?? []).length, 2, '回滚后应重新构建一次');
  });
});

test('docker.sh：从 detached HEAD 也能升级（--ref 升级过之后）', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    await execFileAsync('git', ['checkout', '--quiet', 'v1.0.0'], { cwd: ctx.upgradeDir, windowsHide: true });

    const result = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /切回 main/);

    const { stdout: branch } = await execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: ctx.upgradeDir,
      windowsHide: true,
    });
    assert.equal(branch.trim(), 'main');
  });
});

test('docker.sh：upgrade --ref 切换到指定 tag', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    const result = await ctx.run(ctx.upgradeDir, ['upgrade', '--ref', 'v1.0.0'], 'ok');
    assert.equal(result.code, 0, result.output);

    const { stdout: described } = await execFileAsync('git', ['describe', '--tags'], {
      cwd: ctx.upgradeDir,
      windowsHide: true,
    });
    assert.equal(described.trim(), 'v1.0.0');
  });
});

test('docker.sh：未知命令打印用法并返回 1', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    const result = await ctx.run(ctx.deployDir, ['nonsense'], 'ok');
    assert.equal(result.code, 1);
    assert.match(result.output, /用法：/);
  });
});

test('docker.sh：没有 docker 时给出安装指引而不是崩溃', { skip: IS_WINDOWS ? 'Windows 上由 ps1 覆盖' : false }, async () => {
  await withWorkspace(async (ctx) => {
    if (!ctx.shell) return;

    // 用一个不含桩 docker 的 PATH
    const emptyBin = path.join(ctx.workspace, 'empty-bin');
    await fs.mkdir(emptyBin, { recursive: true });

    const result = await runScript({
      binDir: emptyBin,
      dir: ctx.deployDir,
      shell: ctx.shell,
      health: 'ok',
      logFile: ctx.logFile,
      command: ['deploy'],
    });

    assert.equal(result.code, 1);
    assert.match(result.output, /找不到 docker 命令/);
  });
});

/* ------------------------------------------------------------------ */
/* Windows PowerShell 脚本                                             */
/* ------------------------------------------------------------------ */

// 注意：Windows PowerShell 5.1 会按控制台代码页（中文系统是 GBK）向管道写输出，
// 所以这里只断言**行为**（退出码、文件、调用记录、git 状态），不去匹配中文文案——
// 那样在英文系统或非 936 代码页上会假失败。

test('docker.ps1：deploy 成功时构建、健康检查并生成 .env', { skip: IS_WINDOWS ? false : '仅在 Windows 上运行' }, async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(ctx.deployDir, ['deploy'], 'ok');
    assert.equal(result.code, 0, result.output);

    const calls = await readCalls(ctx.logFile);
    assert.match(calls, /compose up -d --build/);
    assert.match(calls, /compose exec -T torrent-search wget/);
    await fs.access(path.join(ctx.deployDir, '.env'));
  });
});

test('docker.ps1：deploy 健康检查失败时以 1 退出并重试', { skip: IS_WINDOWS ? false : '仅在 Windows 上运行' }, async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(ctx.deployDir, ['deploy'], 'fail');
    assert.equal(result.code, 1, result.output);

    const calls = await readCalls(ctx.logFile);
    assert.equal((calls.match(/compose exec/g) ?? []).length, 2, '应按配置重试 2 次');
    assert.match(calls, /compose logs/);
  });
});

test('docker.ps1：upgrade 成功时拉取代码并重建', { skip: IS_WINDOWS ? false : '仅在 Windows 上运行' }, async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(result.code, 0, result.output);

    const calls = await readCalls(ctx.logFile);
    assert.match(calls, /compose up -d --build/);
  });
});

test('docker.ps1：未跟踪的 .env 不阻止升级；已跟踪文件改动则拒绝', { skip: IS_WINDOWS ? false : '仅在 Windows 上运行' }, async () => {
  await withWorkspace(async (ctx) => {
    // 未跟踪的 .env（deploy 会生成）不应阻止升级
    await fs.copyFile(path.join(ctx.upgradeDir, '.env.example'), path.join(ctx.upgradeDir, '.env'));
    const withEnv = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(withEnv.code, 0, `未跟踪的 .env 不应阻止升级：${withEnv.output}`);

    // 已跟踪文件的改动必须被拒绝，且改动要保留
    await fs.appendFile(path.join(ctx.upgradeDir, 'README.md'), '\n本地改动\n', 'utf8');
    const refused = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(refused.code, 1, refused.output);

    const readme = await fs.readFile(path.join(ctx.upgradeDir, 'README.md'), 'utf8');
    assert.match(readme, /本地改动/);
  });
});

test('docker.ps1：升级后健康检查失败会回滚到升级前的提交', { skip: IS_WINDOWS ? false : '仅在 Windows 上运行' }, async () => {
  await withWorkspace(async (ctx) => {
    await execFileAsync('git', ['checkout', '--quiet', 'v1.0.0'], { cwd: ctx.upgradeDir, windowsHide: true });
    const { stdout: before } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ctx.upgradeDir,
      windowsHide: true,
    });

    const result = await ctx.run(ctx.upgradeDir, ['upgrade'], 'fail');
    assert.equal(result.code, 1, result.output);

    const { stdout: after } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ctx.upgradeDir,
      windowsHide: true,
    });
    assert.equal(after.trim(), before.trim(), '应回到升级前的提交');

    const calls = await readCalls(ctx.logFile);
    assert.equal((calls.match(/compose up -d --build/g) ?? []).length, 2, '回滚后应重新构建一次');
  });
});

test('docker.ps1：从 detached HEAD 也能升级；未知命令返回 1', { skip: IS_WINDOWS ? false : '仅在 Windows 上运行' }, async () => {
  await withWorkspace(async (ctx) => {
    // detached HEAD（上次 --ref 升级留下的状态）
    await execFileAsync('git', ['checkout', '--quiet', 'v1.0.0'], { cwd: ctx.upgradeDir, windowsHide: true });
    const upgraded = await ctx.run(ctx.upgradeDir, ['upgrade'], 'ok');
    assert.equal(upgraded.code, 0, upgraded.output);

    const { stdout: branch } = await execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: ctx.upgradeDir,
      windowsHide: true,
    });
    assert.equal(branch.trim(), 'main', '应切回默认分支');

    // 未知命令
    const unknown = await ctx.run(ctx.deployDir, ['nonsense'], 'ok');
    assert.equal(unknown.code, 1);
  });
});
