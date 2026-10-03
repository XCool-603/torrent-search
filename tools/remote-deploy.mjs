#!/usr/bin/env node
/**
 * 把项目部署 / 升级到一台装了 Docker 的远程服务器（走 ssh）。
 *
 *   node tools/remote-deploy.mjs deploy  --host user@server [--dir /opt/torrent-search]
 *   node tools/remote-deploy.mjs upgrade --host user@server [--ref v1.1.0]
 *   node tools/remote-deploy.mjs status  --host user@server
 *   node tools/remote-deploy.mjs logs    --host user@server
 *   node tools/remote-deploy.mjs doctor  --host user@server
 *   node tools/remote-deploy.mjs tunnel  --host user@server [--port 8787]
 *
 * 设计取舍：
 *   - 只依赖 ssh 与 tar（服务器上几乎必然都有），**不要求服务器装 git 或 Node**；
 *     代码以 tar 流推送，随后在服务器上调用已经验证过的 scripts/docker.sh。
 *   - 文件清单由 Node 自己遍历生成（而不是用 tar 的 --exclude），
 *     因为 GNU tar 与 Windows 自带 bsdtar 的排除语义不一致，容易漏排。
 *   - `.env` 与 `downloads/` **永不推送**：那是服务器上的配置与你的下载文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 不进服务器的目录与文件 */
const EXCLUDED_DIRS = new Set(['.git', '.cache', 'downloads', 'node_modules']);
const EXCLUDED_FILES = new Set(['.env', '.env.local']);
const EXCLUDED_SUFFIX = ['.log', '-out.txt'];

/* ------------------------------------------------------------------ */
/* 最小 tar 打包（不调用外部 tar）                                      */
/* ------------------------------------------------------------------ */

/**
 * 写一个 ustar 头。
 *
 * 为什么自己写而不是调用系统 tar：
 *   1. Windows 自带的 bsdtar 不支持 `-T -`（从 stdin 读文件清单），实测直接报
 *      "Couldn't visit directory"；
 *   2. bsdtar 会把中文文件名按本机 ANSI 代码页写进包头，解到 Linux 上就成了乱码文件名
 *      （本仓库有 docs/需求与架构设计.md）；
 *   3. 少一个外部依赖，两个平台行为一致，也便于测试。
 *
 * @param {string} name
 * @param {number} size
 * @param {number} mode
 * @param {number} mtimeSeconds
 * @returns {Buffer}
 */
function tarHeader(name, size, mode, mtimeSeconds) {
  const header = Buffer.alloc(512);
  const nameBytes = Buffer.from(name, 'utf8');

  let prefix = '';
  let shortName = name;
  if (nameBytes.length > 100) {
    // 拆成 prefix + name（ustar 允许，两边各限 155/100 字节）
    const slash = name.lastIndexOf('/');
    if (slash > 0) {
      prefix = name.slice(0, slash);
      shortName = name.slice(slash + 1);
    }
    if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(shortName, 'utf8') > 100) {
      throw new Error(`路径过长，无法写入 tar 头：${name}`);
    }
  }

  const writeString = (value, offset, length) => {
    const bytes = Buffer.from(value, 'utf8');
    bytes.copy(header, offset, 0, Math.min(bytes.length, length));
  };
  const writeOctal = (value, offset, length) => {
    // 长度含结尾的 NUL（或空格），所以用 length-1 位八进制
    const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
    header.write(text, offset, length - 1, 'ascii');
  };

  writeString(shortName, 0, 100);
  writeOctal(mode & 0o7777, 100, 8);
  writeOctal(0, 108, 8); // uid：解包方按自己的用户处理
  writeOctal(0, 116, 8); // gid
  writeOctal(size, 124, 12);
  writeOctal(mtimeSeconds, 136, 12);
  header.write('        ', 148, 8, 'ascii'); // 校验和先填空格
  header.write('0', 156, 1, 'ascii'); // typeflag：普通文件
  writeString('ustar', 257, 6); // magic
  header.write('00', 263, 2, 'ascii'); // version
  writeString(prefix, 345, 155);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  return header;
}

/**
 * 把若干文件打成 tar（不压缩）。
 *
 * @param {Array<{name: string, data: Buffer, mode: number, mtimeSeconds: number}>} entries
 * @returns {Buffer}
 */
