/**
 * BitSearch（bitsearch.to）—— DHT 爬虫型索引，覆盖面广，有 JSON API。
 *
 * 接口：GET /api/v1/search?q=&limit=&sort=
 * 返回 {success, results:[{id, infohash, title, size, seeders, leechers, updatedAt, category, subCategory}]}
 *
 * 实测要点：
 * - 详情页用 mongo id（`/torrent/<id>`），不是 infohash；
 * - 该站的排序参数是 `relevance | seeders | size | created | leechers`，**日期叫 created 而不是 date**；
 * - 分类 10 是成人分类（来自该站搜索页自己的分类下拉框），用于 `--safe` 过滤。
 *
 * 关键决策：**固定用 `sort=seeders` 抓取，不把用户的排序透传给该站。**
 * 原因是实测出来的：该站的 sort 不只是"重排"，而是换了一批完全不同的结果（每次只给 100 条）：
 *
 *   sort=seeders   → 做种中位数 57，做种 ≥100 的有 8 条
 *   sort=relevance → 做种中位数 51，做种 ≥100 的有 8 条
 *   sort=leechers  → 做种中位数 44，做种 ≥100 的有 8 条
 *   sort=size      → 做种中位数  1，做种 ≥100 的有 0 条   ← 几乎全是死种
 *
 * 如果透传 size/date，用户拿到的会是"最大的死种"；一旦叠加 `--min-seeders` 就会直接返回空，
 * 让人误以为"没有资源"。所以候选池统一按做种数取（最接近"真的能用"的那批），
 * 五个维度的排序全部在本地对这批候选做，语义稳定、与过滤条件不冲突。
 */

import { makeResult } from '../models.mjs';
import { parseBitsearchCategory } from '../categories.mjs';
import { clampLimit, take } from './util.mjs';

/** 抓取候选池时固定使用的排序（见文件头注释的实测依据） */
const POOL_SORT = 'seeders';

export default {
  id: 'bitsearch',
  name: 'BitSearch',
  description: 'DHT 爬虫索引，覆盖面广，JSON 接口，支持排序透传',
  homepage: 'https://bitsearch.to',
  kinds: ['general'],
  defaultEnabled: true,

  /**
   * @param {string} query
   * @param {{http: any, limit: number, timeoutMs: number, sort?: string, signal?: AbortSignal}} ctx
   */
  async search(query, ctx) {
    const limit = clampLimit(ctx.limit);
    // 刻意忽略 ctx.sort：候选池固定按做种数取，理由见文件头注释
    const url = `https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}&sort=${POOL_SORT}`;
    const data = await ctx.http.getJson(url, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      maxBytes: 8 * 1024 * 1024,
    });

    const list = Array.isArray(data?.results) ? data.results : [];

    return take(
      list.map((item) => {
        const category = parseBitsearchCategory(item.category);
        return makeResult({
          source: 'bitsearch',
          title: String(item.title ?? ''),
          infoHash: item.infohash,
          size: item.size,
          seeders: item.seeders,
          leechers: item.leechers,
          category: category.name,
          adult: category.adult,
          publishedAt: item.updatedAt,
          detailsUrl: item.id ? `https://bitsearch.to/torrent/${item.id}` : null,
          torrentUrl: null,
        });
      }),
      limit,
    ).filter((result) => result.title !== '');
  },

  // 便于单测
  _poolSort: POOL_SORT,
};
