/**
 * 磁盘缓存（零依赖）。
 *
 * 用途：Academic Torrents 没有搜索接口，只提供一份全量 database.xml（约 3 MB），
 * 官方要求「随便请求，一天更新一次」。所以下载一次缓存到磁盘，之后本地检索。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * 默认缓存目录：环境变量 TORRENT_SEARCH_CACHE > 系统用户缓存目录。
 *
 * @returns {string}
 */
export function defaultCacheDir() {
  const fromEnv = process.env.TORRENT_SEARCH_CACHE;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'torrent-search', 'cache');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'torrent-search');
}

export class DiskCache {
  /**
   * @param {{dir?: string}} [options]
   */
  constructor(options = {}) {
    this.dir = options.dir ?? defaultCacheDir();
  }

  /**
   * 缓存文件绝对路径（key 会被哈希，避免路径穿越）。
   *
   * @param {string} key
   * @returns {string}
   */
  filePath(key) {
    const safe = String(key)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^\.+/, '_') // 避免生成隐藏文件（. 开头）
      .slice(0, 80);
    const digest = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 10);
    return path.join(this.dir, `${safe}.${digest}`);
  }

  /**
   * 读取缓存。
   *
   * @param {string} key
   * @param {{maxAgeMs?: number}} [options]
   * @returns {Promise<{body: Buffer, mtimeMs: number, ageMs: number}|null>}
   */
  async get(key, options = {}) {
    const file = this.filePath(key);
    try {
      const stat = await fs.stat(file);
      // ageMs 钳到非负：Windows 上 NTFS 时间戳的精度/取整会让刚写入的文件
      // mtime 比 Date.now() 略大，直接相减会得到 -0.x 这样的负数
      // （Node 22 / windows 的 CI 抓到的真实问题）
      const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
      if (options.maxAgeMs !== undefined && ageMs > options.maxAgeMs) return null;
      const body = await fs.readFile(file);
      return { body, mtimeMs: stat.mtimeMs, ageMs };
    } catch {
      return null;
    }
  }

  /**
   * 写入缓存（先写临时文件再改名，避免读到半个文件）。
   *
   * @param {string} key
   * @param {Buffer|string} body
   * @returns {Promise<string>} 文件路径
   */
  async set(key, body) {
    const file = this.filePath(key);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
    return file;
  }

  /**
   * 读缓存，过期或缺失时调用 fetchFn 重新获取并写入。
   *
   * @template T
   * @param {string} key
   * @param {{maxAgeMs?: number, fetch: () => Promise<Buffer|string>, logger?: (msg: string) => void, transform?: (body: Buffer) => T}} options
   * @returns {Promise<{value: T, cached: boolean}>}
   */
  async getOrFetch(key, options) {
    const { maxAgeMs, fetch: fetchFn, logger = () => {}, transform } = options;

    const cached = await this.get(key, { maxAgeMs });
    if (cached) {
      logger(`命中缓存 ${key}（${Math.round(cached.ageMs / 1000)} 秒前更新）`);
      return { value: transform ? transform(cached.body) : cached.body, cached: true };
    }

    logger(`缓存未命中，下载 ${key}`);
    const fresh = await fetchFn();
    const body = Buffer.isBuffer(fresh) ? fresh : Buffer.from(String(fresh), 'utf8');
    try {
      await this.set(key, body);
    } catch (error) {
      logger(`写入缓存失败（忽略）：${error.message}`);
    }
    return { value: transform ? transform(body) : body, cached: false };
  }
}
