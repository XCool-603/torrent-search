/**
 * Nyaa（nyaa.si）—— 动漫、影视、软件、音乐为主的综合站。
 *
 * 用 RSS 接口（?page=rss）而不是抓 HTML：稳定、无 Cloudflare、字段齐全
 * （nyaa:seeders / nyaa:leechers / nyaa:infoHash / nyaa:size / nyaa:category）。
 */

import { parseRss, itemTag } from '../rss.mjs';
import { makeResult } from '../models.mjs';
import { take } from './util.mjs';

export default {
  id: 'nyaa',
  name: 'Nyaa',
  description: '动漫/影视/软件综合站，RSS 接口，含分类与做种数',
  homepage: 'https://nyaa.si',
  kinds: ['anime', 'general'],
  defaultEnabled: true,

  /**
   * @param {string} query
   * @param {{http: any, limit: number, timeoutMs: number, signal?: AbortSignal}} ctx
   */
  async search(query, ctx) {
    // c=0_0 全部分类，f=0 不做过滤（含无做种的种子）
    const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
    const xml = await ctx.http.getText(url, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      maxBytes: 4 * 1024 * 1024,
    });

    const { items } = parseRss(xml);

    return take(
      items.map((item) =>
        makeResult({
          source: 'nyaa',
          title: item.title ?? '',
          infoHash: itemTag(item, 'infoHash'),
          sizeText: itemTag(item, 'size'),
          seeders: itemTag(item, 'seeders'),
          leechers: itemTag(item, 'leechers'),
          category: itemTag(item, 'category') ?? item.categories[0] ?? null,
          publishedAt: item.pubDate,
          detailsUrl: item.guid ?? item.link,
          torrentUrl: item.link,
        }),
      ),
      ctx.limit,
    ).filter((result) => result.title !== '');
  },
};
