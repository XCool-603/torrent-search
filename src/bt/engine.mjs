/**
 * 最小但真实的 BT 下载引擎（零依赖）。
 *
 * 支持的协议子集：
 *   - Tracker：HTTP(S) announce（BEP 3 / 紧凑 peer 列表 BEP 23）、UDP announce（BEP 15）
 *   - DHT：BEP 5 的 get_peers 迭代查找（tracker 失效/缺失时的回退通路）
 *   - Peer 协议：握手、interested/unchoke、bitfield/have、request/piece（BEP 3）
 *   - 扩展协议：BEP 10 握手 + ut_metadata 元数据交换（BEP 9）——磁力链接必需
 *
 * 明确**不做**的事（以及后果）：
 *   - 不向 DHT 声明资源（announce_peer）、不做 PEX：我们是纯下载方；
 *   - DHT 走 UDP，**无法经过 HTTP 代理**，代理环境下 DHT 会失败——所以 DHT 只是
 *     tracker 的补充，不能当唯一通路；两者都拿不到 peer 时会明确报错而不是静默卡住。
 *   - 不做上传/做种、不监听入站端口：这是"只下载"的客户端（纯 leech）。
 *   - 不做加密传输、uTP：走标准 TCP。
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Peer } from './peer.mjs';
import { announceAll } from './tracker.mjs';
import { dhtGetPeers } from './dht.mjs';
import { SpeedLimiter } from './limiter.mjs';
import { buildPeerFailureHint, buildNoPeersHint, detectTunAdapter } from '../netdiag.mjs';
import { parseInfoDict, splitIntoBlocks, pieceSize } from './torrent.mjs';
import { TorrentStorage } from './storage.mjs';
import { infoHashOf, decode } from './bencode.mjs';

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

/**
 * 生成 peer id（20 字节，前缀是本客户端标识）。
 *
 * @returns {Buffer}
 */
export function generatePeerId() {
  const prefix = Buffer.from('-TS1000-', 'latin1');
  const random = crypto.randomBytes(12);
  return Buffer.concat([prefix, random]);
}

/**
 * 下载一个磁力链接 / info hash。
 *
 * @param {{
 *   infoHash: string,
 *   trackers?: string[],
 *   dir: string,
 *   peerId?: Buffer,
 *   port?: number,
 *   maxPeers?: number,
 *   concurrency?: number,
 *   timeoutMs?: number,
 *   maxBytes?: number,          // 安全阀：下载到该字节数即停止（用于试跑/限流）
 *   limitSpeed?: number,        // 下载限速（字节/秒），0 或不传 = 不限速
 *   proxy?: URL|null,
 *   useDefaultTrackers?: boolean,  // 是否补上知名公共 tracker（默认 true）
 *   useDht?: boolean,              // 是否在 tracker 失败时回退 DHT（默认 true）
 *   logger?: (msg: string) => void,
 *   onProgress?: (progress: any) => void,
 *   onSession?: (session: { torrent: any, storage: any, done: boolean[] }) => void,
 *                               // 元数据就绪、即将开始下载分片时回调一次，交出运行中的
 *                               // 会话（文件表 + 读盘句柄 + 已校验分片位图）。
 *                               // 流式播放靠它只读「已校验」的字节；下载结束时 storage 会关闭，
 *                               // 所以会话只在下载期间有效。
 *   signal?: AbortSignal,
 *   metadataOnly?: boolean,     // 只解析元数据，不下载内容
 * }} options
 */
