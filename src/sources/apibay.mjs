/**
 * The Pirate Bay（apibay.org JSON 接口）
 *
 * 官方站点前端用的就是这个接口，返回纯 JSON，无 Cloudflare、无分页（一次最多 100 条）。
 * 无结果时返回一个占位条目（id=0 / name="No results returned"），必须过滤掉。
 */

import { makeResult } from '../models.mjs';
import { parseTpbCategory } from '../categories.mjs';
import { clampLimit } from './util.mjs';

export default {
  id: 'apibay',
  name: 'The Pirate Bay (apibay)',
  description: '海盗湾官方 JSON 接口，综合资源，速度快、无分页',
  homepage: 'https://thepiratebay.org',
  kinds: ['general'],
  defaultEnabled: true,

  /**
   * @param {string} query
   * @param {{http: any, limit: number, timeoutMs: number, signal?: AbortSignal}} ctx
   */
  async search(query, ctx) {
    // `cat` 参数不是可选的：上游现在不带 cat 时直接返回 {"name":"No results returned"}（对象而不是数组），
    // 于是所有查询都变成 0 条。cat=0 表示「全部分类」，实测 `q=ubuntu` 0 条、`q=ubuntu&cat=0` 100 条。
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`;
    const data = await ctx.http.getJson(url, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      maxBytes: 4 * 1024 * 1024,
    });

    if (!Array.isArray(data)) return [];

    const limit = clampLimit(ctx.limit);
    const results = [];

    for (const item of data) {
      if (!item || typeof item !== 'object') continue;

      const title = String(item.name ?? '').trim();
      // 无结果占位条目
      if (item.id === '0' || item.id === 0) continue;
      if (/^no results/i.test(title)) continue;
      if (title === '') continue;

      const category = parseTpbCategory(item.category);
      results.push(
        makeResult({
          source: 'apibay',
          title,
          infoHash: item.info_hash,
          size: item.size,
          seeders: item.seeders,
          leechers: item.leechers,
          category: category.name,
          adult: category.adult,
          publishedAt: item.added,
          detailsUrl: item.id ? `https://thepiratebay.org/description.php?id=${item.id}` : null,
          torrentUrl: item.id ? `https://apibay.org/torrent/${item.id}` : null,
        }),
      );

      if (results.length >= limit) break;
    }

    return results;
  },
};
