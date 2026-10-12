/**
 * 边下边播（`/api/stream`）的确定性集成用例。
 *
 * 这两个用例原先在 test/stream.test.mjs 里，靠「真实引擎 + 限速造窗口 + 墙钟定时器」
 * 去撞竞态，在 Windows runner 上时序不稳，只能整条 `skip`。这里改成由
 * 「显式信号 + 可控假会话」驱动，不再依赖墙钟时序：
 *   - 仍走真实 HTTP 服务、真实 Range 解析、真实响应头与状态码；
 *   - 只把「引擎什么时候交出会话 / 什么时候清掉会话 / 磁盘文件什么时候完整」
 *     换成由测试显式触发的假引擎，于是竞态窗口由测试自己决定，而不是靠限速去撞。
 *
 * 运行方式：
 *   node --test --test-timeout=60000 test/stream-deterministic.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 本文件放在 test/ 目录下，ROOT_DIR 指向仓库根。
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoUrl = (relative) => pathToFileURL(path.join(ROOT_DIR, relative)).href;

const { startServer } = await import(repoUrl('src/server.mjs'));
const { DownloadManager } = await import(repoUrl('src/download/manager.mjs'));
const { parseInfoDict } = await import(repoUrl('src/bt/torrent.mjs'));
const { decodeAll, infoHashOf } = await import(repoUrl('src/bt/bencode.mjs'));
const { memoryCache } = await import(repoUrl('test/helpers.mjs'));
const { buildInfoDict } = await import(repoUrl('test/helpers/fake-swarm.mjs'));

/** 可预测内容：第 i 个字节 = i % 251（与仓库版 stream.test.mjs 一致） */
function patternedBuffer(length) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buffer[i] = i % 251;
  return buffer;
}

/** 走真实 parseInfoDict 造种子模型（不是手搓对象） */
function buildTorrent({ content, pieceLength, name }) {
  const infoBytes = buildInfoDict({ name, pieceLength, content });
  return parseInfoDict(decodeAll(infoBytes), infoHashOf(infoBytes));
}

/**
 * 可控假引擎：会话在 `waitForSession` 之后**一直存在**，直到测试显式调用
 * `complete()` 才写完整文件并 resolve —— 于是「等待分片期间下载刚好完成」
 * 这个竞态由测试自己触发，而不是靠限速去撞。
 *
 * 会话形状与真实引擎（src/bt/engine.mjs 的 `onSession?.({ torrent, storage, done })`）一致。
 *
 * @param {any} torrent
 * @param {Buffer} content
 */
function createControllableEngine(torrent, content) {
  const done = new Array(torrent.pieceCount).fill(false);
  let readCount = 0;
  let poisonedReads = 0;
  let release;
  const settled = new Promise((resolve) => {
    release = resolve;
  });

  const session = {
    torrent,
    done,
    storage: {
      async readFileRange(_fileIndex, offset, length) {
        readCount += 1;
        // 刻意给「毒数据」：若服务端走了会话这条路，响应体必然与磁盘内容不符，测试立刻失败
        poisonedReads += 1;
        return Buffer.alloc(Math.max(0, length), 0xee);
      },
    },
  };

  const engine = async (options) => {
    // 与真实引擎一致：先报 downloading（否则 manager 的任务状态停在 metadata）
    options.onProgress?.({
      phase: 'downloading',
      name: torrent.name,
      totalBytes: torrent.totalSize,
      bytesDone: 0,
      piecesDone: 0,
      pieceCount: torrent.pieceCount,
      speed: 0,
      peersConnected: 1,
      peersAvailable: 1,
    });
    options.onSession?.(session);

    await settled; // 只有测试显式 complete() / abort 才继续
    if (options.signal?.aborted) throw new Error('已取消');

    return {
      infoHash: options.infoHash,
      name: torrent.name,
      totalBytes: torrent.totalSize,
      files: torrent.files.map((file) => ({ path: file.path, length: file.length })),
      pieceCount: torrent.pieceCount,
      downloadedBytes: content.length,
      completed: true,
      stoppedByLimit: false,
      tookMs: 0,
    };
  };

  engine.session = session;
  /** 统计「服务端是否真的读了会话里的数据」——用于证明等待被放弃/被改走磁盘 */
  engine.stats = () => ({ readCount, poisonedReads });
  /**
   * 模拟「下载完成」：**先把完整文件落盘**，再结束引擎（会话随后被 manager 清掉）。
   *
   * 顺序为什么必须是「先落盘、后清会话」：
   *   - 服务端一旦发现 `task.session === null`，就直接按「已下完」分支读磁盘
   *     （`serveFromDisk()` 一次不成就是 404，**没有重试**）。所以文件必须先存在。
   *   - 文件先落盘并不会让服务端提前读到会话数据：等待循环的判据是 `session.done[]`，
   *     而这里刻意**不置位** done —— 于是「文件已完整」永远先于「会话被清掉」被观察到，
   *     服务端只可能走磁盘这条路。测试最后一并断言会话 storage 一次都没被读。
   *
   * @param {string} dir 下载目录
   */
  engine.complete = async (dir) => {
    await fs.writeFile(path.join(dir, torrent.name), content);
    release();
    await settled;
  };
  /** 模拟取消：只结束引擎，不落盘 */
  engine.abort = () => release();
  return engine;
}