function createTar(entries) {
  const chunks = [];

  for (const entry of entries) {
    chunks.push(tarHeader(entry.name, entry.data.length, entry.mode, entry.mtimeSeconds));
    chunks.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }

  chunks.push(Buffer.alloc(1024)); // 结束标记：两个全零块
  return Buffer.concat(chunks);
}

const USAGE = `部署 / 升级到远程服务器（需要服务器已装 Docker）

用法：node tools/remote-deploy.mjs <命令> --host <user@server> [选项]

命令：
  deploy    首次部署：推送代码 → 在服务器上构建并启动 → 健康检查
  upgrade   升级：推送代码 → 重建镜像 → 重启 → 健康检查（失败自动回滚）
            --ref <tag|分支>   指定版本，例如 --ref v1.1.0
  status    查看服务器上的容器状态与健康检查
  logs      跟随服务器上的容器日志
  doctor    在服务器容器内跑 P2P 环境诊断
  tunnel    建立 SSH 隧道，把服务器的 Web UI 映射到本地（前台运行，Ctrl+C 结束）

选项：
  --host <user@server>   必填（除了 help）
  --dir <路径>           服务器上的部署目录，默认 /opt/torrent-search
  --port <端口>          服务器上发布的端口，默认 8787（用于 tunnel 与提示）
  --bind <IP>            deploy/upgrade 时同时设置服务器上的监听地址：
                         默认 127.0.0.1（只本机，配合 tunnel）；
                         设 0.0.0.0 表示允许局域网访问（本服务无鉴权，请配好防火墙）
  --identity <私钥文件>  传给 ssh -i
  --ssh-port <端口>      ssh 端口，默认 22
  --ssh <命令>           ssh 可执行文件（默认 ssh；也可用环境变量 TORRENT_SEARCH_SSH）

安全提示：本服务没有鉴权。容器默认只绑服务器回环，用 tunnel 命令访问即可；
要让局域网直接访问，在服务器的 .env 里设 TORRENT_SEARCH_BIND=0.0.0.0 并配好防火墙。
`;

/**
 * 解析参数。
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {};
  let command = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      if (command === null) command = arg;
      continue;
    }
    options[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return { command, options };
}

/**
 * 单引号包裹，供远端 shell 使用。
 *
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 递归收集要推送的文件（相对 ROOT 的路径）。
 *
 * @param {string} dir
 * @param {string} prefix
 * @param {string[]} out
 */
async function collectFiles(dir, prefix, out) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    if (entry.isFile() && (EXCLUDED_FILES.has(entry.name) || EXCLUDED_SUFFIX.some((suffix) => entry.name.endsWith(suffix)))) {
      continue;
    }
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(path.join(dir, entry.name), relative, out);
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
}

/**
 * 按 shell 习惯切分"命令 + 参数"，支持用引号包住带空格的路径。
 *
 * @param {string} raw
 * @returns {string[]}
 */