export async function download(options) {
  const infoHash = String(options.infoHash).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(infoHash)) throw new Error(`info hash 非法：${options.infoHash}`);

  const logger = options.logger ?? (() => {});
  const peerId = options.peerId ?? generatePeerId();
  const port = options.port ?? 6881;
  const maxPeers = options.maxPeers ?? 40;
  const concurrency = options.concurrency ?? 8;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const trackers = normalizeTrackers(options.trackers, options.useDefaultTrackers !== false);
  const signal = options.signal;

  // 限速器：只在实际下载内容时创建（元数据交换不走限速，避免拖慢启动）
  const limiter = options.limitSpeed > 0 ? new SpeedLimiter({ bytesPerSecond: options.limitSpeed, logger }) : null;
  if (limiter) logger(`下载限速：${formatBytes(limiter.rate)}/s`);

  const engine = new EventEmitter();
  const startedAt = Date.now();
  /**
   * 即时速度用「滑动窗口」而不是全程平均：全程平均会把几分钟前慢速阶段
   * 拉进来，导致 UI 上速度越跑越"慢"（实测会从 2 MiB/s 掉到 200 KiB/s 的错觉）。
   */
  const SPEED_WINDOW_MS = 8_000;
  const speedSamples = [];

  const state = {
    infoHash,
    name: null,
    totalBytes: 0,
    bytesDone: 0,
    piecesDone: 0,
    pieceCount: 0,
    peersConnected: 0,
    peersAvailable: 0,
    phase: 'metadata',
    speed: 0,
    trackers,
  };

  const emitProgress = () => {
    if (!options.onProgress) return;

    const now = Date.now();
    speedSamples.push({ at: now, bytes: state.bytesDone });
    while (speedSamples.length > 1 && now - speedSamples[0].at > SPEED_WINDOW_MS) speedSamples.shift();
    const first = speedSamples[0];
    const windowSec = Math.max(0.5, (now - first.at) / 1000);
    state.speed = Math.max(0, Math.round((state.bytesDone - first.bytes) / windowSec));

    options.onProgress({ ...state });
    engine.emit('progress', { ...state });
  };

  try {
    // ---------- 阶段 1：拿到元数据 ----------
    const metadata = await resolveMetadata({
      infoHash,
      trackers,
      peerId,
      port,
      timeoutMs,
      maxPeers,
      proxy: options.proxy ?? null,
      logger,
      signal,
      onProgress: emitProgress,
      state,
      useDht: options.useDht !== false,
    });

    const torrent = parseInfoDict(metadata.info, infoHash);
    state.name = torrent.name;
    state.totalBytes = torrent.totalSize;
    state.pieceCount = torrent.pieceCount;
    state.phase = 'downloading';
    logger(`元数据就绪：${torrent.name}（${torrent.files.length} 个文件，共 ${formatBytes(torrent.totalSize)}，${torrent.pieceCount} 个分片）`);
    emitProgress();

    if (options.metadataOnly) {
      return {
        infoHash,
        name: torrent.name,
        totalBytes: torrent.totalSize,
        files: torrent.files.map((file) => ({ path: file.path, length: file.length })),
        pieceCount: torrent.pieceCount,
        downloadedBytes: 0,
        dir: options.dir,
        completed: false,
        metadataOnly: true,
        tookMs: Date.now() - startedAt,
      };
    }

    // ---------- 阶段 2：下载分片 ----------
    const storage = new TorrentStorage({ torrent, dir: options.dir, logger });
    // 先量已有数据，再 open（open 会做预分配，之后大小就不代表"真实下载进度"了）
    const existingSizes = await storage.fileSizes();
    await storage.open();

    const peerPool = new PeerPool({
      infoHash,
      peerId,
      port,
      trackers,
      proxy: options.proxy ?? null,
      logger,
      maxPeers,
      timeoutMs,
      useDht: options.useDht !== false,
      left: torrent.totalSize,
      limiter,
    });

    peerPool.seed(metadata.peers);
    await peerPool.connectSome(Math.min(maxPeers, Math.max(concurrency * 2, 10)));
    emitProgress();

    const result = await downloadAllPieces({
      torrent,
      storage,
      existingSizes,
      peerPool,
      concurrency,
      timeoutMs,
      maxBytes: options.maxBytes ?? 0,
      signal,
      logger,
      state,
      onProgress: emitProgress,
      onSession: options.onSession,
    });

    await peerPool.close();
    await storage.close();
    limiter?.stop();

    state.phase = 'done';
    emitProgress();

    return {
      infoHash,
      name: torrent.name,
      totalBytes: torrent.totalSize,
      files: torrent.files.map((file) => ({ path: file.path, length: file.length })),
      pieceCount: torrent.pieceCount,
      downloadedBytes: state.bytesDone,
      dir: options.dir,
      completed: result.completed,
      stoppedByLimit: result.stoppedByLimit,
      tookMs: Date.now() - startedAt,
    };
  } catch (error) {
    limiter?.stop();
    state.phase = 'failed';
    emitProgress();
    throw error;
  }
}

