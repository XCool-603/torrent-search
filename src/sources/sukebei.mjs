/**
 * Sukebei（sukebei.nyaa.si）—— Nyaa 的**成人**分站。
 *
 * 为什么单独作为一个源：nyaa.si 本身不含 R18 内容（站点把它拆到了这个分站），
 * 而 apibay / bitsearch 每源一次最多只给 100 条。实测同一个关键词：
 *   「无码」→ nyaa.si 6 条，sukebei 75 条。
 * 所以想搜这类内容，不加这个源就会觉得"结果少了很多"。
 *
 * 接口与 nyaa.si 完全一致（同一个程序的两个部署），因此复用同一套 RSS 解析。
 *
 * 关于内容：本站全部结果都标记为成人分类（`adult: true`），
 * 于是 `--safe` / Web UI 的「安全过滤」可以一键把它们全部排除——
 * 这与 apibay 的 5xx、BitSearch 的 10 分类处理方式一致。
 */

import { parseRss, itemTag } from '../rss.mjs';
import { makeResult } from '../models.mjs';
import { take } from './util.mjs';

export default {
  id: 'sukebei',
  name: 'Sukebei (Nyaa 成人站)',
  description: 'Nyaa 的成人分站，RSS 接口；结果全部标记为成人分类，可用「安全过滤」排除',
  homepage: 'https://sukebei.nyaa.si',
  kinds: ['adult'],
  defaultEnabled: true,

  /**
   * @param {string} query
   * @param {{http: any, limit: number, timeoutMs: number, signal?: AbortSignal}} ctx
   */
  async search(query, ctx) {
    const url = `https://sukebei.nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
    const xml = await ctx.http.getText(url, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      maxBytes: 4 * 1024 * 1024,
    });

    const { items } = parseRss(xml);

    return take(
      items.map((item) =>
        makeResult({
          source: 'sukebei',
          title: item.title ?? '',
          infoHash: itemTag(item, 'infoHash'),
          sizeText: itemTag(item, 'size'),
          seeders: itemTag(item, 'seeders'),
          leechers: itemTag(item, 'leechers'),
          category: itemTag(item, 'category') ?? item.categories[0] ?? null,
          publishedAt: item.pubDate,
          detailsUrl: item.guid ?? item.link,
          torrentUrl: item.link,
          // 整站都是成人内容：据实标记，安全过滤才能真正生效
          adult: true,
        }),
      ),
      ctx.limit,
    ).filter((result) => result.title !== '');
  },
};
