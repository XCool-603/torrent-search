/**
 * 种子元数据模型：把 bencode 解出来的 info 字典翻译成"分片 + 文件"的布局。
 *
 * 关键点：
 * - `pieces` 是 20 字节一组的 SHA1 拼接，必须按字节切，不能按字符；
 * - 多文件种子的路径来自种子本身，**可能包含 `../` 之类的穿越路径**，必须清洗（见 storage.mjs）；
 * - 最后一片通常不满，长度要单独算，否则校验和写盘都会错位。
 */

import { toBytes, toUtf8 } from './bencode.mjs';

const BLOCK_SIZE = 16 * 1024;

/**
 * @typedef {object} TorrentFile
 * @property {string} path      相对路径（已清洗，使用 / 分隔）
 * @property {number} length    字节数
 * @property {number} offset    在整条种子数据流中的起始偏移
 */

/**
 * @typedef {object} TorrentInfo
 * @property {string} infoHash
 * @property {string} name
 * @property {number} pieceLength
 * @property {number} pieceCount
 * @property {number} totalSize
 * @property {Buffer[]} pieceHashes
 * @property {TorrentFile[]} files
 * @property {boolean} isSingleFile
 * @property {boolean} isPrivate
 */

/**
 * 解析 info 字典。
 *
 * @param {Record<string, any>} info 已解码的 info 字典（字节串为 latin1 字符串）
 * @param {string} infoHash 小写 40 位 hex
 * @returns {TorrentInfo}
 */
export function parseInfoDict(info, infoHash) {
  if (!info || typeof info !== 'object') throw new Error('种子缺少 info 字典');

  const name = sanitizeName(toUtf8(info.name) || 'unnamed');
  const pieceLength = Number(info['piece length']);
  if (!Number.isFinite(pieceLength) || pieceLength <= 0) throw new Error('种子的 piece length 非法');

  const piecesBytes = toBytes(info.pieces ?? '');
  if (piecesBytes.length === 0 || piecesBytes.length % 20 !== 0) {
    throw new Error('种子的 pieces 字段非法（应为 20 字节的整数倍）');
  }

  const pieceHashes = [];
  for (let offset = 0; offset < piecesBytes.length; offset += 20) {
    pieceHashes.push(piecesBytes.subarray(offset, offset + 20));
  }

  /** @type {TorrentFile[]} */
  const files = [];
  let totalSize = 0;
  const isSingleFile = !Array.isArray(info.files);

  if (isSingleFile) {
    const length = Number(info.length);
    if (!Number.isFinite(length) || length < 0) throw new Error('单文件种子的 length 非法');
    files.push({ path: name, length, offset: 0 });
    totalSize = length;
  } else {
    for (const entry of info.files) {
      const length = Number(entry?.length);
      if (!Number.isFinite(length) || length < 0) throw new Error('多文件种子里有非法的 length');
      const parts = Array.isArray(entry.path) ? entry.path.map((part) => toUtf8(part)) : [];
      const relative = sanitizeRelativePath([name, ...parts]);
      files.push({ path: relative, length, offset: totalSize });
      totalSize += length;
    }
    if (files.length === 0) throw new Error('多文件种子没有任何文件');
  }

  const pieceCount = pieceHashes.length;
  const expectedPieces = Math.ceil(totalSize / pieceLength);
  if (pieceCount !== expectedPieces) {
    throw new Error(`种子的分片数与文件大小不匹配（pieces=${pieceCount}，按大小算应为 ${expectedPieces}）`);
  }

  return {
    infoHash,
    name,
    pieceLength,
    pieceCount,
    totalSize,
    pieceHashes,
    files,
    isSingleFile,
    isPrivate: info.private === 1,
  };
}

/**
 * 取某个分片的实际长度（最后一片通常不满）。
 *
 * @param {TorrentInfo} torrent
 * @param {number} index
 * @returns {number}
 */
export function pieceSize(torrent, index) {
  if (index < 0 || index >= torrent.pieceCount) throw new Error(`分片下标越界：${index}`);
  const start = index * torrent.pieceLength;
  return Math.min(torrent.pieceLength, torrent.totalSize - start);
}

