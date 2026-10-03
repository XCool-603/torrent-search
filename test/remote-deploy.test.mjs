import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * 验证 tools/remote-deploy.mjs 的编排逻辑。
 *
 * 用桩 ssh 顶替真 ssh：它把参数记录到日志，并把收到的 tar 流存成文件，
 * 于是可以真的解开压缩包，检查哪些文件被推送、哪些被排除——
 * 尤其是 `.env` 与 `downloads/` 绝不能被推上去（那是服务器上的配置与用户的数据）。
 */

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

/** 桩 ssh 本体（Node 实现，两个平台共用）。 */
const SSH_STUB = `import fs from 'node:fs';

let body = '';
if (process.argv.includes('-N') === false) {
  // 远端命令里带 tar xzf 的，说明这是推送：把 stdin（tar 流）存下来
  const command = process.argv.slice(2).join(' ');
  if (command.includes('tar xzf -')) {
    body = await new Promise((resolve) => {
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    });
    fs.writeFileSync(process.env.STUB_ARCHIVE, body);
  }
}

fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;

/**
 * 建一个测试工作区（含桩 ssh）。
 *
 * 桩用 `node <脚本>` 的方式调用，而不是把 ssh.cmd 放到 PATH：
 * Node 从 CVE-2024-27980 之后拒绝直接 spawn .cmd/.bat（抛 EINVAL），
 * 而 `shell: true` 会带来命令注入风险，工具里不能用。
 *
 * @param {string} workspace
 */
async function prepareStub(workspace) {
  const binDir = path.join(workspace, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const stub = path.join(binDir, 'ssh-stub.mjs');
  await fs.writeFile(stub, SSH_STUB, 'utf8');
  return { binDir, stub };
}

/**
 * 跑一次 remote-deploy。
 *
 * @param {{binDir: string, logFile: string, archive: string, args: string[]}} params
 */
async function runRemoteDeploy(params) {
  const env = {
    ...process.env,
    PATH: `${params.binDir}${path.delimiter}${process.env.PATH}`,
    STUB_LOG: params.logFile,
    STUB_ARCHIVE: params.archive,
  };

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['tools/remote-deploy.mjs', ...params.args], {
      cwd: ROOT,
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

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-remote-'));
  try {
    const { binDir, stub } = await prepareStub(workspace);
    const logFile = path.join(workspace, 'ssh.log');
    const archive = path.join(workspace, 'pushed.tar.gz');
    await run({
      workspace,
      binDir,
      logFile,
      archive,
      run: (args) => runRemoteDeploy({ binDir, logFile, archive, args: ['--ssh', `${process.execPath} ${stub}`, ...args] }),
      readLog: async () => {
        try {
          return (await fs.readFile(logFile, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch {
          return [];
        }
      },
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/** 解开推送的压缩包并列出内容。 */
async function listArchive(archivePath) {
  const { stdout } = await execFileAsync('tar', ['-tzf', archivePath], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

/* ------------------------------------------------------------------ */

test('remote-deploy：缺少 --host 时明确报错', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['deploy']);
    assert.equal(result.code, 1);
    assert.match(result.output, /--host/);
  });
});

test('remote-deploy：help 列出全部命令', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['help']);
    assert.equal(result.code, 0);
    for (const command of ['deploy', 'upgrade', 'status', 'logs', 'doctor', 'tunnel']) {
      assert.ok(result.output.includes(command), `help 里应提到 ${command}`);
    }
  });
});

test('remote-deploy deploy：推送代码并在服务器上执行 docker.sh deploy', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['deploy', '--host', 'user@example.invalid', '--dir', '/opt/ts']);
    assert.equal(result.code, 0, result.output);

    const calls = await ctx.readLog();
    assert.equal(calls.length, 2, `应有两次 ssh 调用，实际 ${calls.length}`);

    // ① 推送：建目录 + 解 tar
    const push = calls[0].join(' ');
    assert.match(push, /user@example\.invalid/);
    assert.match(push, /mkdir -p '\/opt\/ts'/);
    assert.match(push, /tar xzf - -C '\/opt\/ts'/);

    // ② 在服务器上跑部署脚本
    const deploy = calls[1].join(' ');
    assert.match(deploy, /cd '\/opt\/ts' && sh scripts\/docker\.sh 'deploy'/);

    // 提示里应给出隧道访问方式
    assert.match(result.output, /tunnel --host user@example\.invalid/);
  });
});

test('remote-deploy：推送的包里不含 .env / downloads / .git / 缓存', async () => {
  await withWorkspace(async (ctx) => {
    // 造出这些"绝不能推上去"的东西
    await fs.writeFile(path.join(ROOT, '.env'), 'TORRENT_SEARCH_PORT=9999\n', 'utf8');
    await fs.mkdir(path.join(ROOT, 'downloads'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'downloads', 'secret.bin'), 'x', 'utf8');

    try {
      const result = await ctx.run(['deploy', '--host', 'user@example.invalid']);
      assert.equal(result.code, 0, result.output);

      const entries = await listArchive(ctx.archive);
      const has = (prefix) => entries.some((entry) => entry === prefix || entry.startsWith(`${prefix}/`));

      // 必须推上去的
      assert.ok(entries.includes('docker-compose.yml'), '应包含 docker-compose.yml');
      assert.ok(entries.includes('Dockerfile'), '应包含 Dockerfile');
      assert.ok(entries.includes('scripts/docker.sh'), '应包含部署脚本');
      assert.ok(entries.includes('package.json'), '应包含 package.json');

      // 绝不能推上去的
      assert.ok(!entries.includes('.env'), '.env 不能被推送（会覆盖服务器配置）');
      assert.ok(!has('downloads'), 'downloads/ 不能被推送');
      assert.ok(!has('.git'), '.git 不能被推送');
      assert.ok(!has('.cache'), '.cache 不能被推送');
      assert.ok(!has('node_modules'), 'node_modules 不能被推送');
      assert.ok(!entries.some((entry) => entry.endsWith('.log')), '日志文件不该被推送');
    } finally {
      await fs.rm(path.join(ROOT, '.env'), { force: true });
      await fs.rm(path.join(ROOT, 'downloads'), { recursive: true, force: true });
    }
  });
});

test('remote-deploy upgrade：带上 --ref 传达到服务器', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['upgrade', '--host', 'user@example.invalid', '--dir', '/srv/ts', '--ref', 'v1.1.0']);
    assert.equal(result.code, 0, result.output);

    const calls = await ctx.readLog();
    assert.equal(calls.length, 2);
    assert.match(calls[1].join(' '), /sh scripts\/docker\.sh 'upgrade' '--ref' 'v1\.1\.0'/);
  });
});

test('remote-deploy：status / logs / doctor 走对应的远端命令', async () => {
  await withWorkspace(async (ctx) => {
    await ctx.run(['status', '--host', 'u@h', '--dir', '/srv/ts']);
    await ctx.run(['logs', '--host', 'u@h', '--dir', '/srv/ts']);
    await ctx.run(['doctor', '--host', 'u@h', '--dir', '/srv/ts']);

    const calls = await ctx.readLog();
    const joined = calls.map((call) => call.join(' '));

    assert.ok(joined.some((line) => line.includes(`sh scripts/docker.sh 'status'`)), 'status 应调用远端 status');
    assert.ok(joined.some((line) => line.includes(`sh scripts/docker.sh 'logs'`)), 'logs 应调用远端 logs');
    assert.ok(
      joined.some((line) => line.includes('docker compose exec -T torrent-search node bin/magnet-search.mjs doctor')),
      'doctor 应在容器内执行',
    );

    // status/logs/doctor 不需要推送代码
    assert.ok(!joined.some((line) => line.includes('tar xzf -')), '这些命令不该推送代码');
  });
});

test('remote-deploy tunnel：建立到服务器回环的端口转发', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['tunnel', '--host', 'u@h', '--port', '9000']);
    assert.equal(result.code, 0, result.output);

    const calls = await ctx.readLog();
    const args = calls[0];
    assert.ok(args.includes('-N'), 'tunnel 应使用 -N');
    assert.ok(args.includes('-L'), 'tunnel 应使用 -L');
    assert.ok(args.includes('127.0.0.1:9000:127.0.0.1:9000'), `端口转发参数不对：${args.join(' ')}`);
    assert.ok(args.includes('u@h'));
  });
});

test('remote-deploy：--identity 与 --ssh-port 会传给 ssh', async () => {
  await withWorkspace(async (ctx) => {
    await ctx.run(['status', '--host', 'u@h', '--identity', '/tmp/key', '--ssh-port', '2222']);
    const calls = await ctx.readLog();
    const args = calls[0];
    assert.ok(args.includes('-p') && args.includes('2222'), '应传 -p 2222');
    assert.ok(args.includes('-i') && args.includes('/tmp/key'), '应传 -i /tmp/key');
  });
});

test('remote-deploy：--bind 会在服务器上设置监听地址并给出防火墙提示', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['deploy', '--host', 'u@h', '--dir', '/srv/ts', '--bind', '0.0.0.0']);
    assert.equal(result.code, 0, result.output);

    const calls = await ctx.readLog();
    // 顺序：推送 → 设置 .env → 部署
    assert.equal(calls.length, 3, `应有三次 ssh 调用，实际 ${calls.length}`);

    const setBind = calls[1].join(' ');
    assert.match(setBind, /TORRENT_SEARCH_BIND=0\.0\.0\.0/, '应写入 .env');
    assert.match(setBind, /cp \.env\.example \.env/, '.env 不存在时应从示例生成');
    assert.match(setBind, /sed -i/, '已有该键时应就地替换而不是追加');

    // 提示里要给出局域网地址与防火墙命令，并重申"没有鉴权"
    assert.match(result.output, /局域网访问已开启/);
    assert.match(result.output, /ufw allow/);
    assert.match(result.output, /安全组/);
    assert.match(result.output, /没有鉴权/);
  });
});

test('remote-deploy：--bind 只接受 IP 字面量（防命令注入）', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['deploy', '--host', 'u@h', '--bind', '0.0.0.0; rm -rf /']);
    assert.equal(result.code, 1);
    assert.match(result.output, /只接受 IP 字面量/);

    // 危险的串绝不能进到远端命令里
    const calls = await ctx.readLog();
    assert.ok(!calls.some((call) => call.join(' ').includes('rm -rf')), '不应把注入内容发到远端');
  });
});

test('remote-deploy：默认（不加 --bind）只提示隧道访问', async () => {
  await withWorkspace(async (ctx) => {
    const result = await ctx.run(['deploy', '--host', 'u@h']);
    assert.equal(result.code, 0, result.output);

    const calls = await ctx.readLog();
    assert.equal(calls.length, 2, '不加 --bind 时不该多一次设置 .env 的调用');
    assert.match(result.output, /tunnel --host u@h/);
    assert.ok(!result.output.includes('局域网访问已开启'));
  });
});

// 保留 spawn 引用，避免未使用导入告警（未来加交互式用例时会用到）
void spawn;