function splitCommandLine(raw) {
  const parts = [];
  let current = '';
  let quote = null;

  for (const char of String(raw)) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * ssh 可执行文件与它的前置参数。
 *
 * 允许写成"命令 + 参数"的形式，例如：
 *   --ssh "plink -batch"                        改用 plink
 *   --ssh "\"C:\Program Files\ssh.exe\" -v"      路径带空格时用引号
 *   --ssh "node /path/stub.mjs"                  测试用的桩
 * 这也是 Windows 上唯一可行的覆盖方式：Node 从 CVE-2024-27980 之后拒绝直接
 * spawn .cmd/.bat（抛 EINVAL），而 shell: true 会带来命令注入风险，不能用。
 *
 * @param {Record<string, string>} options
 * @returns {{command: string, prefixArgs: string[]}}
 */
function sshBinary(options) {
  const parts = splitCommandLine(options.ssh ?? process.env.TORRENT_SEARCH_SSH ?? 'ssh');
  if (parts.length === 0) return { command: 'ssh', prefixArgs: [] };
  return { command: parts[0], prefixArgs: parts.slice(1) };
}

/**
 * 拼出 ssh 的基础参数。
 *
 * @param {Record<string, string>} options
 * @returns {string[]}
 */
function sshBaseArgs(options) {
  const args = [];
  if (options['ssh-port']) args.push('-p', String(options['ssh-port']));
  if (options.identity) args.push('-i', String(options.identity));
  return args;
}

/**
 * 跑一条 ssh 命令（输出直接透传）。
 *
 * @param {Record<string, string>} options
 * @param {string} remoteCommand
 * @param {{stdio?: any}} [spawnOptions]
 * @returns {Promise<number>}
 */
function runSsh(options, remoteCommand, spawnOptions = {}) {
  return new Promise((resolve, reject) => {
    const { command, prefixArgs } = sshBinary(options);
    const args = [...prefixArgs, ...sshBaseArgs(options), String(options.host), remoteCommand];
    const child = spawn(command, args, { stdio: spawnOptions.stdio ?? 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => reject(new Error(`无法执行 ssh（${command}）：${error.message}`)));
  });
}

/**
 * 把工作树以 tar.gz 流推送到服务器。
 *
 * @param {Record<string, string>} options
 * @param {string} dir
 */
async function pushTree(options, dir) {
  const names = [];
  await collectFiles(ROOT, '', names);
  if (names.length === 0) throw new Error('没有可推送的文件');

  const entries = [];
  for (const name of names) {
    const absolute = path.join(ROOT, name);
    const [data, stat] = await Promise.all([fs.readFile(absolute), fs.stat(absolute)]);
    entries.push({
      name,
      data,
      mode: stat.mode & 0o777 || 0o644,
      mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
    });
  }

  const archive = zlib.gzipSync(createTar(entries), { level: 6 });
  process.stdout.write(
    `▸ 推送 ${entries.length} 个文件（${Math.round(archive.length / 1024)} KB）到 ${options.host}:${dir}\n`,
  );

  // 远端：建目录并把 tar 流解开（服务器上的 GNU tar 能正确处理 UTF-8 文件名）
  const remoteCommand = `set -e; mkdir -p ${quote(dir)}; tar xzf - -C ${quote(dir)}`;
  const { command: sshCommand, prefixArgs } = sshBinary(options);
  const sshArgs = [...prefixArgs, ...sshBaseArgs(options), String(options.host), remoteCommand];

  await new Promise((resolve, reject) => {
    const ssh = spawn(sshCommand, sshArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    ssh.on('error', (error) =>
      fail(new Error(`无法执行 ssh（${sshCommand}）：${error.message}（Windows 10+ 自带 OpenSSH 客户端）`)),
    );
    // 远端提前关闭 stdin（例如目录不可写）时会 EPIPE：这属于正常失败路径，交给 exit 处理
    ssh.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') fail(new Error(`写入 ssh 失败：${error.message}`));
    });
    ssh.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`推送失败（ssh 退出码 ${code}）`));
    });

    ssh.stdin.end(archive);
  });
}

/**
 * 在服务器上的 .env 里设置监听地址。
 *
 * 只改这一个键，其余内容与注释原样保留；.env 不存在时先从 .env.example 生成。
 * 用 sed 而不是重写整个文件，是为了不碰用户自己加的其他配置。
 *
 * @param {Record<string, string>} options
 * @param {string} dir
 * @param {string} bind
 * @returns {Promise<number>}
 */
async function setRemoteBind(options, dir, bind) {
  // 这个值会被插进远端 shell 命令，必须白名单化（只允许 IP 字面量），否则就是命令注入
  if (!/^[0-9a-fA-F.:]+$/.test(bind)) {
    throw new Error(`--bind 只接受 IP 字面量（例如 0.0.0.0 或 127.0.0.1），收到：${bind}`);
  }

  const remote = [
    `cd ${quote(dir)}`,
    '[ -f .env ] || cp .env.example .env',
    `if grep -q '^TORRENT_SEARCH_BIND=' .env; then`,
    `sed -i "s|^TORRENT_SEARCH_BIND=.*|TORRENT_SEARCH_BIND=${bind}|" .env;`,
    `else`,
    `printf '\\nTORRENT_SEARCH_BIND=${bind}\\n' >> .env;`,
    `fi`,
    `echo "TORRENT_SEARCH_BIND=${bind}"`,
  ].join(' ');

  return await runSsh(options, remote);
}

/**
 * 在服务器上调用 scripts/docker.sh。
 *
 * @param {Record<string, string>} options
 * @param {string} dir
 * @param {string[]} command
 * @returns {Promise<number>}
 */
