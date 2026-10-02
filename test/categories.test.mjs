import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTpbCategory,
  parseBitsearchCategory,
  isAdultCategory,
  categoryTables,
  TPB_CATEGORIES,
  BITSEARCH_CATEGORIES,
} from '../src/categories.mjs';

test('parseTpbCategory 按 TPB 顶级分类中文化', () => {
  assert.deepEqual(parseTpbCategory('303'), { name: '软件', adult: false });
  assert.deepEqual(parseTpbCategory('101'), { name: '音频', adult: false });
  assert.deepEqual(parseTpbCategory('207'), { name: '视频', adult: false });
  assert.deepEqual(parseTpbCategory('401'), { name: '游戏', adult: false });
  assert.deepEqual(parseTpbCategory('601'), { name: '其他', adult: false });
});

test('parseTpbCategory 把 5xx 标记为成人分类', () => {
  for (const raw of ['500', '501', '505', 500]) {
    const parsed = parseTpbCategory(raw);
    assert.equal(parsed.name, '成人');
    assert.equal(parsed.adult, true, `${raw} 应该是成人分类`);
  }
});

test('parseTpbCategory 对空值/未知值不崩溃', () => {
  assert.deepEqual(parseTpbCategory(null), { name: null, adult: false });
  assert.deepEqual(parseTpbCategory(''), { name: null, adult: false });
  assert.deepEqual(parseTpbCategory(undefined), { name: null, adult: false });
  // 未知编号不猜：原样返回，让用户看到站点真实给的值（与 parseBitsearchCategory 行为一致）
  assert.deepEqual(parseTpbCategory('999'), { name: '999', adult: false });
  assert.deepEqual(parseTpbCategory('abc'), { name: 'abc', adult: false });
});

test('parseBitsearchCategory 使用 BitSearch 自己的分类表（1~10）', () => {
  assert.deepEqual(parseBitsearchCategory(1), { name: '其他', adult: false });
  assert.deepEqual(parseBitsearchCategory(2), { name: '电影', adult: false });
  assert.deepEqual(parseBitsearchCategory(3), { name: '剧集', adult: false });
  assert.deepEqual(parseBitsearchCategory(4), { name: '动漫', adult: false });
  assert.deepEqual(parseBitsearchCategory(5), { name: '软件', adult: false });
  assert.deepEqual(parseBitsearchCategory(6), { name: '游戏', adult: false });
  assert.deepEqual(parseBitsearchCategory(7), { name: '音乐', adult: false });
  assert.deepEqual(parseBitsearchCategory(8), { name: '有声书', adult: false });
  assert.deepEqual(parseBitsearchCategory(9), { name: '电子书/课程', adult: false });
});

test('parseBitsearchCategory 把 10 标记为成人分类', () => {
  assert.deepEqual(parseBitsearchCategory(10), { name: '成人', adult: true });
  assert.deepEqual(parseBitsearchCategory('10'), { name: '成人', adult: true });
});

test('parseBitsearchCategory 对空值/未知值不崩溃', () => {
  assert.deepEqual(parseBitsearchCategory(null), { name: null, adult: false });
  assert.deepEqual(parseBitsearchCategory(''), { name: null, adult: false });
  assert.deepEqual(parseBitsearchCategory(99), { name: '99', adult: false });
  assert.deepEqual(parseBitsearchCategory('abc'), { name: 'abc', adult: false });
});

test('isAdultCategory 只对已知成人分类返回 true', () => {
  assert.equal(isAdultCategory('apibay', '505'), true);
  assert.equal(isAdultCategory('apibay', '303'), false);
  assert.equal(isAdultCategory('bitsearch', 10), true);
  assert.equal(isAdultCategory('bitsearch', 2), false);

  // 非成人站点永远返回 false（不猜）
  for (const source of ['nyaa', 'mikan', 'dmhy', 'academic', 'demo', 'unknown']) {
    assert.equal(isAdultCategory(source, 10), false, `${source} 不应被判为成人分类`);
  }
});

test('分类表本身保持稳定（改动需要同步文档与测试）', () => {
  assert.equal(Object.keys(TPB_CATEGORIES).length, 7);
  assert.equal(Object.keys(BITSEARCH_CATEGORIES).length, 10);

  const tables = categoryTables();
  assert.equal(tables.length, 2);
  assert.equal(tables[0].source, 'apibay');
  assert.equal(tables[1].source, 'bitsearch');
  assert.equal(tables[1].mapping[10], '成人');
});
