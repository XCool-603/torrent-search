/**
 * 适配器共用的小工具。
 */

/**
 * 把响应里可能出现的 HTML 标签/实体清掉，只留纯文本（站点会在标题里塞 <em> 高亮）。
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function stripHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 截断到 limit 条。
 *
 * @template T
 * @param {T[]} list
 * @param {number} limit
 * @returns {T[]}
 */
export function take(list, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return list;
  return list.slice(0, limit);
}

/**
 * 把 `limit` 参数转成站点可用的分页大小（很多站点上限 100）。
 *
 * @param {number} limit
 * @param {number} [max]
 * @returns {number}
 */
export function clampLimit(limit, max = 100) {
  if (!Number.isFinite(limit) || limit <= 0) return max;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}