/**
 * 只解析磁力链接的元数据（不下载内容）。
 *
 * @param {Parameters<typeof download>[0]} options
 */
export async function fetchMetadataOnly(options) {
  return download({ ...options, metadataOnly: true });
}

/**
 * 向一批 tracker 请求 peer，并汇报每个 tracker 的成败。
 *
 * @param {{trackers: string[], infoHash: string, peerId: Buffer, port: number, timeoutMs: number, proxy: URL|null, logger: Function}} params
 * @returns {Promise<Array<{host: string, port: number}>>}
 */
async function announceTrackers(params) {
  const { trackers, infoHash, peerId, port, timeoutMs, proxy, logger } = params;

  logger(`向 ${trackers.length} 个 tracker 请求 peer…`);
  const { peers, results } = await announceAll({
    trackerUrls: trackers,
    infoHash,
    peerId,
    port,
    left: 16_384, // 元数据阶段还不知道总大小，按惯例填一个小值
    event: 'started',
    timeoutMs,
    proxy,
  });

  const okTrackers = results.filter((result) => result.ok).length;
  logger(`tracker 响应：${okTrackers}/${results.length} 成功，共 ${peers.length} 个 peer`);
  for (const result of results) {
    if (!result.ok) logger(`  ✗ ${result.tracker}：${result.error}`);
  }

  return peers;
}

/**
 * 阶段 1：向 tracker 要 peer（拿不到则回退 DHT），再从 peer 那里拉 info 字典。
 *
 * @param {any} params
 */