/**
 * 等 manager 的收尾真的跑完（`task.session` 已清、状态已落定）。
 *
 * 为什么要这一步、又为什么它是确定性的：manager 是在 `await engine()` 之后才清会话的，
 * 而「引擎 promise resolve」与「manager 那条续体」是两个微任务。实测顺序是
 * 引擎续体 → 测试续体 → manager 续体（本机 Node 实测），
 * 所以紧跟 `await engine.complete()` 去看 `task.session` 会看到它还没被清。
 * `setImmediate` 一定排在当前这一轮微任务之后，因此「await 一个 setImmediate」
 * 就等价于「等所有已排队的微任务跑完」——这是事件循环的确定语义，不是等时间。
 *
 * @param {any} task
 */
async function settleManager(task) {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return task;
}

/**
 * 起一个「真实 HTTP 服务 + 可控假会话」的测试服务。
 *
 * 与仓库版 withStreamServer 的区别：引擎换可控假引擎（会话/落盘时机由测试决定），
 * HTTP 服务、Range 解析、响应头、状态码全部是真的。
 */
async function withControllableStreamServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-stream-det-'));
  const content = patternedBuffer(300_000);
  const torrent = buildTorrent({ content, pieceLength: 32_768, name: 'ep01.mp4' });
  const engine = createControllableEngine(torrent, content);
  engine.dir = dir;

  const manager = new DownloadManager({
    dir,
    persistFile: null,
    logger: () => {},
    engine,
  });

  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    http: { proxy: null },
    cache: memoryCache(),
    version: 'test',
    logger: () => {},
    downloadManager: manager,
    // 等待上限刻意放大：下面每个用例都靠显式信号收敛，不该等到超时
    streamWaitMs: 30_000,
  });

  /** 等引擎交出会话（显式信号，不是等时间） */
  const waitForSession = async () => {
    const ok = await waitUntil(() => Boolean(manager.internalByInfoHash(torrent.infoHash)?.session), 10_000);
    assert.ok(ok, '引擎应当在 10 秒内交出会话');
    return manager.internalByInfoHash(torrent.infoHash);
  };

  const infoHash = torrent.infoHash;

  try {
    await run({ dir, port: instance.port, manager, engine, content, infoHash, waitForSession, settleManager });
  } finally {
    engine.abort(); // 保证引擎 promise 一定 settle，不留悬挂的等待
    await instance.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 带 Range 的原生请求 */
function rawGet(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (options.range) headers.range = options.range;

    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 轮询等待条件成立（只用于「等显式信号」，不作为被测行为的判据） */
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 用例 1（原 stream.test.mjs:410 的 skip 用例）
// ---------------------------------------------------------------------------

test('端到端：等待分片期间下载刚好完成时，改从磁盘服务而不是 503', async () => {
  // 竞态回归：请求文件末尾（此刻该分片还没就绪），等待期间下载完成、会话被清掉，
  // isAlive 立刻为假。此时文件已经完整，必须改从磁盘服务 —— 早期直接返回 503。
  //
  // 确定性来自哪里：会话什么时候消失、磁盘文件什么时候完整，全部由本测试按顺序显式决定：
  //   1. 请求发出前会话必然存在（waitForSession 已返回），且末片必然未就绪
  //      → 服务端必然进入等待；
  //   2. complete() 结束引擎，并等到 manager 的收尾跑完（engine.done）→ 会话必然已清掉；
  //   3. 测试再把完整文件写到磁盘（此时会话已失效，服务端只可能从磁盘拿数据）。
  // 全程没有「谁先谁后靠运气」的窗口。
  await withControllableStreamServer(async ({ dir, port, manager, engine, content, infoHash, waitForSession, settleManager }) => {
    manager.add({ input: `magnet:?xt=urn:btih:${infoHash}&dn=ep01.mp4`, backend: 'builtin' });
    await waitForSession();

    const task = manager.internalByInfoHash(infoHash);
    assert.ok(task.session, '请求发出时应当处于下载中（会话存在）');
    assert.equal(engine.session.done[engine.session.done.length - 1], false, '末片此刻不应就绪');

    const pending = rawGet(port, `/api/stream/${infoHash}/0`, {
      range: `bytes=${content.length - 1000}-`,
    });

    // 显式信号：完整文件落盘 → 结束引擎 → manager 清掉会话
    await engine.complete(dir);
    await settleManager(task);

    const tail = await pending;
    assert.equal(task.session, null, '下载结束后会话应当已被清掉');
    assert.equal(task.status, 'done');
    assert.equal(tail.status, 206, '下载完成后应改从磁盘服务，而不是 503');
    assert.deepEqual(tail.body, content.subarray(content.length - 1000));

    // 反向证据：会话里的 storage 一次都没被读（读到的会是 0xEE 毒数据）
    assert.deepEqual(engine.stats(), { readCount: 0, poisonedReads: 0 }, '不应当从已失效的会话读数据');
  });
});

// ---------------------------------------------------------------------------
// 用例 2（原 stream.test.mjs:497 的 skip 用例）
// ---------------------------------------------------------------------------

test('端到端：客户端断开时等待会被取消，不把请求挂在后台', async () => {
  // 请求一个尚未就绪的位置，然后断开：服务端应当放弃这次等待，而不是继续等满 streamWaitMs。
  //
  // 怎么做到「不靠墙钟也能判定」：
  //   1. 请求发出前会话必然存在、末片必然未就绪（waitForSession 已返回）；
  //   2. 让请求先到达服务端、处理器进入等待（见下面 destroyDelayMs 的说明）；
  //   3. 断开（req.destroy()），并让出一轮事件循环：本机环回上的 FIN 在这一轮内被服务端处理，
  //      res 的 'close' → controller.abort() 由此触发。这是事件循环的确定顺序；
  //   4. **让末片就绪**（关键判别信号）：
  //        - 等待已被放弃 → 循环早已退出，谁也不会再读，storage 计数保持 0；
  //        - 等待没被取消 → 下一轮轮询看到末片就绪，去读会话数据（毒数据 0xEE）→ 用例立刻红。
  //      这一步是变异测试逼出来的：只断言「请求很快结束」不足以证明取消生效
  //      （把 res.on('close') 改成空函数，用例照样能过）。实测把该变异打进副本后，
  //      服务端确实在断开后读走了会话数据 —— 用例因此会红。
  //   5. 顺带断言任务与会话都没被牵连（取消的是这次等待，不是这个任务）。
  //
  // destroyDelayMs 的作用只是「等请求抵达服务端」，不是对结果的判断：
  // 若它没等到（处理器还没进等待），服务端不会去读会话数据，用例照样会红 —— 不会假绿。
  const destroyDelayMs = 250;

  await withControllableStreamServer(async ({ port, manager, engine, content, infoHash, waitForSession }) => {
    manager.add({ input: `magnet:?xt=urn:btih:${infoHash}&dn=ep01.mp4`, backend: 'builtin' });
    await waitForSession();

    const task = manager.internalByInfoHash(infoHash);
    assert.ok(task.session, '请求发出时应当处于下载中（会话存在）');
    assert.equal(engine.session.done[engine.session.done.length - 1], false, '末片此刻不应就绪');

    let destroyAt = 0;
    const settled = await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/stream/${infoHash}/0`,
          method: 'GET',
          headers: { range: `bytes=${content.length - 1000}-` },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ at: Date.now(), status: res.statusCode, headers: res.headers }));
        },
      );
      req.on('error', (error) => resolve({ at: Date.now(), status: null, error: error.code }));
      req.end();
      // 断开：服务端 res 的 'close' 应当就此触发等待取消
      setTimeout(() => {
        destroyAt = Date.now();
        req.destroy();
      }, destroyDelayMs);
    });

    // 让出一轮：确保服务端已经处理了这次断开（close → abort）
    await new Promise((resolve) => setImmediate(resolve));

    // 判别信号：现在让末片就绪。
    // 若等待已被取消 → 循环早已退出，谁也不会再读，storage 计数保持 0；
    // 若等待没被取消 → 下一轮轮询（≤150ms）会看到末片就绪，去读会话数据（毒数据 0xEE）→ 用例红。
    // 所以这里等一个「必然超过一次轮询间隔」的窗口，再判定 —— 这不是对结果的猜测，
    // 而是给「如果它还在等，就一定会读」留出确定的时间上限（变异测试确认该窗口抓得住）。
    engine.session.done[engine.session.done.length - 1] = true;
    await waitUntil(() => engine.stats().readCount > 0, 1_000);
    await settleManager(task);

    assert.deepEqual(
      engine.stats(),
      { readCount: 0, poisonedReads: 0 },
      '断开后等待应当已退出：末片就绪也不该再去读会话数据',
    );

    // 断开后不该是「服务端自己攒出来的应答」：
    //   - 取消生效 → 客户端是被自己 destroy 掉的一方，拿到的是连接级错误（没有状态码）；
    //   - 取消没生效 → 服务端会继续等（等到分片就绪或超时）再答，客户端会拿到 206/503。
    // 所以「status 必须为 null」是这次断开的直接证据；服务端只要答出来就说明等待没被取消。
    assert.equal(
      settled.status,
      null,
      `断开后不该由服务端发出应答（实际 status=${settled.status}）`,
    );
    assert.ok(
      settled.at - destroyAt < 3_000,
      `断开后服务端应当立刻结束等待（实测 ${settled.at - destroyAt}ms，streamWaitMs=30000）`,
    );

    // 等待被取消 ≠ 任务被取消：会话仍在，下载仍在推进
    assert.equal(manager.list().length, 1);
    assert.ok(task.session, '客户端断开只该取消这一次等待，不该清掉会话');
    assert.equal(task.status, 'downloading');
  });
});
