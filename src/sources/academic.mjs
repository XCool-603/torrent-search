/**
 * Academic Torrents（academictorrents.com）—— 学术数据集/论文种子。
 *
 * 该站没有搜索 API，官方明确要求「不要爬 browse 页面，请用 RSS/XML 全量文件」：
 *   https://academictorrents.com/rss.xml       最新条目（小）
 *   https://academictorrents.com/database.xml  全量数据库（约 3 MB，每天更新一次）
 *
 * 做法：把 database.xml 缓存到磁盘（默认 12 小时），本地做关键词检索。
 * 好处：零外部搜索依赖、可离线检索、不会给站点造成压力。
 */

import crypto from 'node:crypto';
import { parseRss } from '../rss.mjs';
import { textOf } from '../xml.mjs';
import { makeResult, normalizeTitle, tokenize } from '../models.mjs';
import { take } from './util.mjs';

const DATABASE_URL = 'https://academictorrents.com/database.xml';
const CACHE_KEY = 'academictorrents-database.xml';
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** 解析结果的内存缓存：{signature, entries} */
let memo = null;

/**
 * 解析 database.xml 为轻量条目（只保留检索需要的字段）。
 *
 * @param {Buffer|string} body
 * @returns {Array<{title: string, normTitle: string, infoHash: string|null, size: number|null, category: string|null, detailsUrl: string|null}>}
 */
export function parseDatabase(body) {
  const xml = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const { items } = parseRss(xml);

  return items
    .map((item) => {
      const title = item.title ?? '';
      if (title === '') return null;
      return {
        title,
        normTitle: normalizeTitle(title),
        infoHash: textOf(item.node, 'infohash'),
        size: textOf(item.node, 'size'),
        category: item.categories[0] ?? textOf(item.node, 'category'),
        detailsUrl: item.guid ?? item.link,
      };
    })
    .filter(Boolean);
}

/**
 * 在条目集合里做本地检索：所有关键词都必须命中（AND），按命中次数排序。
 *
 * @param {ReturnType<typeof parseDatabase>} entries
 * @param {string} query
 * @param {number} limit
 */
export function searchEntries(entries, query, limit) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return entries.slice(0, limit);

  const scored = [];
  for (const entry of entries) {
    let hits = 0;
    let matchedAll = true;

    for (const token of tokens) {
      if (entry.normTitle.includes(token)) hits += 1;
      else matchedAll = false;
    }

    if (hits === 0) continue;
    scored.push({ entry, hits, matchedAll });
  }

  scored.sort((a, b) => {
    if (a.matchedAll !== b.matchedAll) return a.matchedAll ? -1 : 1;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return (b.entry.size ?? 0) - (a.entry.size ?? 0);
  });

  return scored.slice(0, limit).map((item) => item.entry);
}

export default {
  id: 'academic',
  name: 'Academic Torrents',
  description: '学术数据集/论文种子，本地全量索引检索（3 MB 数据库，12 小时缓存）',
  homepage: 'https://academictorrents.com',
  kinds: ['academic'],
  defaultEnabled: true,

  /**
   * @param {string} query
   * @param {{http: any, limit: number, timeoutMs: number, signal?: AbortSignal, cache: any, logger?: Function}} ctx
   */
  async search(query, ctx) {
    const logger = ctx.logger ?? (() => {});

    const { value: entries } = await ctx.cache.getOrFetch(CACHE_KEY, {
      maxAgeMs: CACHE_MAX_AGE_MS,
      logger,
      fetch: async () => {
        // 数据库较大，单独放宽超时与体积上限
        const response = await ctx.http.request(DATABASE_URL, {
          timeoutMs: Math.max(ctx.timeoutMs, 20_000),
          signal: ctx.signal,
          maxBytes: 32 * 1024 * 1024,
        });
        return response.body;
      },
      transform: (body) => {
        const signature = `${body.length}:${crypto.createHash('sha1').update(body).digest('hex')}`;
        if (memo && memo.signature === signature) return memo.entries;
        const parsed = parseDatabase(body);
        memo = { signature, entries: parsed };
        return parsed;
      },
    });

    return take(
      searchEntries(entries, query, ctx.limit).map((entry) =>
        makeResult({
          source: 'academic',
          title: entry.title,
          infoHash: entry.infoHash,
          size: entry.size,
          category: entry.category,
          publishedAt: null,
          detailsUrl: entry.detailsUrl,
          torrentUrl: entry.infoHash ? `https://academictorrents.com/download/${entry.infoHash}.torrent` : null,
        }),
      ),
      ctx.limit,
    );
  },

  // 便于单测
  _parseDatabase: parseDatabase,
  _searchEntries: searchEntries,
};
