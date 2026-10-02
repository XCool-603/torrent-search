import test from 'node:test';
import assert from 'node:assert/strict';

import { displayWidth, truncateDisplay, padDisplay, createColorizer, renderResultsTable, renderSourceStatus } from '../src/format.mjs';
import { fakeResult } from './helpers.mjs';

test('displayWidth 把中日韩字符算成 2 列', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中文abc'), 7);
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth(null), 0);
  assert.equal(displayWidth('，。！'), 6);
});

test('truncateDisplay 按显示宽度截断并加省略号', () => {
  assert.equal(truncateDisplay('abcdef', 10), 'abcdef');
  assert.equal(truncateDisplay('abcdef', 4), 'abc…');
  assert.equal(truncateDisplay('abc', 0), '');

  // 中日韩字符占 2 列：宽度 6 时最多放两个汉字（2+2）再加 1 列的省略号
  assert.equal(truncateDisplay('中文字符串', 6), '中文…');
  assert.equal(truncateDisplay('中文字符串', 7), '中文字…');
  assert.ok(displayWidth(truncateDisplay('中文字符串', 7)) <= 7);
  assert.ok(displayWidth(truncateDisplay('中文字符串', 8)) <= 8);
});

test('padDisplay 左右对齐都按显示宽度补齐', () => {
  assert.equal(padDisplay('ab', 5), 'ab   ');
  assert.equal(padDisplay('ab', 5, 'right'), '   ab');
  assert.equal(displayWidth(padDisplay('中文', 8)), 8);
  assert.equal(displayWidth(padDisplay('中文', 8, 'right')), 8);
  assert.equal(padDisplay('toolong', 3), 'toolong');
});

test('createColorizer 在关闭时原样返回', () => {
  const off = createColorizer(false);
  assert.equal(off('32')('文本'), '文本');

  const on = createColorizer(true);
  assert.equal(on('32')('文本'), '\u001b[32m文本\u001b[0m');
});

test('renderResultsTable 包含关键列且不抛异常', () => {
  const results = [
    fakeResult({ source: 'apibay', infoHash: 'a'.repeat(40), title: '中文标题 Ubuntu 24.04', size: 1024 ** 3, sizeText: '1.00 GiB', seeders: 42, leechers: 3, publishedAt: new Date().toISOString() }),
    fakeResult({ source: 'nyaa', infoHash: null, title: 'no hash item', size: null, sizeText: null, seeders: null, leechers: null, publishedAt: null, sources: ['nyaa', 'mikan'] }),
  ];

  const table = renderResultsTable(results, { width: 120, color: createColorizer(false) });

  assert.match(table, /#/);
  assert.match(table, /标题/);
  assert.match(table, /体积/);
  assert.match(table, /做种/);
  assert.match(table, /来源/);
  assert.match(table, /中文标题 Ubuntu 24\.04/);
  assert.match(table, /1\.00 GiB/);
  assert.match(table, /42/);
  assert.match(table, /nyaa\+mikan/); // 合并来源
  assert.match(table, /-/); // null 字段显示为 -
  assert.equal(table.split('\n').length, 4); // 表头 + 分隔线 + 2 行
});

test('renderResultsTable 空结果只输出表头', () => {
  const table = renderResultsTable([], { width: 100, color: createColorizer(false) });
  assert.equal(table.split('\n').length, 2);
});

test('renderSourceStatus 区分成功与失败', () => {
  const line = renderSourceStatus(
    [
      { id: 'apibay', name: 'A', ok: true, count: 100, tookMs: 420, error: null },
      { id: 'nyaa', name: 'N', ok: false, count: 0, tookMs: 8000, error: '超时 (8000ms)' },
    ],
    { color: createColorizer(false) },
  );

  assert.match(line, /apibay ✓ 100 条 420ms/);
  assert.match(line, /nyaa ✗ 超时 \(8000ms\)/);
  assert.match(line, /·/);
});
