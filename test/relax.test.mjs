/**
 * 自动放宽查询（`relaxQueryVariants` + `searchAll` 的重试策略）。
 *
 * 背景：上游站点要求关键词之间有分隔、且对拼写敏感，`ubuntu2404`（连写）实测 0 条，
 * 而 `ubuntu 24.04` / `ubuntu 2404` 有几十条。这里锁定三件事：
 * 1. 变体生成是纯函数、顺序稳定、绝不把原查询再试一遍；
 * 2. 只有结果明显不够时才重试，且最多 3 次；
 * 3. 放宽了就要如实告知（relaxedFrom / relaxedTo），没放宽就不许出现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { relaxQueryVariants, searchAll, RELAX_THRESHOLD, clearSearchCache, searchCacheSize } from '../src/aggregate.mjs';
import { fakeResult, memoryCache } from './helpers.mjs';

function ctx() {
  return { http: {}, cache: memoryCache(), logger: () => {} };
}

/**
 * 造 n 条互不相同的假结果（info hash 唯一，避免被跨源去重吃掉）。
 *
 * @param {number} count
 * @param {string} titlePrefix
 */
function manyResults(count, titlePrefix) {
  return Array.from({ length: count }, (_, index) =>
    fakeResult({ infoHash: String(index).padStart(40, '0'), title: `${titlePrefix} ${index}`, seeders: index }),
  );
}

/**
 * 造一个"按关键词返回不同结果"的假源，并记录每次收到的关键词。
 *
 * @param {Record<string, any[]>} table 关键词 → 结果数组
 */
function scriptedSource(table) {
  const calls = [];
  const source = {
    id: 'scripted',
    name: 'Scripted',
    description: '按关键词返回预设结果的假源',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    async search(query) {
      calls.push(query);
      return (table[query] ?? []).map((item) => ({ ...item, source: 'scripted' }));
    },
  };
  return { source, calls };
}

test('relaxQueryVariants：字母串紧跟数字串时插空格（ubuntu2404 → ubuntu 2404）', () => {
  const variants = relaxQueryVariants('ubuntu2404');

  assert.ok(variants.includes('ubuntu 2404'), `应包含「ubuntu 2404」，实际：${JSON.stringify(variants)}`);
  // 原查询再试一遍没有意义，纯属浪费请求
  assert.equal(variants.includes('ubuntu2404'), false);
});

test('relaxQueryVariants：中文去虚词，且不含原串', () => {
  const variants = relaxQueryVariants('进击的巨人 最终季');

  assert.ok(variants.length > 0, '这种带虚词的长查询应该还有可放宽的余地');
  // 去掉「的」是最小改动，必须排在前面
  assert.ok(variants.includes('进击巨人 最终季'), `应包含去虚词变体，实际：${JSON.stringify(variants)}`);
  assert.equal(variants.includes('进击的巨人 最终季'), false, '变体里不能出现原查询本身');
  assert.equal(new Set(variants).size, variants.length, '变体必须去重');
});

test('relaxQueryVariants：无可放宽余地时返回空数组', () => {
  // 单个字母：去停用词会变空、插空格与截断都无从下手
  assert.deepEqual(relaxQueryVariants('a'), []);
  // 已经足够"干净"的查询不该被编出一个变体来
  assert.deepEqual(relaxQueryVariants('巨人'), []);
  assert.deepEqual(relaxQueryVariants('cache-off'), []);
  // 1080p 这种「数字在前」的写法拆开只会更搜不到，不能拆
  assert.deepEqual(relaxQueryVariants('1080p'), []);
  // 空查询
  assert.deepEqual(relaxQueryVariants(''), []);
  assert.deepEqual(relaxQueryVariants('   '), []);
});

test('relaxQueryVariants：全角与多余标点会被归一，但纯大小写差异不浪费请求', () => {
  // 全角在站点眼里就是另一串字符，值得试
  assert.ok(relaxQueryVariants('ｕｂｕｎｔｕ２４０４').includes('ubuntu2404'));
  // 包裹标点同理
  assert.ok(relaxQueryVariants('【进击的巨人】').includes('进击的巨人'));
  // 大小写等价不算放宽：站点本来就不区分大小写
  assert.deepEqual(relaxQueryVariants('Ubuntu'), []);
});