/**
 * 把一个分片映射到「文件 + 文件内偏移」的若干段。
 *
 * @param {TorrentInfo} torrent
 * @param {number} index
 * @returns {Array<{fileIndex: number, fileOffset: number, pieceOffset: number, length: number}>}
 */
export function pieceToFileRanges(torrent, index) {
  const size = pieceSize(torrent, index);
  const pieceStart = index * torrent.pieceLength;
  const pieceEnd = pieceStart + size;

  const ranges = [];
  for (let fileIndex = 0; fileIndex < torrent.files.length; fileIndex += 1) {
    const file = torrent.files[fileIndex];
    const fileStart = file.offset;
    const fileEnd = file.offset + file.length;
    if (fileEnd <= pieceStart || fileStart >= pieceEnd) continue;

    const from = Math.max(fileStart, pieceStart);
    const to = Math.min(fileEnd, pieceEnd);
    ranges.push({
      fileIndex,
      fileOffset: from - fileStart,
      pieceOffset: from - pieceStart,
      length: to - from,
    });
  }

  return ranges;
}

/**
 * 文件内的一段字节覆盖哪些分片。
 *
 * 流式播放靠它判断「要播的这段数据到了没有」：只有覆盖该段的全部分片都校验通过，
 * 磁盘上这段字节才是可信的（storage 会预分配文件，看文件大小判断不出数据是否有效）。
 *
 * @param {TorrentInfo} torrent
 * @param {number} fileIndex
 * @param {number} offset 文件内偏移
 * @param {number} length
 * @returns {{first: number, last: number}} 闭区间
 */
export function piecesForFileRange(torrent, fileIndex, offset, length) {
  const file = torrent.files[fileIndex];
  if (!file) throw new Error(`文件下标越界：${fileIndex}`);
  if (!Number.isFinite(offset) || offset < 0) throw new Error(`偏移非法：${offset}`);
  if (!Number.isFinite(length) || length <= 0) throw new Error(`长度非法：${length}`);
  if (offset + length > file.length) {
    throw new Error(`请求范围超出文件：offset=${offset} length=${length} 文件大小=${file.length}`);
  }

  const start = file.offset + offset;
  const end = start + length - 1;
  return {
    first: Math.floor(start / torrent.pieceLength),
    last: Math.floor(end / torrent.pieceLength),
  };
}

/**
 * 分片下载时切块（默认 16 KiB，BEP 3 的常见上限）。
 *
 * @param {TorrentInfo} torrent
 * @param {number} index
 * @param {number} [blockSize]
 * @returns {Array<{offset: number, length: number}>}
 */
export function splitIntoBlocks(torrent, index, blockSize = BLOCK_SIZE) {
  const size = pieceSize(torrent, index);
  const blocks = [];
  for (let offset = 0; offset < size; offset += blockSize) {
    blocks.push({ offset, length: Math.min(blockSize, size - offset) });
  }
  return blocks;
}

/**
 * 清洗单个名字（去掉路径分隔符与控制字符）。
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  const cleaned = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+$/, '_')
    .trim();
  return cleaned === '' ? 'unnamed' : cleaned.slice(0, 200);
}

/**
 * 清洗相对路径：逐段过滤 `.`、`..`、盘符、分隔符，杜绝路径穿越。
 *
 * 这是安全关键点：种子文件里的路径是**别人给的**，绝不能直接拼到磁盘路径上。
 *
 * @param {string[]} parts
 * @returns {string}
 */
export function sanitizeRelativePath(parts) {
  const safe = parts
    // 先剔除危险段（`.` / `..` / 盘符），再清洗——顺序很重要：
    // 若先清洗，`..` 会被替换成 `_`，看起来"安全"了，但语义被悄悄改成了另一个路径。
    .filter((part) => typeof part === 'string' && part !== '' && part !== '.' && part !== '..' && !/^[a-zA-Z]:$/.test(part))
    .map((part) => sanitizeName(part))
    .filter(Boolean);

  if (safe.length === 0) return 'unnamed';
  return safe.join('/');
}

export { BLOCK_SIZE };
