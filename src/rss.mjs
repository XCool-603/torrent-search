/**
 * RSS 2.0 解析（基于 src/xml.mjs 的通用解析器）。
 *
 * 站点差异都收敛在这里，适配器只需要读 item 的字段。
 */

import { parseXml, child, children, textOf, attr, localName } from './xml.mjs';

/**
 * 解析 RSS 文本。
 *
 * @param {string} xml
 * @returns {{title: string|null, items: RssItem[]}}
 */
export function parseRss(xml) {
  const root = parseXml(xml);
  if (!root) return { title: null, items: [] };

  const rss = child(root, 'rss') ?? child(root, 'feed') ?? root;
  const channel = child(rss, 'channel') ?? rss;

  const items = children(channel, 'item').map(toItem);
  return { title: textOf(channel, 'title'), items };
}

/**
 * @typedef {object} RssItem
 * @property {string|null} title
 * @property {string|null} link
 * @property {string|null} guid
 * @property {string|null} pubDate
 * @property {string|null} description
 * @property {Array<{url: string|null, type: string|null, length: string|null}>} enclosures
 * @property {string[]} categories
 * @property {any} node 原始节点，供适配器读取站点私有标签（如 nyaa:seeders）
 */

/**
 * @param {any} node
 * @returns {RssItem}
 */
function toItem(node) {
  const enclosures = children(node, 'enclosure').map((enc) => ({
    url: attr(enc, 'url'),
    type: attr(enc, 'type'),
    length: attr(enc, 'length'),
  }));

  const categories = children(node, 'category')
    .map((cat) => (cat.text ?? '').trim())
    .filter(Boolean);

  return {
    title: clean(textOf(node, 'title')),
    link: clean(textOf(node, 'link')),
    guid: clean(textOf(node, 'guid')),
    pubDate: clean(textOf(node, 'pubDate')),
    description: textOf(node, 'description'),
    enclosures,
    categories,
    node,
  };
}

function clean(value) {
  if (value === null) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * 读取 item 上任意（含命名空间的）标签文本。
 *
 * @param {RssItem} item
 * @param {string} name
 * @returns {string|null}
 */
export function itemTag(item, name) {
  return textOf(item.node, name);
}

/**
 * 列出 item 的所有叶子标签（调试 / 兼容未知格式时用）。
 *
 * @param {RssItem} item
 * @returns {Record<string, string>}
 */
export function itemTags(item) {
  const out = {};
  const walk = (node) => {
    for (const childNode of node.children ?? []) {
      const key = localName(childNode.name);
      const text = (childNode.text ?? '').trim();
      if (text !== '' && out[key] === undefined) out[key] = text;
      walk(childNode);
    }
  };
  walk(item.node);
  return out;
}
