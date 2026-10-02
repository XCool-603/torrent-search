/**
 * Mikan Project（蜜柑计划，mikanani.me）—— 中文动漫资源站。
 *
 * 用 RSS 搜索接口：GET /RSS/Search?searchstr=<关键词>
 * item 结构（已实测）：
 *   <link>https://mikanani.me/Home/Episode/<40位hex></link>
 *   <torrent><contentLength>3865470464</contentLength><pubDate>...</pubDate></torrent>
 *   <enclosure type="application/x-bittorrent" url="https://mikanani.me/Download/20260811/<hash>.torrent"/>
 *
 * 已用「下载 .torrent → bencode → SHA1(info)」验证过：Episode 路径里的 40 位 hex 就是真实 info hash，
 * 所以可以放心据此构造磁力链接。
 */

import { parseRss } from '../rss.mjs';
import { findDescendant, textOf } from '../xml.mjs';
import { makeResult } from '../models.mjs';
import { normalizeInfoHash } from '../magnet.mjs';
import { take } from './util.mjs';

/**
 * 从 https://mikanani.me/Home/Episode/<hash> 里取出 info hash。
 *
 * @param {string|null} link
 * @returns {string|null}
 */
function hashFromLink(link) {
  if (!link) return null;
  const match = String(link).match(/\/Episode\/([0-9a-fA-F]{40})/);
  return match ? normalizeInfoHash(match[1]) : null;
}

export default {
  id: 'mikan',
  name: 'Mikan Project（蜜柑计划）',
  description: '中文动漫资源站，RSS 搜索，Episode 编号即 info hash',
  homepage: 'https://mikanani.me',
  kinds: ['anime'],
  defaultEnabled: true,

  /**
   * @param {string} query
   * @param {{http: any, limit: number, timeoutMs: number, signal?: AbortSignal}} ctx
   */
  async search(query, ctx) {
    const url = `https://mikanani.me/RSS/Search?searchstr=${encodeURIComponent(query)}`;
    const xml = await ctx.http.getText(url, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      maxBytes: 8 * 1024 * 1024,
    });

    const { items } = parseRss(xml);

    return take(
      items.map((item) => {
        const torrentNode = findDescendant(item.node, 'torrent');
        const enclosure = item.enclosures[0] ?? null;
        const infoHash = hashFromLink(item.link) ?? hashFromLink(enclosure?.url ?? null);

        return makeResult({
          source: 'mikan',
          title: item.title ?? '',
          infoHash,
          size: torrentNode ? textOf(torrentNode, 'contentLength') : null,
          seeders: null,
          leechers: null,
          category: item.categories[0] ?? '动漫',
          publishedAt: (torrentNode ? textOf(torrentNode, 'pubDate') : null) ?? item.pubDate,
          detailsUrl: item.link,
          torrentUrl: enclosure?.url ?? null,
        });
      }),
      ctx.limit,
    ).filter((result) => result.title !== '');
  },

  // 便于单测直接验证
  _hashFromLink: hashFromLink,
};
