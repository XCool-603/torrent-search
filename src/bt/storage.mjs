/**
 * 落盘：把校验通过的分片写到正确的文件偏移上。
 *
 * 安全要点：多文件种子的路径来自种子本身，必须逐段清洗并校验最终路径仍在目标目录内
 * （`sanitizeRelativePath` + 这里的 `assertInside`），否则一个恶意种子就能写到系统目录。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pieceToFileRanges } from './torrent.mjs';

export class TorrentStorage {
  /**
   * @param {{torrent: import('./torrent.mjs').TorrentInfo, dir: string, logger?: (msg: string) => void}} options
   */
  constructor(options) {
    this.torrent = options.torrent;
    this.dir = path.resolve(options.dir);
    this.logger = options.logger ?? (() => {});

    /** @type {Map<number, fs.FileHandle>} */
    this.handles = new Map();
    this.opened = false;
  }

  /**
   * 目标目录下每条文件的实际路径（单文件种子就是 <dir>/<name>）。
   *
   * @returns {string[]}
   */
  filePaths() {
    return this.torrent.files.map((file) => {
      const target = path.resolve(this.dir, file.path);
      assertInside(this.dir, target);
      return target;
    });
  }

  /**
   * 创建目录、打开句柄。
   *
   * 注意两点（都是实测踩出来的）：
   * 1. Windows 上对 `'a+'` 句柄调用 `ftruncate` 会报 EPERM，所以用 `'r+'`（已存在）或 `'w+'`（新建）；
   * 2. 预分配只是优化，失败不能影响正确性——按偏移写入本身就会自动扩展文件。
   */
  async open() {
    if (this.opened) return;
    const paths = this.filePaths();

    for (let index = 0; index < paths.length; index += 1) {
      const target = paths[index];
      const file = this.torrent.files[index];
      await fs.mkdir(path.dirname(target), { recursive: true });

      let handle;
      try {
        handle = await fs.open(target, 'r+');
      } catch {
        handle = await fs.open(target, 'w+');
      }

      const stat = await handle.stat();
      if (stat.size < file.length) {
        try {
          await handle.truncate(file.length);
        } catch {
          // 预分配失败不影响正确性：后面按偏移写入会自动扩展
        }
      }
      this.handles.set(index, handle);
    }

    this.opened = true;
    this.logger(`下载目录：${this.dir}`);
  }

  /**
   * 各文件当前已有的字节数（必须在 open() 之前调用：open 会做预分配，之后大小就不准了）。
   *
   * @returns {Promise<number[]>}
   */
  async fileSizes() {
    const sizes = [];
    for (const [index, target] of this.filePaths().entries()) {
      try {
        const stat = await fs.stat(target);
        sizes.push(Math.min(stat.size, this.torrent.files[index].length));
      } catch {
        sizes.push(0);
      }
    }
    return sizes;
  }

  /**
   * 读取一个分片的内容（用于断点续传时校验已有数据）。
   *
   * @param {number} index
   * @param {number} size
   * @returns {Promise<Buffer|null>} 数据不完整时返回 null
   */
  async readPiece(index, size) {
    const ranges = pieceToFileRanges(this.torrent, index);
    const buffer = Buffer.alloc(size);

    for (const range of ranges) {
      const handle = this.handles.get(range.fileIndex);
      if (!handle) return null;

      const stat = await handle.stat();
      if (stat.size < range.fileOffset + range.length) return null;

      const { bytesRead } = await handle.read(buffer, range.pieceOffset, range.length, range.fileOffset);
      if (bytesRead !== range.length) return null;
    }

    return buffer;
  }

  /**
   * 写入一个分片（调用方必须已经校验过 SHA1）。
   *
   * @param {number} index
   * @param {Buffer} buffer
   */
  async writePiece(index, buffer) {
    const ranges = pieceToFileRanges(this.torrent, index);
    let written = 0;

    for (const range of ranges) {
      const handle = this.handles.get(range.fileIndex);
      if (!handle) throw new Error(`文件句柄未打开：${range.fileIndex}`);
      await handle.write(buffer, range.pieceOffset, range.length, range.fileOffset);
      written += range.length;
    }

    if (written !== buffer.length) {
      throw new Error(`分片 ${index} 写盘长度不一致：期望 ${buffer.length}，实际 ${written}`);
    }
  }

  /**
   * 读取文件内的一段字节（流式播放用）。
   *
   * **不做校验**：调用方必须先用 piecesForFileRange + 分片位图确认覆盖这段字节的
   * 分片都已校验通过，否则读到的是预分配出来的空洞或写了一半的数据。
   * 一次 read 可能短读，所以这里循环补满。
   *
   * @param {number} fileIndex
   * @param {number} offset 文件内偏移
   * @param {number} length
   * @returns {Promise<Buffer>} 实际读到的字节（文件比预期短时可能不足 length）
   */
  async readFileRange(fileIndex, offset, length) {
    const handle = this.handles.get(fileIndex);
    if (!handle) throw new Error(`文件句柄未打开：${fileIndex}`);

    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }

    return filled === length ? buffer : buffer.subarray(0, filled);
  }

  /**
   * 关闭所有句柄。
   */
  async close() {
    for (const handle of this.handles.values()) {
      await handle.close().catch(() => {});
    }
    this.handles.clear();
    this.opened = false;
  }
}

/**
 * 断言 target 位于 dir 之内（防路径穿越）。
 *
 * @param {string} dir
 * @param {string} target
 */
export function assertInside(dir, target) {
  const base = path.resolve(dir);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`种子里包含越界路径，已拒绝写入：${target}`);
  }
}
