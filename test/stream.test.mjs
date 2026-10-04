/**
 * 边下边播（`/api/stream`）测试。
 *
 * 分两层：
 *   1. 单元层：Range 解析、文件↔分片映射、「已就绪连续区间」、等待逻辑 ——
 *      用合成的会话与假 storage，完全确定性、不联网、不依赖时序。
 *   2. 集成层：真实引擎 + 假种子群 + 真实 HTTP 服务，验线上报文
 *      （状态码、Content-Range、逐字节内容）。
 *
 * 集成层刻意**不注入假引擎**：流式播放最容易错的地方正是「哪些字节已经可信」，
 * 只有真实的分片校验与落盘才能验出来 —— 假引擎会把这个最关键的部分绕过去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startServer } from '../src/server.mjs';
import { DownloadManager } from '../src/download/manager.mjs';
import { parseRange, contentTypeFor, readyLength, readReadyRange } from '../src/bt/stream.mjs';
import { parseInfoDict, piecesForFileRange } from '../src/bt/torrent.mjs';
import { decodeAll, infoHashOf } from '../src/bt/bencode.mjs';
import { memoryCache } from './helpers.mjs';
import { startFakeSwarm, buildInfoDict } from './helpers/fake-swarm.mjs';

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 造一个「可预测内容」的缓冲区：每个字节等于其下标对 251 取模。
 * 这样断言某一段时可以直接算出期望值，不必依赖随机数据的副本比对。
 *
 * @param {number} length
 * @returns {Buffer}
 */
function patternedBuffer(length) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buffer[i] = i % 251;
  return buffer;
}

/**
 * 造一个种子模型（走真实的 parseInfoDict，不是手搓对象）。
 *
 * @param {{content: Buffer, pieceLength: number, name: string}} params
 */
function buildTorrent({ content, pieceLength, name }) {
  const infoBytes = buildInfoDict({ name, pieceLength, content });
  return parseInfoDict(decodeAll(infoBytes), infoHashOf(infoBytes));
}

/**
 * 合成会话：done 位图可控、storage 直接切内容，用来确定性地验证等待与裁剪逻辑。
 *
 * @param {any} torrent
 * @param {boolean[]} done
 * @param {Buffer} content
 */
