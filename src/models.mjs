/**
 * 统一结果模型。
 *
 * 所有数据源（JSON API / RSS / 本地索引）都必须产出这个形状，
 * 这样聚合、去重、排序、CLI 输出和 Web UI 都只面对一种数据结构。
 */

import { normalizeInfoHash, buildMagnet, parseMagnet, shortHash } from './magnet.mjs';
import { formatBytes, parseSizeText, parseTimestamp, toCount } from './size.mjs';

/**
 * @typedef {object} TorrentResult
 * @property {string} id            稳定 id：`<source>:<infoHash>`，无 hash 时用标题+体积的短哈希
 * @property {string} source        数据源 id
 * @property {string} title         标题
 * @property {string|null} infoHash 小写 40 位 hex
 * @property {string|null} magnet   磁力链接
 * @property {number|null} size     字节数
 * @property {string|null} sizeText 人类可读体积
 * @property {number|null} seeders  做种数
 * @property {number|null} leechers 下载数
 * @property {string|null} category 分类（各站原始值已尽量中文化）
 * @property {boolean} adult       是否属于成人分类（由站点自己的分类标注决定，`--safe` 过滤依据）
 * @property {string|null} publishedAt ISO 时间
 * @property {string|null} detailsUrl 详情页
 * @property {string|null} torrentUrl .torrent 下载地址
 * @property {number} [score]       相关度评分（聚合阶段计算）
 * @property {string[]} [sources]   合并后的所有来源
 */

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
];

/**
 * 构造一条规范化的搜索结果。
 *
 * @param {Partial<TorrentResult> & {source: string, title: string}} input
 * @returns {TorrentResult}
 */
export function makeResult(input) {
  const source = String(input.source ?? 'unknown');
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim();

  let infoHash = normalizeInfoHash(input.infoHash ?? null);
  let magnet = typeof input.magnet === 'string' && input.magnet.startsWith('magnet:') ? input.magnet : null;

  // 有 hash 没磁力 → 现造；有磁力没 hash → 从磁力里补
  if (!magnet && infoHash) magnet = buildMagnet({ infoHash, name: title });
  if (!infoHash && magnet) infoHash = parseMagnet(magnet)?.infoHash ?? null;

  const size = parseSizeText(input.size ?? null) ?? parseSizeText(input.sizeText ?? null);

  return {
    id: `${source}:${infoHash ?? shortHash(`${title}|${size ?? ''}`)}`,
    source,
    title,
    infoHash,
    magnet,
    size,
    sizeText: formatBytes(size),
    seeders: toCount(input.seeders ?? null),
    leechers: toCount(input.leechers ?? null),
    category: input.category ? String(input.category) : null,
    adult: input.adult === true,
    publishedAt: parseTimestamp(input.publishedAt ?? null),
    detailsUrl: input.detailsUrl ?? null,
    torrentUrl: input.torrentUrl ?? null,
  };
}

/**
 * 去重键：优先 info hash（跨站同一种子会命中），否则用标题+体积。
 *
 * @param {TorrentResult} result
 * @returns {string}
 */
export function dedupeKey(result) {
  if (result.infoHash) return `h:${result.infoHash}`;
  return `t:${normalizeTitle(result.title)}|${result.size ?? ''}`;
}

/**
 * 标题归一化（去标点、去多余空格、小写），用于无 hash 时的模糊去重与相关性打分。
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[._\-+]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 关键词切分：支持中英文混排。中文按字切（中文没有空格），英文按词切。
 *
 * @param {string} query
 * @returns {string[]}
 */
export function tokenize(query) {
  const text = String(query ?? '').toLowerCase().trim();
  if (text === '') return [];

  const tokens = new Set();
  for (const chunk of text.split(/[\s,，、;；]+/)) {
    if (chunk === '') continue;
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      // 中文：整块 + 单字（"进击的巨人" 既能整块匹配，也能靠单字提高召回）
      tokens.add(chunk);
      for (const char of chunk) {
        if (/[\u4e00-\u9fff]/.test(char)) tokens.add(char);
      }
    } else {
      tokens.add(chunk);
    }
  }
  return [...tokens];
}

export { DEFAULT_TRACKERS };
