import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { startFakeSwarm } from './helpers/fake-swarm.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'torrent-search');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');
const WRAPPER = path.join(SKILL_DIR, 'scripts', 'torrent-search.mjs');

/**
 * 运行 skill 包装脚本。
 *
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function runWrapper(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [WRAPPER, ...args], {
      cwd: ROOT,
      timeout: options.timeoutMs ?? 60_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

/* ------------------------------------------------------------------ */
/* SKILL.md 的格式：DSH 的加载器对 frontmatter 有硬性要求               */
/* ------------------------------------------------------------------ */

test('SKILL.md：frontmatter 符合 DSH 的加载要求', async () => {
  const raw = await fs.readFile(SKILL_FILE, 'utf8');

  assert.ok(raw.startsWith('---\n') || raw.startsWith('---\r\n'), 'frontmatter 必须从第一行的 --- 开始');

  const end = raw.indexOf('\n---', 3);
  assert.ok(end > 0, 'frontmatter 必须有结束的 ---');
  const frontmatter = raw.slice(raw.indexOf('\n') + 1, end);

  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');

  assert.ok(name, 'frontmatter 必须有 name');
  assert.ok(description, 'frontmatter 必须有 description');

  // DSH 的 SKILL_NAME 规则：小写字母数字 + 连字符
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `name 不符合 DSH 命名规则：${name}`);
  assert.equal(name, path.basename(SKILL_DIR), 'name 必须与目录名一致');
  assert.ok(description.length > 40, 'description 要写清「何时使用」，不能太短');

  // 加载器会拒绝这些旧键（见 dsh-skill-filesystem 的 rejectLegacyInvocationKey）
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    assert.ok(!new RegExp(`^${legacy}:`, 'm').test(frontmatter), `frontmatter 不能使用旧键 ${legacy}`);
  }
});

test('SKILL.md：提到的脚本路径真实存在', async () => {
  const raw = await fs.readFile(SKILL_FILE, 'utf8');
  assert.ok(raw.includes('scripts/torrent-search.mjs') || raw.includes('scripts\\torrent-search.mjs'));
  await fs.access(WRAPPER); // 不存在会抛错
});

/* ------------------------------------------------------------------ */
/* 包装脚本：命令行行为                                                */
/* ------------------------------------------------------------------ */

test('包装脚本：help 列出全部命令', async () => {
  const { code, stdout } = await runWrapper(['help']);
  assert.equal(code, 0);
  for (const command of ['search', 'sources', 'check', 'doctor', 'download', 'tasks']) {
    assert.ok(stdout.includes(command), `help 里应提到 ${command}`);
  }
});

test('包装脚本：未知命令返回 2', async () => {
  const { code, stderr } = await runWrapper(['nonsense']);
  assert.equal(code, 2);
  assert.match(stderr, /未知命令/);
});

test('包装脚本：sources 输出数据源 JSON', async () => {
  const { code, stdout } = await runWrapper(['sources']);
  assert.equal(code, 0);

  const data = JSON.parse(stdout);
  assert.equal(data.ok, true);
  const ids = data.sources.map((source) => source.id);
  for (const expected of ['apibay', 'nyaa', 'bitsearch', 'mikan', 'dmhy', 'academic', 'demo']) {
    assert.ok(ids.includes(expected), `应包含数据源 ${expected}`);
  }
  for (const source of data.sources) {
    assert.ok(source.name, `${source.id} 缺少 name`);
    assert.ok(Array.isArray(source.kinds), `${source.id} 缺少 kinds`);
    assert.equal(typeof source.defaultEnabled, 'boolean');
  }
});

test('包装脚本：search 用离线演示源，输出紧凑 JSON', async () => {
  // demo 源是内置离线数据，因此这个用例不联网
  const { code, stdout } = await runWrapper(['search', 'ubuntu', '--sources', 'demo', '--limit', '2']);
  assert.equal(code, 0);

  const data = JSON.parse(stdout);
  assert.equal(data.ok, true);
  assert.equal(data.query, 'ubuntu');
  assert.ok(data.results.length > 0 && data.results.length <= 2, '结果条数应受 --limit 限制');
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].id, 'demo');

  for (const item of data.results) {
    assert.ok(item.title, '结果应有标题');
    assert.match(item.magnet, /^magnet:\?xt=urn:btih:[0-9a-f]{40}/i, '磁力链接格式应正确');
    assert.equal(item.infoHash.length, 40);
    assert.ok(Array.isArray(item.sources));
    assert.ok('seeders' in item && 'size' in item);
  }
});