async function resolveMetadata(params) {
  const { infoHash, trackers, peerId, port, timeoutMs, maxPeers, proxy, logger, signal, onProgress, state, useDht } = params;

  // trackers 为空时仍可走 DHT（默认会补公共 tracker，所以只有 --no-extra-trackers
  // 且磁力本身无 tracker 时才真的是空列表）
  if (trackers.length === 0) {
    logger('磁力没有自带 tracker，将尝试 DHT…');
  }

  /** @type {Array<{host: string, port: number}>} */
  let peers = trackers.length > 0 ? await announceTrackers({ trackers, infoHash, peerId, port, timeoutMs, maxPeers, proxy, logger, state, onProgress }) : [];

  // 回退：tracker 拿不到 peer 时用 DHT 补一次（DHT 走 UDP，代理环境下会失败，属于尽力而为）
  if (peers.length === 0 && useDht !== false) {
    logger('tracker 没有返回 peer，改用 DHT 查找…');
    try {
      const dhtPeers = await dhtGetPeers(infoHash, {
        timeoutMs: Math.min(Math.max(timeoutMs, 6_000), 8_000),
        maxRounds: 3,
        logger: (message) => logger(`  DHT ${message}`),
      });
      logger(`DHT 拿到 ${dhtPeers.length} 个 peer`);
      peers = [...peers, ...dhtPeers];
    } catch (error) {
      logger(`DHT 查找失败：${error?.message ?? error}`);
    }
  }

  if (peers.length === 0) {
    const hint = buildNoPeersHint(detectTunAdapter());
    throw new Error(`既没从 tracker 拿到 peer，DHT 也没找到（可能该资源无人做种，或网络限制了 P2P/UDP 流量）。\n${hint}`);
  }

  state.peersAvailable = peers.length;
  onProgress();

  // 并发尝试多个 peer，谁先给出合法元数据就用谁
  const candidates = shuffle(peers).slice(0, Math.max(4, Math.min(maxPeers, 24)));
  const errors = [];

  const attempt = async (candidate) => {
    if (signal?.aborted) throw new Error('已取消');
    const peer = new Peer({ host: candidate.host, port: candidate.port, infoHash, peerId, connectTimeoutMs: timeoutMs, logger });

    try {
      await peer.connect();
      state.peersConnected += 1;
      onProgress();
      const metadata = await peer.fetchMetadata({ timeoutMs: Math.max(timeoutMs, 20_000), expectedInfoHash: infoHash });
      peer.destroy();
      logger(`元数据来自 ${candidate.host}:${candidate.port}`);
      return { ...metadata, peers, peer };
    } catch (error) {
      peer.destroy();
      errors.push(`${candidate.host}:${candidate.port} → ${error.message}`);
      throw error;
    }
  };

  try {
    return await promiseAny(candidates.map(attempt));
  } catch {
    const detail = errors.slice(0, 5).join('；');
    // 把失败模式归纳成可执行的建议（例如"代理 TUN 拦截 P2P"），而不是只给一句裸错误
    const hint = buildPeerFailureHint(errors, detectTunAdapter());
    throw new Error(
      `无法从任何 peer 获取元数据（尝试了 ${candidates.length} 个）。前几个失败原因：${detail}` +
        (hint ? `\n${hint}` : ''),
    );
  }
}

/**
 * 阶段 2：把所有分片下完。
 *
 * @param {any} params
 */
async function downloadAllPieces(params) {
  const { torrent, storage, existingSizes, peerPool, concurrency, timeoutMs, maxBytes, signal, logger, state, onProgress, onSession } = params;

  const total = torrent.pieceCount;
  const done = new Array(total).fill(false);
  const inFlight = new Set();
  let nextCursor = 0;
  let completed = false;
  let stoppedByLimit = false;
  let failureStreak = 0;

  // 把「运行中的会话」交给调用方：torrent（文件表与分片长度）、storage（读盘）、
  // done（已校验分片位图）这三样只存在于引擎内部，而流式播放必须拿到它们
  // 才能只把「已就绪」的字节喂给播放器。这里在 worker 启动前调用，
  // 所以整个下载期间该会话都是有效的。
  onSession?.({ torrent, storage, done });

  // 断点续传：对已有数据做**真实的分片哈希校验**。
  // 不能按"文件大小够了就跳过"来粗判——预分配出来的稀疏文件大小也是满的，会被误判成已下完。
  if (existingSizes.some((size) => size > 0)) {
    const verified = await verifyExistingPieces({ torrent, storage, done, state, logger });
    logger(verified > 0 ? `续传：已有 ${verified} 个分片校验通过，将跳过` : '续传：已有数据校验不通过，将重新下载');
    onProgress();
  }

  const takeNext = () => {
    while (nextCursor < total && done[nextCursor]) nextCursor += 1;
    if (nextCursor >= total) return null;
    const index = nextCursor;
    nextCursor += 1;
    inFlight.add(index);
    return index;
  };

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new Error('已取消');
      if (maxBytes > 0 && state.bytesDone >= maxBytes) {
        stoppedByLimit = true;
        return;
      }

      const index = takeNext();
      if (index === null) return;

      // 拿到分片后再检查一次：并发场景下别的 worker 可能已经把这个额度用掉了
      if (maxBytes > 0 && state.bytesDone >= maxBytes) {
        inFlight.delete(index);
        nextCursor = Math.min(nextCursor, index);
        stoppedByLimit = true;
        return;
      }

      try {
        const buffer = await downloadPiece({ torrent, index, peerPool, timeoutMs, logger });
        await storage.writePiece(index, buffer);
        done[index] = true;
        inFlight.delete(index);
        state.piecesDone += 1;
        state.bytesDone += buffer.length;
        failureStreak = 0;
        onProgress();
      } catch (error) {
        inFlight.delete(index);
        // 放回队列：把游标退回到该分片，让别的 peer 再试
        nextCursor = Math.min(nextCursor, index);
        failureStreak += 1;
        logger(`分片 ${index} 失败：${error.message}（连续失败 ${failureStreak}）`);

        if (failureStreak >= 40) {
          const hint = buildPeerFailureHint([error.message], detectTunAdapter());
          throw new Error(
            `连续 ${failureStreak} 次分片失败，已放弃。最后一个错误：${error.message}` + (hint ? `\n${hint}` : ''),
          );
        }
        // 补充新 peer 再试
        if (failureStreak % 5 === 0) await peerPool.connectSome(5);
        await delay(300);
      }
    }
  };

  // 设了 maxBytes 时要收敛并发：否则 8 个 worker 会在任何一个分片完成之前
  // 就把整批分片派发出去，安全阀形同虚设（这个坑是测试发现的）。
  const effectiveConcurrency =
    maxBytes > 0
      ? Math.max(1, Math.min(concurrency, Math.ceil(maxBytes / Math.max(1, torrent.pieceLength))))
      : concurrency;

  const workers = Array.from({ length: Math.max(1, effectiveConcurrency) }, () => worker());

  // 定期重新 announce，补充 peer
  const refreshTimer = setInterval(() => {
    peerPool.connectSome(10).catch(() => {});
  }, 60_000);
  refreshTimer.unref?.();

  try {
    await Promise.all(workers);
    completed = done.every(Boolean);
    // 语义上互斥：真的下完了就不算"被安全阀截断"
    if (completed) stoppedByLimit = false;
  } finally {
    clearInterval(refreshTimer);
  }

  return { completed, stoppedByLimit };
}

