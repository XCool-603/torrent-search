/**
 * 边下边播：把「已经校验落盘」的字节按 HTTP Range 语义取出来。
 *
 * 为什么不能直接读磁盘文件：storage 会**预分配**文件（按种子里的长度 truncate），
 * 所以磁盘上文件大小是满的，但大部分区域还是空洞或写了一半的数据。
 * 唯一可信的判据是引擎的分片位图 `done[]` —— 它只在分片 SHA1 校验通过并写盘后才置位。
 * 因此这里的流程是：算出请求范围覆盖哪些分片 → 等它们就绪 → 再从文件偏移处读。
 *
 * 这个模块不做网络、不做 HTTP 响应，只负责「等 + 读」，便于单独测试。
 */

import { piecesForFileRange, pieceSize } from './torrent.mjs';

/** 轮询分片位图的间隔：太密会白烧 CPU，太疏会让起播变慢 */
const POLL_INTERVAL_MS = 150;

/** 默认等待时长：起播时等首片是正常的，但等太久说明这个种子根本下不动 */
export const DEFAULT_WAIT_MS = 30_000;

/**
 * 单次响应最多返回多少字节（默认 8 MiB）。
 *
 * 浏览器常发 `Range: bytes=0-`，也就是"整个文件"。下载中的文件不能等整段就绪，
 * 也不该把它整个读进内存，所以每次只给"当前已就绪的连续部分"，上限由它兜住。
 */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 解析 HTTP Range 头。
 *
 * 只支持单区间（`bytes=a-b`、`bytes=a-`、`bytes=-n`）。多区间（逗号分隔）返回
 * `unsupported`，调用方应回退成 200 整文件 —— 视频播放器不会发多区间请求，
 * 真发了就整段返回，比返回错误的局部数据安全。
 *
 * @param {string|undefined} header
 * @param {number} size 资源总长度
 * @returns {{start: number, end: number}|{unsatisfiable: true}|{unsupported: true}|null}
 *          null = 没有 Range 头（按整文件处理）
 */