test('包装脚本：--magnet-only 只输出磁力链接', async () => {
  const { code, stdout } = await runWrapper(['search', 'ubuntu', '--sources', 'demo', '--magnet-only']);
  assert.equal(code, 0);

  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /^magnet:\?xt=urn:btih:/, `不应出现非磁力行：${line}`);
  }
});

test('包装脚本：search 缺少关键词时报错并给出用法', async () => {
  const { code, stderr } = await runWrapper(['search']);
  assert.equal(code, 1);
  assert.match(stderr, /关键词/);
});

test('包装脚本：tasks 连不上服务时给出可执行的提示', async () => {
  // 端口 1 不会有服务监听，保证与开发机上是否开着 serve 无关
  const { code, stderr } = await runWrapper(['tasks', '--port', '1'], { timeoutMs: 30_000 });
  assert.equal(code, 1);
  assert.match(stderr, /serve|连不上/);
});

test('包装脚本：--home 指定项目根目录', async () => {
  const { code, stdout } = await runWrapper(['sources', '--home', ROOT]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).ok, true);
});

test('包装脚本：布尔标志不会被当成带值选项（参数错位的回归测试）', async () => {
  // 曾经漏登记 --no-extra-trackers / --no-dht，导致它们吞掉后面的参数，
  // 引擎于是仍去等公共 tracker 超时（下载从 1 秒变成 40 秒）
  const { code, stdout } = await runWrapper([
    'download',
    'magnet:?xt=urn:btih:0000000000000000000000000000000000000000',
    '--no-extra-trackers',
    '--no-dht',
    '--dir',
    'X',
    '--backend',
    'builtin',
    '--dump-options',
  ]);
  assert.equal(code, 0);

  const { options, positional } = JSON.parse(stdout);
  assert.equal(options['no-extra-trackers'], true, '--no-extra-trackers 应解析为布尔开关');
  assert.equal(options['no-dht'], true, '--no-dht 应解析为布尔开关');
  assert.equal(options.dir, 'X', '--dir 应拿到它自己的值');
  assert.equal(options.backend, 'builtin');
  assert.equal(positional.length, 1, '磁力链接应是唯一的位置参数');
});

test('包装脚本：带值选项后面紧跟标志时不会吞掉标志', async () => {
  const { code, stdout } = await runWrapper(['search', 'ubuntu', '--sources', '--limit', '3', '--dump-options']);
  assert.equal(code, 0);

  const { options } = JSON.parse(stdout);
  assert.equal(options.sources, undefined, '--sources 缺值时应保持未定义，而不是吃掉 --limit');
  assert.equal(options.limit, '3', '--limit 应正常取到值');
});

/* ------------------------------------------------------------------ */
/* 包装脚本：下载（用本地假种子群，端到端）                             */
/* ------------------------------------------------------------------ */

test('包装脚本：download 端到端下载本地假种子群的内容', async () => {
  const content = crypto.randomBytes(256 * 1024);
  const swarm = await startFakeSwarm({ content, name: 'skill-demo.bin', pieceLength: 16_384 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-skill-dl-'));

  try {
    const { code, stdout, stderr } = await runWrapper(
      [
        'download',
        swarm.magnet,
        '--dir',
        dir,
        '--backend',
        'builtin',
        // 关掉公共 tracker 与 DHT：既保证离线，也避免等 UDP 超时
        '--no-extra-trackers',
        '--no-dht',
        '--timeout-seconds',
        '90',
      ],
      { timeoutMs: 120_000 },
    );

    assert.equal(code, 0, `下载应成功，stderr：${stderr}`);
    const result = JSON.parse(stdout);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.backend, 'builtin');
    assert.equal(result.bytesDone, content.length);
    assert.equal(result.totalBytes, content.length);
    assert.equal(result.error, null);

    // 真的落盘了，而且字节一致
    const file = path.join(dir, 'skill-demo.bin');
    const written = await fs.readFile(file);
    assert.equal(written.length, content.length);
    assert.ok(written.equals(content), '下载内容应与种子内容逐字节一致');
  } finally {
    await swarm.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