/**
 * 校验目标目录里已有的分片（断点续传）。
 *
 * @param {{torrent: any, storage: any, done: boolean[], state: any, logger: Function}} params
 * @returns {Promise<number>} 校验通过的分片数
 */
async function verifyExistingPieces(params) {
  const { torrent, storage, done, state, logger } = params;
  let verified = 0;

  for (let index = 0; index < torrent.pieceCount; index += 1) {
    const size = pieceSize(torrent, index);
    let buffer = null;
    try {
      buffer = await storage.readPiece(index, size);
    } catch (error) {
      logger(`读取已有分片 ${index} 失败：${error.message}`);
      continue;
    }
    if (!buffer) continue;

    const digest = crypto.createHash('sha1').update(buffer).digest();
    if (!digest.equals(torrent.pieceHashes[index])) continue;

    done[index] = true;
    state.piecesDone += 1;
    state.bytesDone += size;
    verified += 1;
  }

  return verified;
}

/**
 * 下载单个分片（含哈希校验）。
 *
 * @param {{torrent: any, index: number, peerPool: any, timeoutMs: number, logger: Function}} params
 * @returns {Promise<Buffer>}
 */
async function downloadPiece(params) {
  const { torrent, index, peerPool, timeoutMs, logger } = params;
  const size = pieceSize(torrent, index);
  const blocks = splitIntoBlocks(torrent, index);

  const peer = await peerPool.acquireForPiece(index, timeoutMs);
  const buffer = Buffer.alloc(size);

  try {
    for (const block of blocks) {
      const data = await peer.requestBlock(index, block.offset, block.length, Math.max(timeoutMs, 20_000));
      if (data.length !== block.length) {
        throw new Error(`块长度不符：期望 ${block.length}，收到 ${data.length}`);
      }
      data.copy(buffer, block.offset);
    }
  } catch (error) {
    peerPool.release(peer, { broken: true });
    throw error;
  }

  const actual = crypto.createHash('sha1').update(buffer).digest();
  if (!actual.equals(torrent.pieceHashes[index])) {
    peerPool.release(peer, { broken: true });
    throw new Error('分片 SHA1 校验失败（数据损坏或对端作恶）');
  }

  peerPool.release(peer, { broken: false });
  return buffer;
}