export function parseRange(header, size) {
  if (!header) return null;

  const match = /^bytes=(.+)$/i.exec(String(header).trim());
  if (!match) return { unsupported: true };

  const spec = match[1].trim();
  if (spec.includes(',')) return { unsupported: true };

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { unsupported: true };

  const [, rawStart, rawEnd] = parts;
  if (rawStart === '' && rawEnd === '') return { unsupported: true };

  let start;
  let end;

  if (rawStart === '') {
    // 后缀区间：bytes=-500 表示「最后 500 字节」
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsupported: true };
  if (start > end) return { unsatisfiable: true };
  if (start >= size) return { unsatisfiable: true };

  // 请求超出末尾就截到末尾（RFC 9110 允许）
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 常见媒体扩展名 → Content-Type。
 *
 * 必须给对：浏览器靠它决定能不能直接播（`<video>` 对 application/octet-stream 会拒播），
 * 而 mkv/avi 这类容器浏览器本身就不支持，给对类型至少能让它明确失败而不是黑屏。
 *
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeFor(filePath) {
  const ext = String(filePath).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const table = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    ts: 'video/mp2t',
    m2ts: 'video/mp2t',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    srt: 'application/x-subrip',
    vtt: 'text/vtt',
    ass: 'text/plain',
    ssa: 'text/plain',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return table[ext] ?? 'application/octet-stream';
}

/**
 * 等某个分片就绪。
 *
 * @param {object} params
 * @param {{torrent: any, storage: any, done: boolean[]}} params.session 引擎交出的会话
 * @param {number} params.pieceIndex
 * @param {number} [params.timeoutMs]
 * @param {number} [params.pollMs]
 * @param {() => boolean} [params.isAlive] 会话是否仍有效（下载结束/失败后应立刻放弃等待）
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<number>} 实际等待的毫秒数
 */
export async function waitForPiece(params) {
  const {
    session,
    pieceIndex,
    timeoutMs = DEFAULT_WAIT_MS,
    pollMs = POLL_INTERVAL_MS,
    isAlive,
    signal,
  } = params;

  const startedAt = Date.now();
  let waited = 0;

  for (;;) {
    if (signal?.aborted) throw new Error('客户端已断开');
    if (session.done[pieceIndex]) return Date.now() - startedAt;
    if (isAlive && !isAlive()) {
      // 下载已结束而数据还没到 —— 再等下去也没有意义
      throw new Error('下载已结束，但所需分片尚未就绪');
    }

    if (waited >= timeoutMs) {
      throw new Error(
        `等待数据超时（${Math.round(timeoutMs / 1000)} 秒）：分片 ${pieceIndex} 仍未就绪` +
          `（该种子可能没有可用 peer，或下载进度落后于播放位置）`,
      );
    }

    await delay(pollMs, signal);
    waited += pollMs;
  }
}

/**
 * 从文件偏移处起，连续**已校验**的字节数（上限 maxLength）。
 *
 * 只返回连续区间：中间缺一片就到此为止。这样播放器拿到的一定是可信的连续数据，
 * 而不是中间夹着空洞的文件。
 *
 * @param {{torrent: any, done: boolean[]}} session
 * @param {number} fileIndex
 * @param {number} offset
 * @param {number} maxLength
 * @returns {number}
 */
export function readyLength(session, fileIndex, offset, maxLength) {
  const torrent = session.torrent;
  const file = torrent.files[fileIndex];
  if (!file) throw new Error(`文件下标越界：${fileIndex}`);

  const remaining = Math.min(maxLength, file.length - offset);
  if (remaining <= 0) return 0;

  const start = file.offset + offset;
  const first = Math.floor(start / torrent.pieceLength);
  const last = Math.floor((start + remaining - 1) / torrent.pieceLength);

  let available = 0;
  for (let index = first; index <= last; index += 1) {
    if (!session.done[index]) break;
    // 该分片在文件内覆盖到哪个字节为止
    const pieceStart = index * torrent.pieceLength;
    const pieceEnd = pieceStart + pieceSize(torrent, index);
    const covered = Math.min(pieceEnd, start + remaining) - start;
    available = Math.max(available, Math.min(covered, remaining));
  }

  return Math.max(0, Math.min(available, remaining));
}

/**
 * 取一段「已校验」的连续字节：先等首片就绪，再读当前就绪的连续前缀。
 *
 * 为什么不一次性等完整段：播放器常发 `Range: bytes=0-`（整个文件）。
 * 若等整段就绪再读进内存，几个 GB 的文件会直接把内存撑爆。
 * 这里只返回「现在已经能给的连续部分」，并在 Content-Range 里如实告知实际范围，
 * 播放器会据此继续请求后续 —— 这也是所有渐进式流媒体的做法。
 *
 * @param {object} params
 * @param {{torrent: any, storage: any, done: boolean[]}} params.session
 * @param {number} params.fileIndex
 * @param {number} params.offset 文件内偏移
 * @param {number} params.maxLength 本次最多返回多少字节（内存上限）
 * @param {number} [params.timeoutMs]
 * @param {number} [params.pollMs]
 * @param {() => boolean} [params.isAlive]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{buffer: Buffer, waitedMs: number}>}
 */
export async function readReadyRange(params) {
  const { session, fileIndex, offset, maxLength } = params;
  const { first } = piecesForFileRange(session.torrent, fileIndex, offset, maxLength);

  const waitedMs = await waitForPiece({ ...params, pieceIndex: first });

  const length = readyLength(session, fileIndex, offset, maxLength);
  if (length <= 0) throw new Error('数据尚未就绪');

  const buffer = await session.storage.readFileRange(fileIndex, offset, length);
  return { buffer, waitedMs };
}

/**
 * 可被 abort 打断的延时。
 *
 * **刻意不 unref**：调用方（`waitForPiece` 的轮询、`readReadyRange`）就是在等这段时间，
 * 若 unref，当事件循环里只剩这一个定时器时进程会直接退出，等待中的 Promise 永远不 resolve。
 * Node 20/22 上表现为测试报 `Promise resolution is still pending but the event loop has
 * already resolved`；线上则是一个正在等分片的播放请求被静默丢弃。
 * （限速器、任务管理器都踩过同一族问题。）
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('客户端已断开'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error('客户端已断开'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
