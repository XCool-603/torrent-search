/**
 * 动漫花园（share.dmhy.org）—— 中文动漫/影视资源站。
 *
 * 用 RSS 搜索接口：GET /topics/rss/rss.xml?keyword=<关键词>
 * 关键点：磁力链接在 <enclosure url="magnet:?...">，而且 btih 是 **Base32**（32 字符），
 * 必须先转成 40 位 hex，否则跨站去重会失效。
 * 站点不提供体积和做种数，这两个字段保持 null（诚实展示，不编造）。
 */

import { parseRss } from '../rss.mjs';
import { makeResult } from '../models.mjs';
import { parseMagnet } from '../magnet.mjs';
import { take } from './util.mjs';

export default {
  id: 'dmhy',
  name: '动漫花园 (dmhy)',
  description: '中文动漫/影视资源站，RSS 搜索，磁力为 Base32 btih',
  homepage: 'https://share.dmhy.org',
  kinds: ['anime'],
  defaultEnabled: true,

  /**
   * @param {string} query
   * @param {{http: any, limit: number, timeoutMs: number, signal?: AbortSignal}} ctx
   */
  async search(query, ctx) {
    const url = `https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent(query)}`;
    const xml = await ctx.http.getText(url, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      maxBytes: 12 * 1024 * 1024, // 该站一次最多返回 500 条，体积可达 2 MB
    });

    const { items } = parseRss(xml);
    const results = [];

    for (const item of items) {
      const magnetEntry = item.enclosures.find((enc) => typeof enc.url === 'string' && enc.url.startsWith('magnet:'));
      const parsed = magnetEntry ? parseMagnet(magnetEntry.url) : null;

      results.push(
        makeResult({
          source: 'dmhy',
          title: item.title ?? '',
          infoHash: parsed?.infoHash ?? null,
          magnet: parsed?.infoHash ? magnetEntry.url : null,
          size: null,
          seeders: null,
          leechers: null,
          category: item.categories[0] ?? null,
          publishedAt: item.pubDate,
          detailsUrl: item.guid ?? item.link,
          torrentUrl: null,
        }),
      );

      if (results.length >= ctx.limit) break;
    }

    return take(results, ctx.limit).filter((result) => result.title !== '');
  },
};