/**
 * Peer 连接池：负责连接、就绪判定与按分片分配。
 */
class PeerPool {
  /**
   * @param {{infoHash: string, peerId: Buffer, port: number, trackers: string[], proxy: URL|null, logger: Function, maxPeers: number, timeoutMs: number}} options
   */
  constructor(options) {
    this.options = options;
    this.logger = options.logger;
    this.peers = [];
    this.candidates = [];
    this.seen = new Set();
    this.busy = new Set();
    this.closed = false;
    /** 一轮下载里是否已经补过 DHT（避免反复 UDP 迭代查找） */
    this.dhtTried = false;
    /** 有新 peer 就绪时唤醒等待者 */
    this.waiters = [];
  }

  /**
   * 记录从 tracker 拿到的候选地址。
   *
   * @param {Array<{host: string, port: number}>} peers
   */
  seed(peers) {
    for (const peer of peers) {
      const key = `${peer.host}:${peer.port}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.candidates.push(peer);
    }
  }

  /**
   * 建立若干条连接（未达上限时）。
   *
   * @param {number} count
   */
  async connectSome(count) {
    if (this.closed) return;

    const slots = Math.min(count, this.options.maxPeers - this.peers.length);
    if (slots <= 0) return;

    const batch = this.candidates.splice(0, slots);
    if (batch.length === 0) {
      // 候选用完了，再问一次 tracker；还拿不到就补一次 DHT
      try {
        const { peers } = await announceAll({
          trackerUrls: this.options.trackers,
          infoHash: this.options.infoHash,
          peerId: this.options.peerId,
          port: this.options.port,
          left: this.options.left ?? 16_384,
          timeoutMs: this.options.timeoutMs,
          proxy: this.options.proxy,
        });
        this.seed(peers);

        if (peers.length === 0 && this.options.useDht !== false && !this.dhtTried) {
          // 一轮下载只补一次：DHT 是 UDP 迭代查找，反复探测会明显拖慢速度
          this.dhtTried = true;
          const dhtPeers = await dhtGetPeers(this.options.infoHash, {
            timeoutMs: Math.min(Math.max(this.options.timeoutMs, 6_000), 8_000),
            maxRounds: 3,
            logger: this.logger,
          });
          this.logger(`DHT 补充到 ${dhtPeers.length} 个 peer`);
          this.seed(dhtPeers);
        }
      } catch {
        /* 忽略，交给上层重试 */
      }
      const retry = this.candidates.splice(0, slots);
      if (retry.length === 0) return;
      await Promise.all(retry.map((candidate) => this.tryConnect(candidate)));
      return;
    }

    await Promise.all(batch.map((candidate) => this.tryConnect(candidate)));
  }

  /**
   * @param {{host: string, port: number}} candidate
   */
  async tryConnect(candidate) {
    if (this.closed) return;
    const { infoHash, peerId, timeoutMs, limiter } = this.options;
    const peer = new Peer({
      host: candidate.host,
      port: candidate.port,
      infoHash,
      peerId,
      connectTimeoutMs: Math.min(timeoutMs, 8000),
      limiter,
      logger: this.logger,
    });

    try {
      await peer.connect();
    } catch {
      peer.destroy();
      return;
    }

    peer.on('close', () => {
      this.peers = this.peers.filter((entry) => entry !== peer);
      this.busy.delete(peer);
      this.wake();
    });
    peer.on('error', () => {
      this.peers = this.peers.filter((entry) => entry !== peer);
      this.busy.delete(peer);
      this.wake();
    });

    this.peers.push(peer);
    this.logger(`已连接 peer ${peer.key}（当前 ${this.peers.length} 条）`);
    peer.sendInterested();
    this.wake();
  }

  /**
   * 取一个空闲且拥有该分片的 peer；没有就等（并顺手多连几个）。
   *
   * @param {number} index
   * @param {number} timeoutMs
   * @returns {Promise<Peer>}
   */
  async acquireForPiece(index, timeoutMs) {
    const deadline = Date.now() + Math.max(timeoutMs, 15_000);

    for (;;) {
      if (this.closed) throw new Error('连接池已关闭');

      const peer = this.peers.find((entry) => !this.busy.has(entry) && !entry.choked && entry.hasPiece(index));
      if (peer) {
        this.busy.add(peer);
        return peer;
      }

      if (Date.now() > deadline) {
        // 超时前最后再补一批连接
        if (this.peers.length === 0) await this.connectSome(10);
        const retry = this.peers.find((entry) => !this.busy.has(entry) && entry.hasPiece(index));
        if (retry && !retry.choked) {
          this.busy.add(retry);
          return retry;
        }
        throw new Error(`没有可用的 peer 来下载分片 ${index}（已连接 ${this.peers.length} 条）`);
      }

      if (this.peers.filter((entry) => !this.busy.has(entry)).length === 0) {
        await this.connectSome(5);
      }

      // 轮询间隔要短：release/wake 会即时唤醒，这里只是兜底。
      // 之前是 500ms——单 peer 多 worker 时每个分片都白等一拍（实测 8 分片=4.1 秒，裸传输只要 2ms），
      // 改成 25ms 后吞吐由真实传输时间决定。
      await this.wait(25);
    }
  }

  /**
   * 归还 peer。
   *
   * @param {Peer} peer
   * @param {{broken: boolean}} options
   */
  release(peer, options) {
    this.busy.delete(peer);
    if (options?.broken) {
      this.peers = this.peers.filter((entry) => entry !== peer);
      peer.destroy();
    }
    this.wake();
  }

  wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== resolve);
        resolve();
      }, ms);
      timer.unref?.();
      this.waiters.push(resolve);
    });
  }

  wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  async close() {
    this.closed = true;
    this.wake();
    for (const peer of this.peers) peer.destroy();
    this.peers = [];
  }
}

/**
 * 归一化 tracker 列表。
 *
 * 默认会补上一批知名公共 tracker：磁力链接里自带的 tracker 经常只剩一两个能用的，
 * 补默认值能显著提高找到 peer 的概率（这也是主流客户端的常见做法）。
 * 代价是会把这个 info hash 暴露给这些公共 tracker——在意隐私时用 `useDefaultTrackers: false` 关掉。
 *
 * @param {string[]|undefined} trackers
 * @param {boolean} [useDefaultTrackers]
 * @returns {string[]}
 */
export function normalizeTrackers(trackers, useDefaultTrackers = true) {
  const list = [...(trackers ?? []), ...(useDefaultTrackers ? DEFAULT_TRACKERS : [])]
    .map((tracker) => String(tracker).trim())
    .filter((tracker) => /^(https?|udp):\/\//i.test(tracker));

  return [...new Set(list)];
}

/**
 * 类似 Promise.any，但把所有失败原因收集起来（Node 的 AggregateError 只给 message）。
 *
 * @template T
 * @param {Array<Promise<T>>} promises
 * @returns {Promise<T>}
 */
function promiseAny(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    if (pending === 0) {
      reject(new Error('没有可尝试的对象'));
      return;
    }
    for (const promise of promises) {
      promise.then(resolve, () => {
        pending -= 1;
        if (pending === 0) reject(new Error('全部尝试都失败了'));
      });
    }
  });
}

function shuffle(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 ? Math.round(value) : value.toFixed(2)} ${units[index]}`;
}

export { DEFAULT_TRACKERS, decode, infoHashOf };