test('searchAll：原查询 0 条时自动放宽，并带上 relaxedFrom / relaxedTo', async () => {
  const { source, calls } = scriptedSource({
    'ubuntu 2404': manyResults(RELAX_THRESHOLD, 'Ubuntu 2404'),
  });

  const result = await searchAll({ query: 'ubuntu2404', sources: [source], pageSize: 10, ...ctx() });

  assert.equal(result.total, RELAX_THRESHOLD);
  assert.ok(result.results.length > 0);
  assert.equal(result.query, 'ubuntu2404', 'query 始终是用户原话');
  assert.equal(result.relaxedFrom, 'ubuntu2404');
  assert.equal(result.relaxedTo, 'ubuntu 2404');
  assert.deepEqual(calls, ['ubuntu2404', 'ubuntu 2404'], '先用原查询，再用放宽后的查询');
});

test('searchAll：结果本来就够时绝不触发放宽（源只被调用一次）', async () => {
  const { source, calls } = scriptedSource({ ubuntu2404: manyResults(RELAX_THRESHOLD + 3, 'ubuntu2404 item') });

  const result = await searchAll({ query: 'ubuntu2404', sources: [source], ...ctx() });

  assert.equal(calls.length, 1, '结果充足时不该多打任何请求');
  assert.equal(result.total, RELAX_THRESHOLD + 3);
  assert.equal(result.relaxedFrom, null);
  assert.equal(result.relaxedTo, null);
});

test('searchAll：放宽也查不到时不报错，也不出现放宽标记', async () => {
  const { source, calls } = scriptedSource({});

  const result = await searchAll({ query: 'ubuntu2404', sources: [source], ...ctx() });

  assert.equal(result.total, 0);
  assert.deepEqual(result.results, []);
  assert.equal(result.relaxedFrom, null);
  assert.equal(result.relaxedTo, null);
  // 有变体就试，但别无限试
  assert.ok(calls.length > 1 && calls.length <= 4, `应尝试变体但不超过 3 次，实际调用：${JSON.stringify(calls)}`);
});

test('searchAll：放宽最多重试 3 次（长查询有很多变体也不会打爆请求）', async () => {
  const { source, calls } = scriptedSource({});
  const query = 'the lord of the rings 2003 extended edition';

  assert.ok(relaxQueryVariants(query).length > 3, '这个查询的变体数量应该超过重试上限');

  const result = await searchAll({ query, sources: [source], ...ctx() });

  assert.equal(calls.length, 4, '1 次原查询 + 最多 3 次放宽重试');
  assert.equal(result.total, 0);
  assert.equal(result.relaxedTo, null);
});

test('searchAll：放宽结果按放宽后的关键词缓存，不污染原查询的缓存', async () => {
  clearSearchCache();
  const { source, calls } = scriptedSource({ 'ubuntu 2404': manyResults(RELAX_THRESHOLD, 'Ubuntu 2404') });

  const first = await searchAll({ query: 'ubuntu2404', sources: [source], cacheTtlMs: 60_000, ...ctx() });
  assert.equal(first.cached, false);
  assert.equal(first.relaxedTo, 'ubuntu 2404');

  const second = await searchAll({ query: 'ubuntu2404', sources: [source], cacheTtlMs: 60_000, ...ctx() });
  assert.equal(second.cached, true, '两个关键词都应命中各自的缓存');
  assert.equal(second.relaxedTo, 'ubuntu 2404');
  assert.equal(second.total, RELAX_THRESHOLD);
  assert.equal(calls.length, 2, '第二次不该再发任何请求');
  assert.equal(searchCacheSize(), 2, '原查询与放宽查询各一条缓存');

  clearSearchCache();
});

test('searchAll：放宽后 sources 仍报各源真实状态，tookMs 覆盖整轮重试', async () => {
  const slow = {
    id: 'slow-relax',
    name: 'Slow Relax',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    async search(query) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return query === 'ubuntu 2404' ? manyResults(RELAX_THRESHOLD, 'hit').map((r) => ({ ...r, source: 'slow-relax' })) : [];
    },
  };

  const result = await searchAll({ query: 'ubuntu2404', sources: [slow], ...ctx() });

  assert.equal(result.relaxedTo, 'ubuntu 2404');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, 'slow-relax');
  assert.equal(result.sources[0].ok, true);
  assert.equal(result.sources[0].count, RELAX_THRESHOLD, 'count 是实际生效那一轮的真实条数');
  // 两轮各约 30ms，tookMs 必须覆盖全部重试而不是只看最后一轮
  assert.ok(result.tookMs >= 55, `tookMs 应覆盖整轮重试，实际 ${result.tookMs}ms`);
});