async function runRemoteScript(options, dir, command) {
  const remote = `cd ${quote(dir)} && sh scripts/docker.sh ${command.map((item) => quote(item)).join(' ')}`;
  return await runSsh(options, remote);
}

function printAccess(options) {
  const port = options.port ?? '8787';
  const dir = options.dir ?? '/opt/torrent-search';

  if (options.bind && options.bind !== '127.0.0.1') {
    process.stdout.write(
      `\n局域网访问已开启（监听 ${options.bind}）：\n` +
        `  http://<服务器IP>:${port}/\n` +
        `\n  还需要放行端口（二选一，按你的发行版）：\n` +
        `    sudo ufw allow from 192.168.0.0/16 to any port ${port} proto tcp     # ufw\n` +
        `    sudo firewall-cmd --permanent --add-port=${port}/tcp && sudo firewall-cmd --reload  # firewalld\n` +
        `  云服务器还要在控制台的**安全组**里放行该端口，并且只填可信来源网段。\n` +
        `\n  ⚠ 本服务没有鉴权：能访问到它的人都能创建下载任务（往下载目录写文件）。\n` +
        `    只在可信网络里这样用；要公网访问请放在带鉴权的反向代理之后。\n`,
    );
    return;
  }

  process.stdout.write(
    `\n访问方式（服务默认只绑服务器回环，所以需要隧道）：\n` +
      `  node tools/remote-deploy.mjs tunnel --host ${options.host} --port ${port}\n` +
      `  然后本地浏览器打开 http://127.0.0.1:${port}/\n` +
      `\n  想让局域网直接访问：加 --bind 0.0.0.0 重新部署，或在 ${dir}/.env 里设\n` +
      `  TORRENT_SEARCH_BIND=0.0.0.0 后重跑 upgrade，并确保防火墙只放行可信网段。\n`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const { command, options } = parseArgs(argv);

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (!options.host) throw new Error('必须用 --host <user@server> 指定服务器');

  const dir = options.dir ?? '/opt/torrent-search';

  switch (command) {
    case 'deploy': {
      await pushTree(options, dir);
      if (options.bind) {
        const bindCode = await setRemoteBind(options, dir, String(options.bind));
        if (bindCode !== 0) throw new Error('在服务器上设置监听地址失败');
      }
      const code = await runRemoteScript(options, dir, ['deploy']);
      if (code !== 0) throw new Error(`服务器上的部署失败（退出码 ${code}）`);
      printAccess(options);
      return 0;
    }
    case 'upgrade': {
      await pushTree(options, dir);
      if (options.bind) {
        const bindCode = await setRemoteBind(options, dir, String(options.bind));
        if (bindCode !== 0) throw new Error('在服务器上设置监听地址失败');
      }
      const args = options.ref ? ['upgrade', '--ref', String(options.ref)] : ['upgrade'];
      const code = await runRemoteScript(options, dir, args);
      if (code !== 0) throw new Error(`服务器上的升级失败（退出码 ${code}）`);
      printAccess(options);
      return 0;
    }
    case 'status':
      return await runRemoteScript(options, dir, ['status']);
    case 'logs':
      return await runRemoteScript(options, dir, ['logs']);
    case 'doctor': {
      const remote = `cd ${quote(dir)} && docker compose exec -T torrent-search node bin/magnet-search.mjs doctor`;
      return await runSsh(options, remote);
    }
    case 'tunnel': {
      const port = options.port ?? '8787';
      process.stdout.write(`▸ 隧道已建立：本地 http://127.0.0.1:${port}/ → ${options.host}:127.0.0.1:${port}\n`);
      process.stdout.write('  按 Ctrl+C 结束\n');
      const { command: sshCommand, prefixArgs } = sshBinary(options);
      const args = [...prefixArgs, ...sshBaseArgs(options), '-N', '-L', `127.0.0.1:${port}:127.0.0.1:${port}`, String(options.host)];
      return await new Promise((resolve, reject) => {
        const child = spawn(sshCommand, args, { stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', (error) => reject(new Error(`无法执行 ssh（${sshCommand}）：${error.message}`)));
      });
    }
    default:
      process.stdout.write(USAGE);
      throw new Error(`未知命令：${command}`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`\n✗ ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