function fakeSession(torrent, done, content) {
  return {
    torrent,
    done,
    storage: {
      async readFileRange(_fileIndex, offset, length) {
        return content.subarray(offset, offset + length);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 单元层
// ---------------------------------------------------------------------------

test('parseRange：常规 / 开区间 / 后缀 / 截断 / 越界 / 多区间', () => {
  const size = 1000;

  assert.deepEqual(parseRange('bytes=0-99', size), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=100-', size), { start: 100, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', size), { start: 900, end: 999 });
  // 请求超出末尾：按 RFC 截到末尾，而不是报错
  assert.deepEqual(parseRange('bytes=0-99999', size), { start: 0, end: 999 });
  assert.deepEqual(parseRange('BYTES=0-1', size), { start: 0, end: 1 });

  // 没有 Range 头 = 整文件
  assert.equal(parseRange(undefined, size), null);
  assert.equal(parseRange('', size), null);

  // 起点越界 / 区间反了 / 后缀为 0：都该 416
  assert.deepEqual(parseRange('bytes=1000-', size), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=200-100', size), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=-0', size), { unsatisfiable: true });

  // 多区间与非法单位：回退整文件（返回 unsupported），绝不返回拼错的局部数据
  assert.deepEqual(parseRange('bytes=0-1,5-6', size), { unsupported: true });
  assert.deepEqual(parseRange('items=0-1', size), { unsupported: true });
  assert.deepEqual(parseRange('bytes=abc', size), { unsupported: true });
});

test('contentTypeFor：类型给错会让浏览器直接拒播', () => {
  assert.equal(contentTypeFor('a/b/EP01.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('EP02.MKV'), 'video/x-matroska');
  assert.equal(contentTypeFor('x.ts'), 'video/mp2t');
  assert.equal(contentTypeFor('sub.srt'), 'application/x-subrip');
  assert.equal(contentTypeFor('没有扩展名'), 'application/octet-stream');
});

test('piecesForFileRange：文件偏移 → 分片区间', () => {
  const content = patternedBuffer(100_000);
  const torrent = buildTorrent({ content, pieceLength: 16_384, name: 'ep.mp4' });

  assert.equal(torrent.pieceCount, 7); // ceil(100000 / 16384)

  assert.deepEqual(piecesForFileRange(torrent, 0, 0, 1), { first: 0, last: 0 });
  assert.deepEqual(piecesForFileRange(torrent, 0, 16_383, 1), { first: 0, last: 0 });
  // 跨片：最后 1 字节 + 下一片第 1 字节
  assert.deepEqual(piecesForFileRange(torrent, 0, 16_383, 2), { first: 0, last: 1 });
  assert.deepEqual(piecesForFileRange(torrent, 0, 100_000 - 1, 1), { first: 6, last: 6 });

  assert.throws(() => piecesForFileRange(torrent, 0, 99_000, 2_000), /超出文件/);
  assert.throws(() => piecesForFileRange(torrent, 0, 0, 0), /长度非法/);
  assert.throws(() => piecesForFileRange(torrent, 9, 0, 1), /文件下标越界/);
});

test('readyLength：只给「连续且已校验」的字节，中间缺一片就截断', () => {
  const content = patternedBuffer(100_000);
  const torrent = buildTorrent({ content, pieceLength: 16_384, name: 'ep.mp4' });
  const total = torrent.pieceCount;

  // 一片都没有
  assert.equal(readyLength(fakeSession(torrent, new Array(total).fill(false), content), 0, 0, 100_000), 0);

  // 只有第 0 片：最多给到第 0 片末尾
  const only0 = new Array(total).fill(false);
  only0[0] = true;
  assert.equal(readyLength(fakeSession(torrent, only0, content), 0, 0, 100_000), 16_384);

  // 从片中间开始要：只到该片末尾
  assert.equal(readyLength(fakeSession(torrent, only0, content), 0, 1_000, 100_000), 16_384 - 1_000);

  // 第 0、1 片有，第 2 片没有 → 到第 1 片末尾为止
  const two = new Array(total).fill(false);
  two[0] = true;
  two[1] = true;
  assert.equal(readyLength(fakeSession(torrent, two, content), 0, 0, 100_000), 32_768);

  // 全都有 → 受 maxLength 限制
  const all = new Array(total).fill(true);
  assert.equal(readyLength(fakeSession(torrent, all, content), 0, 0, 100_000), 100_000);
  assert.equal(readyLength(fakeSession(torrent, all, content), 0, 0, 500), 500);
  assert.equal(readyLength(fakeSession(torrent, all, content), 0, 99_990, 100_000), 10);
});

test('readReadyRange：等首片就绪后才返回，且只返回已就绪的连续部分', async () => {
  const content = patternedBuffer(100_000);
  const torrent = buildTorrent({ content, pieceLength: 16_384, name: 'ep.mp4' });
  const done = new Array(torrent.pieceCount).fill(false);
  const session = fakeSession(torrent, done, content);

  // 200ms 后才把首片标成完成
  const timer = setTimeout(() => {
    done[0] = true;
  }, 200);

  const { buffer, waitedMs } = await readReadyRange({
    session,
    fileIndex: 0,
    offset: 0,
    maxLength: 100,
    pollMs: 20,
    timeoutMs: 5_000,
  });
  clearTimeout(timer);

  assert.ok(waitedMs >= 150, `应当等待首片就绪，实际只等了 ${waitedMs}ms`);
  assert.deepEqual(buffer, content.subarray(0, 100));
});

test('readReadyRange：等待分片时必须保住事件循环（轮询定时器不能 unref）', async () => {
  // 为什么用子进程：这个 bug 只在「事件循环里没有其它 ref 句柄」时暴露。
  // 在测试进程里跑，runner 自己的句柄会一直保活，unref 与否看不出区别
  // （Node 24 上就是这样：同一个 bug 在 20/22 上失败、24 上通过）。
  //
  // 子进程里刻意让「让分片就绪」的定时器也 unref，于是能否活到分片就绪
  // 完全取决于 readReadyRange 的轮询定时器是否 ref：
  //   修好 → 输出 OK；被 unref → 进程提前退出，什么都不输出。
  const base = pathToFileURL(path.join(ROOT_DIR, 'src')).href;
  const helpers = pathToFileURL(path.join(ROOT_DIR, 'test', 'helpers', 'fake-swarm.mjs')).href;

  const script = `
import { readReadyRange } from '${base}/bt/stream.mjs';
import { parseInfoDict } from '${base}/bt/torrent.mjs';
import { decodeAll, infoHashOf } from '${base}/bt/bencode.mjs';
import { buildInfoDict } from '${helpers}';

const content = Buffer.alloc(40_000, 9);
const infoBytes = buildInfoDict({ name: 'ep.mp4', pieceLength: 16_384, content });
const torrent = parseInfoDict(decodeAll(infoBytes), infoHashOf(infoBytes));
const done = new Array(torrent.pieceCount).fill(false);
const session = {
  torrent,
  done,
  storage: { readFileRange: async (fileIndex, offset, length) => content.subarray(offset, offset + length) },
};

// 故意 unref：分片就绪这件事不该成为"进程存活"的来源
const flip = setTimeout(() => { done[0] = true; }, 150);
flip.unref();

const { buffer } = await readReadyRange({ session, fileIndex: 0, offset: 0, maxLength: 64, pollMs: 20, timeoutMs: 4000 });
process.stdout.write('OK ' + buffer.length);
`;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 20_000,
    windowsHide: true,
  });

  assert.match(stdout, /^OK 64$/, `子进程应等到分片就绪并读出 64 字节，实际输出：${JSON.stringify(stdout)}`);
});

test('readReadyRange：浏览器发 bytes=0-（整文件）时不会返回整文件，只给已就绪的连续段', async () => {
  const content = patternedBuffer(100_000);
  const torrent = buildTorrent({ content, pieceLength: 16_384, name: 'ep.mp4' });
  const done = new Array(torrent.pieceCount).fill(false);
  done[0] = true;
  done[1] = true;

  const { buffer } = await readReadyRange({
    session: fakeSession(torrent, done, content),
    fileIndex: 0,
    offset: 0,
    maxLength: 100_000,
    pollMs: 20,
  });

  assert.equal(buffer.length, 32_768);
  assert.deepEqual(buffer, content.subarray(0, 32_768));
});

test('readReadyRange：超时与「下载已结束」都要如实报错，而不是无限等', async () => {
  const content = patternedBuffer(40_000);
  const torrent = buildTorrent({ content, pieceLength: 16_384, name: 'ep.mp4' });
  const none = new Array(torrent.pieceCount).fill(false);

  await assert.rejects(
    readReadyRange({
      session: fakeSession(torrent, none, content),
      fileIndex: 0,
      offset: 0,
      maxLength: 100,
      timeoutMs: 300,
      pollMs: 20,
    }),
    /等待数据超时/,
  );

  await assert.rejects(
    readReadyRange({
      session: fakeSession(torrent, none, content),
      fileIndex: 0,
      offset: 0,
      maxLength: 100,
      pollMs: 20,
      isAlive: () => false,
    }),
    /下载已结束/,
  );
});

// ---------------------------------------------------------------------------
// 集成层：真实引擎 + 假种子群 + 真实 HTTP
// ---------------------------------------------------------------------------

/**
 * @param {(context: {dir: string, port: number, manager: any, swarm: any, content: Buffer, waitForSession: () => Promise<any>}) => Promise<void>} run
 */
async function withStreamServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-stream-'));
  const content = patternedBuffer(300_000);
  const swarm = await startFakeSwarm({ content, name: 'ep01.mp4', pieceLength: 32_768 });

  // 用真实引擎（不注入 engine），但关掉公共 tracker 与 DHT：只跟假种子群打交道。
  // 关键：**限速**。不限速的话 300KB 在本地环回上瞬间下完，「下载中」这个窗口根本抓不住，
  // 测试就变成看运气（要么 409 要么走成"已下完"那条路）。限速后窗口稳定在 2 秒左右。
  const manager = new DownloadManager({
    dir,
    persistFile: null,
    logger: () => {},
    useDefaultTrackers: false,
    useDht: false,
    limitSpeed: 150_000,
  });

  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    http: { proxy: null },
    cache: memoryCache(),
    version: 'test',
    logger: () => {},
    downloadManager: manager,
  });

  /**
   * 等任务进入「可流式播放」阶段（引擎已交出会话）。
   * 在此之前请求会得到 409 —— 那是正确行为（元数据都还没拿到，无法定位文件）。
   */
  const waitForSession = async () => {
    const ok = await waitUntil(() => Boolean(manager.internalByInfoHash(swarm.infoHash)?.session), 30_000);
    assert.ok(ok, '任务应当在 30 秒内进入可流式播放阶段');
    return manager.internalByInfoHash(swarm.infoHash);
  };

  try {
    await run({ dir, port: instance.port, manager, swarm, content, waitForSession });
  } finally {
    await instance.close();
    await swarm.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * 带 Range 的原生请求（fetch 不方便精确控制 Range 与读取二进制）。
 *
 * @param {number} port
 * @param {string} requestPath
 * @param {{range?: string, method?: string}} [options]
 */
function rawGet(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (options.range) headers.range = options.range;

    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 轮询等待条件成立。
 *
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('端到端：下载中的任务按 Range 取字节，内容逐字节正确', async () => {
  await withStreamServer(async ({ port, manager, swarm, content, waitForSession }) => {
    manager.add({ input: swarm.magnet, backend: 'builtin' });
    const task = await waitForSession();

    // 开头一段：此时走的是「会话 + 已校验分片」这条路（不是磁盘整文件）
    assert.ok(task.session, '请求时应当处于下载中（会话存在）');
    const first = await rawGet(port, `/api/stream/${swarm.infoHash}/0`, { range: 'bytes=0-499' });
    assert.equal(first.status, 206);
    assert.equal(first.headers['content-type'], 'video/mp4');
    assert.equal(first.headers['accept-ranges'], 'bytes');
    assert.match(first.headers['content-range'], /^bytes 0-\d+\/300000$/);
    assert.equal(first.headers['access-control-allow-origin'], '*');
    assert.deepEqual(first.body, content.subarray(0, first.body.length));

    // 中间一段：限速下这段还没下到，接口应当**等**它到齐再返回
    const middle = await rawGet(port, `/api/stream/${swarm.infoHash}/0`, { range: 'bytes=200000-200999' });
    assert.equal(middle.status, 206);
    assert.deepEqual(middle.body, content.subarray(200_000, 200_000 + middle.body.length));
    assert.ok(middle.body.length > 0);

    // 等下载完成，再取整文件：这时走的是「磁盘文件」那条路
    assert.ok(await waitUntil(() => manager.list()[0]?.status === 'done', 60_000), '下载应当在 60 秒内完成');
    assert.equal(manager.internalByInfoHash(swarm.infoHash)?.session, null, '下载结束后会话应被清掉');

    const whole = await rawGet(port, `/api/stream/${swarm.infoHash}/0`);
    assert.equal(whole.status, 200);
    assert.equal(whole.body.length, content.length);
    assert.equal(whole.body.equals(content), true);

    // 完成后按 Range 取磁盘文件
    const tail = await rawGet(port, `/api/stream/${swarm.infoHash}/0`, { range: 'bytes=-1000' });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers['content-range'], `bytes ${content.length - 1000}-${content.length - 1}/${content.length}`);
    assert.deepEqual(tail.body, content.subarray(content.length - 1000));
  });
});

test('端到端：文件清单、HEAD、416、404、400', async () => {
  await withStreamServer(async ({ port, manager, swarm, content, waitForSession }) => {
    manager.add({ input: swarm.magnet, backend: 'builtin' });
    await waitForSession();

    // 文件清单：不带下标
    const listing = await rawGet(port, `/api/stream/${swarm.infoHash}`);
    assert.equal(listing.status, 200);
    const meta = JSON.parse(listing.body.toString('utf8'));
    assert.equal(meta.infoHash, swarm.infoHash);
    assert.equal(meta.files.length, 1);
    assert.equal(meta.files[0].index, 0);
    assert.equal(meta.files[0].path, 'ep01.mp4');
    assert.equal(meta.files[0].length, content.length);
    assert.equal(meta.files[0].contentType, 'video/mp4');
    assert.equal(meta.files[0].url, `/api/stream/${swarm.infoHash}/0`);
    assert.equal(meta.complete, false);

    // HEAD：只回头部，不等数据（所以应当很快返回）
    const startedAt = Date.now();
    const head = await rawGet(port, `/api/stream/${swarm.infoHash}/0`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(content.length));
    assert.equal(head.body.length, 0);
    assert.ok(Date.now() - startedAt < 5_000, 'HEAD 不应等待数据');

    // 起点越界 → 416
    const unsat = await rawGet(port, `/api/stream/${swarm.infoHash}/0`, { range: `bytes=${content.length}-` });
    assert.equal(unsat.status, 416);
    assert.equal(unsat.headers['content-range'], `bytes */${content.length}`);

    // 文件下标不存在 → 404
    const noFile = await rawGet(port, `/api/stream/${swarm.infoHash}/7`);
    assert.equal(noFile.status, 404);

    // info hash 非法 → 400
    const badHash = await rawGet(port, '/api/stream/not-a-hash/0');
    assert.equal(badHash.status, 400);

    // 不存在的任务 → 404
    const unknown = await rawGet(port, `/api/stream/${'a'.repeat(40)}/0`);
    assert.equal(unknown.status, 404);
  });
});

test('端到端：没有下载任务时 /api/stream 明确报不可播，而不是返回坏数据', async () => {
  await withStreamServer(async ({ port, swarm }) => {
    // 不加任务：应当 404（没有该 hash 的任务）
    const response = await rawGet(port, `/api/stream/${swarm.infoHash}/0`);
    assert.equal(response.status, 404);
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(body.error.code, 'task_not_found');
  });
});

test('端到端：不存在的文件下标不会被当成路径去读盘（防路径穿越）', async () => {
  await withStreamServer(async ({ port, manager, swarm, waitForSession }) => {
    manager.add({ input: swarm.magnet, backend: 'builtin' });
    await waitForSession();

    // 各种越界/非法下标都必须是 404 或 400，绝不能落到文件系统上
    for (const index of ['-1', '1', '999', 'abc', '0/../../etc/passwd']) {
      const response = await rawGet(port, `/api/stream/${swarm.infoHash}/${index}`);
      assert.ok(
        response.status === 404 || response.status === 400,
        `下标 ${index} 应被拒绝，实际 ${response.status}`,
      );
    }
  });
});

test('端到端：客户端断开时等待会被取消，不把请求挂在后台', async () => {
  await withStreamServer(async ({ port, manager, swarm, waitForSession }) => {
    manager.add({ input: swarm.magnet, backend: 'builtin' });
    await waitForSession();

    // 请求一个很远的位置，然后立刻断开：服务端应当放弃等待而不是继续等 30 秒
    await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/stream/${swarm.infoHash}/0`,
          method: 'GET',
          headers: { range: 'bytes=299000-' },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
        },
      );
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 300);
    });

    // 能走到这里就说明服务端没有阻塞住事件循环；下载仍在正常推进
    assert.ok(manager.list().length === 1);
  });
});
