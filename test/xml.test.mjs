import test from 'node:test';
import assert from 'node:assert/strict';

import { parseXml, localName, child, children, textOf, textOfAny, attr, findDescendant, decodeEntities } from '../src/xml.mjs';
import { parseRss, itemTag, itemTags } from '../src/rss.mjs';
import { fixture } from './helpers.mjs';

test('parseXml 解析元素、属性、嵌套与自闭合标签', () => {
  const root = parseXml('<a x="1" y=\'2\'><b>hello</b><c/><d k=v>text</d></a>');
  const a = child(root, 'a');

  assert.ok(a);
  assert.equal(attr(a, 'x'), '1');
  assert.equal(attr(a, 'y'), '2');
  assert.equal(attr(a, 'missing'), null);
  assert.equal(textOf(a, 'b'), 'hello');
  assert.equal(children(a, 'c').length, 1);
  assert.equal(children(a, 'c')[0].children.length, 0);
  assert.equal(textOf(a, 'd'), 'text');
  assert.equal(attr(child(a, 'd'), 'k'), 'v');
});

test('parseXml 处理 CDATA、注释、处理指令与 DOCTYPE', () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE rss [ <!ENTITY x "y"> ]>
<!-- 注释里也有 <tag> -->
<root><![CDATA[<b>不解析</b> & 保留]]></root>`;
  const root = parseXml(xml);
  assert.equal(child(root, 'root').text, '<b>不解析</b> & 保留');
});

test('decodeEntities 处理命名实体与数字实体', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&nbsp;'), '&<>"\'AB ');
  assert.equal(decodeEntities('没有实体'), '没有实体');
});

test('命名空间前缀被当作本地名处理', () => {
  const root = parseXml('<i><nyaa:seeders>31</nyaa:seeders><nyaa:infoHash>AB</nyaa:infoHash></i>');
  const item = child(root, 'i');
  assert.equal(localName('nyaa:seeders'), 'seeders');
  assert.equal(textOf(item, 'seeders'), '31');
  assert.equal(textOfAny(item, ['missing', 'infoHash']), 'AB');
});

test('findDescendant 能穿透到嵌套块内部', () => {
  const root = parseXml('<item><link>a</link><torrent><link>b</link><contentLength>123</contentLength></torrent></item>');
  const item = child(root, 'item');

  // 直接子节点优先，拿到的是 item 自己的 link
  assert.equal(textOf(item, 'link'), 'a');
  const contentLength = findDescendant(item, 'contentLength');
  assert.ok(contentLength);
  assert.equal(contentLength.text.trim(), '123');
  // findDescendant 返回的是目标节点本身，所以对它取同名子节点应该是 null
  assert.equal(textOf(contentLength, 'contentLength'), null);
});

test('parseXml 对空输入返回 null，不抛异常', () => {
  assert.equal(parseXml(''), null);
  assert.equal(parseXml(null), null);
  assert.equal(parseXml('   '), null);
});

test('parseRss 解析真实 nyaa 夹具', () => {
  const { title, items } = parseRss(fixture('nyaa-ubuntu.xml'));

  assert.equal(title, 'Nyaa - "ubuntu" - Torrent File RSS');
  assert.equal(items.length, 1);

  const [item] = items;
  assert.equal(item.title, 'Koha Live CD Release 3 (3.0.4 Ubuntu 9.10 Desktop x86)');
  assert.equal(item.link, 'https://nyaa.si/download/96659.torrent');
  assert.equal(item.guid, 'https://nyaa.si/view/96659');
  assert.equal(itemTag(item, 'seeders'), '0');
  assert.equal(itemTag(item, 'size'), '624.0 MiB');
  assert.equal(itemTag(item, 'infoHash'), '45008e48c8800b7d7643337b2e70a634e4c69f6a');
  assert.equal(itemTag(item, 'category'), 'Software - Applications');
  assert.equal(item.categories.length, 1);
});

test('parseRss 解析 mikan 夹具的嵌套 torrent 块', () => {
  const { items } = parseRss(fixture('mikan-shingeki.xml'));
  assert.equal(items.length, 3);

  const torrent = findDescendant(items[0].node, 'torrent');
  assert.ok(torrent);
  assert.equal(textOf(torrent, 'contentLength'), '3865470464');
  assert.ok(textOf(torrent, 'pubDate').startsWith('2026-08-11T18:47:25'));
  assert.match(items[0].enclosures[0].url, /^https:\/\/mikanani\.me\/Download\//);
});

test('parseRss 解析 dmhy 夹具的磁力 enclosure 与 CDATA 分类', () => {
  const { items } = parseRss(fixture('dmhy-shingeki.xml'));
  assert.equal(items.length, 3);

  const magnet = items[0].enclosures.find((enc) => enc.url?.startsWith('magnet:'));
  assert.ok(magnet, 'dmhy 的 enclosure 应该是磁力链接');
  // XML 实体必须被还原成真正的 &，否则 URLSearchParams 解析不出 tracker
  assert.ok(magnet.url.includes('&tr='));
  assert.ok(!magnet.url.includes('&amp;'));
  assert.ok(items[0].categories.length >= 1);
});

test('itemTags 能列出所有叶子标签（调试辅助）', () => {
  const { items } = parseRss(fixture('nyaa-ubuntu.xml'));
  const tags = itemTags(items[0]);
  assert.equal(tags.seeders, '0');
  assert.equal(tags.size, '624.0 MiB');
  assert.ok(Object.keys(tags).includes('infoHash'));
});
