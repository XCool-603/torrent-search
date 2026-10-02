/**
 * 测试公共工具：读取夹具、桩 HTTP 客户端、内存缓存。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.resolve(fileURLToPath(new URL('./fixtures/', import.meta.url)));

/**
 * 读取夹具文本。
 *
 * @param {string} name
 * @returns {string}
 */
export function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/**
 * 构造桩 HTTP 客户端：按 URL 匹配返回夹具内容，绝不联网。
 *
 * @param {Array<[string|RegExp, string]>} routes  [匹配规则, 响应文本]
 * @returns {any}
 */
export function stubHttp(routes) {
  const calls = [];

  const resolve = (url) => {
    for (const [matcher, body] of routes) {
      if (typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url)) return body;
    }
    return null;
  };

  return {
    calls,
    proxy: null,
    async getText(url) {
      calls.push(url);
      const body = resolve(url);
      if (body === null) throw new Error(`桩未定义该 URL：${url}`);
      return body;
    },
    async getJson(url) {
      return JSON.parse(await this.getText(url));
    },
    async request(url) {
      return { status: 200, headers: {}, body: Buffer.from(await this.getText(url), 'utf8'), url };
    },
  };
}

/**
 * 内存缓存（与 DiskCache 接口一致），避免测试写磁盘。
 *
 * @param {{body?: string}} [options]
 */
export function memoryCache(options = {}) {
  const store = new Map();
  if (options.body !== undefined) store.set('academictorrents-database.xml', Buffer.from(options.body, 'utf8'));

  return {
    async get(key) {
      const body = store.get(key);
      return body ? { body, mtimeMs: Date.now(), ageMs: 0 } : null;
    },
    async set(key, body) {
      store.set(key, Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
      return key;
    },
    async getOrFetch(key, { fetch: fetchFn, transform }) {
      let body = store.get(key);
      let cached = true;
      if (!body) {
        cached = false;
        const fresh = await fetchFn();
        body = Buffer.isBuffer(fresh) ? fresh : Buffer.from(String(fresh), 'utf8');
        store.set(key, body);
      }
      return { value: transform ? transform(body) : body, cached };
    },
    _store: store,
  };
}

/**
 * 造一个假的搜索结果（不经过 makeResult，字段直接给全）。
 *
 * @param {Partial<import('../src/models.mjs').TorrentResult>} overrides
 */
export function fakeResult(overrides = {}) {
  const infoHash = overrides.infoHash ?? null;
  return {
    id: `${overrides.source ?? 'fake'}:${infoHash ?? 'nohash'}`,
    source: 'fake',
    title: 'Fake Result',
    infoHash,
    magnet: infoHash ? `magnet:?xt=urn:btih:${infoHash}` : null,
    size: 1024,
    sizeText: '1.00 KiB',
    seeders: 1,
    leechers: 0,
    category: null,
    publishedAt: null,
    detailsUrl: null,
    torrentUrl: null,
    ...overrides,
  };
}

/**
 * 造一个假数据源。
 *
 * @param {string} id
 * @param {any[] | ((query: string) => any[])} results
 * @param {{delayMs?: number, error?: Error}} [options]
 */
export function fakeSource(id, results, options = {}) {
  return {
    id,
    name: `Fake ${id}`,
    description: '测试用假源',
    homepage: 'https://example.invalid',
    kinds: ['test'],
    defaultEnabled: true,
    async search(query) {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.error) throw options.error;
      const list = typeof results === 'function' ? results(query) : results;
      return list.map((item) => ({ ...item, source: id }));
    },
  };
}
