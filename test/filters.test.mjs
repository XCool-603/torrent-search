import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterResults,
  normalizeFilters,
  compileExcludeMatchers,
  searchAll,
  clearSearchCache,
  searchCacheSize,
} from '../src/aggregate.mjs';
import { fakeResult, fakeSource, memoryCache } from './helpers.mjs';

function ctx() {
  return { http: {}, cache: memoryCache(), logger: () => {} };
}

test('normalizeFilters：默认不过滤，非法值退化为 0/空', () => {
  assert.deepEqual(normalizeFilters(), { minSeeders: 0, exclude: [], safe: false });
  assert.deepEqual(normalizeFilters({}), { minSeeders: 0, exclude: [], safe: false });

  assert.equal(normalizeFilters({ minSeeders: '20' }).minSeeders, 20);
  assert.equal(normalizeFilters({ minSeeders: 3.7 }).minSeeders, 3);
  assert.equal(normalizeFilters({ minSeeders: -5 }).minSeeders, 0);
  assert.equal(normalizeFilters({ minSeeders: 'abc' }).minSeeders, 0);
  assert.equal(normalizeFilters({ minSeeders: '' }).minSeeders, 0);
  assert.equal(normalizeFilters({ minSeeders: null }).minSeeders, 0);

  // safe 必须是严格的 true，字符串 '1' 不算（HTTP 层负责把 1 转成 true）
  assert.equal(normalizeFilters({ safe: true }).safe, true);
  assert.equal(normalizeFilters({ safe: '1' }).safe, false);
  assert.equal(normalizeFilters({ safe: 'true' }).safe, false);
});

test('normalizeFilters：exclude 支持字符串与数组，并去掉空项', () => {
  assert.deepEqual(normalizeFilters({ exclude: 'cam, 枪版 ,, TS ' }).exclude, ['cam', '枪版', 'TS']);
  assert.deepEqual(normalizeFilters({ exclude: ['cam', '枪版'] }).exclude, ['cam', '枪版']);
  assert.deepEqual(normalizeFilters({ exclude: '' }).exclude, []);
  assert.deepEqual(normalizeFilters({ exclude: null }).exclude, []);
});

test('compileExcludeMatchers：ASCII 关键词按词首边界匹配，不误伤子串', () => {
  const [matchTs] = compileExcludeMatchers(['ts']);

  assert.equal(matchTs('movie ts 1080p'), true);
  assert.equal(matchTs('movie tsrip'), true);
  assert.equal(matchTs('shorts'), false, 'ts 不应该匹配 shorts');
  assert.equal(matchTs('pets'), false);
  assert.equal(matchTs('artstation'), false);
});

test('compileExcludeMatchers：cam 能命中 camrip，中文按子串匹配', () => {
  const [matchCam] = compileExcludeMatchers(['cam']);
  assert.equal(matchCam('movie cam'), true);
  assert.equal(matchCam('movie camrip'), true);
  assert.equal(matchCam('camera work'), true, '词首匹配，camera 也算命中');
  assert.equal(matchCam('scam'), false, 'scam 里的 cam 不在词首');

  const [matchChinese] = compileExcludeMatchers(['枪版']);
  assert.equal(matchChinese('某电影 枪版 1080p'), true);
  assert.equal(matchChinese('某电影 高清版'), false);
});

test('compileExcludeMatchers：正则特殊字符被转义，空关键词不匹配任何东西', () => {
  const [matchSpecial] = compileExcludeMatchers(['c++']);
  // 'c++' 归一化后是 'c'（加号被当成分隔符），至少不应抛异常
  assert.doesNotThrow(() => matchSpecial('c something'));

  const matchers = compileExcludeMatchers(['', '   ']);
  assert.equal(matchers.every((match) => match('任意标题') === false), true);
});

test('filterResults：无过滤条件时原样返回（同一个数组引用）', () => {
  const list = [fakeResult({ title: 'a' })];
  assert.equal(filterResults(list, {}), list);
  assert.equal(filterResults(list, { minSeeders: 0, exclude: [], safe: false }), list);
});

test('filterResults：minSeeders 会连做种数未知的结果一起过滤', () => {
  const list = [
    fakeResult({ infoHash: 'a'.repeat(40), title: 'high', seeders: 50 }),
    fakeResult({ infoHash: 'b'.repeat(40), title: 'low', seeders: 3 }),
    fakeResult({ infoHash: 'c'.repeat(40), title: 'unknown', seeders: null }),
    fakeResult({ infoHash: 'd'.repeat(40), title: 'zero', seeders: 0 }),
  ];

  const filtered = filterResults(list, { minSeeders: 10 });
  assert.deepEqual(filtered.map((item) => item.title), ['high']);

  // minSeeders = 0 时全部保留（未知做种数不算违规）
  assert.equal(filterResults(list, { minSeeders: 0 }).length, 4);
});

test('filterResults：safe 只排除 adult 标记为 true 的结果', () => {
  const list = [
    fakeResult({ infoHash: 'a'.repeat(40), title: 'normal', adult: false }),
    fakeResult({ infoHash: 'b'.repeat(40), title: 'adult item', adult: true }),
    fakeResult({ infoHash: 'c'.repeat(40), title: 'no flag' }),
  ];

  assert.deepEqual(filterResults(list, { safe: true }).map((item) => item.title), ['normal', 'no flag']);
  assert.equal(filterResults(list, { safe: false }).length, 3);
});

test('filterResults：exclude 命中标题即排除', () => {
  const list = [
    fakeResult({ infoHash: 'a'.repeat(40), title: 'Movie.2024.1080p.WEB-DL' }),
    fakeResult({ infoHash: 'b'.repeat(40), title: 'Movie.2024.CAM.枪版' }),
    fakeResult({ infoHash: 'c'.repeat(40), title: 'Movie.2024.TS' }),
  ];

  const filtered = filterResults(list, { exclude: ['cam', 'ts'] });
  assert.deepEqual(filtered.map((item) => item.title), ['Movie.2024.1080p.WEB-DL']);
});

test('filterResults：多个条件叠加', () => {
  const list = [
    fakeResult({ infoHash: 'a'.repeat(40), title: 'good 1080p', seeders: 30, adult: false }),
    fakeResult({ infoHash: 'b'.repeat(40), title: 'good 1080p cam', seeders: 30, adult: false }),
    fakeResult({ infoHash: 'c'.repeat(40), title: 'good 1080p', seeders: 1, adult: false }),
    fakeResult({ infoHash: 'd'.repeat(40), title: 'good 1080p', seeders: 30, adult: true }),
  ];

  const filtered = filterResults(list, { minSeeders: 10, exclude: ['cam'], safe: true });
  assert.deepEqual(filtered.map((item) => item.title), ['good 1080p']);
  assert.equal(filtered[0].infoHash, 'a'.repeat(40));
});

test('searchAll：过滤后 total 变小，totalBeforeFilter 保留原始条数', async () => {
  const sources = [
    fakeSource('many', [
      fakeResult({ infoHash: 'a'.repeat(40), title: 'keep me', seeders: 100 }),
      fakeResult({ infoHash: 'b'.repeat(40), title: 'drop by seeders', seeders: 1 }),
      fakeResult({ infoHash: 'c'.repeat(40), title: 'drop by exclude cam', seeders: 100 }),
      fakeResult({ infoHash: 'd'.repeat(40), title: 'drop by safe', seeders: 100, adult: true }),
    ]),
  ];

  const result = await searchAll({
    query: 'x',
    sources,
    minSeeders: 10,
    exclude: 'cam',
    safe: true,
    ...ctx(),
  });

  assert.equal(result.totalBeforeFilter, 4);
  assert.equal(result.total, 1);
  assert.equal(result.results[0].title, 'keep me');
  assert.deepEqual(result.filters, { minSeeders: 10, exclude: ['cam'], safe: true });
  assert.equal(result.cached, false);
});

test('searchAll：不传过滤条件时 filters 回显默认值', async () => {
  const result = await searchAll({ query: 'x', sources: [fakeSource('s', [])], ...ctx() });
  assert.deepEqual(result.filters, { minSeeders: 0, exclude: [], safe: false });
  assert.equal(result.totalBeforeFilter, 0);
});

test('searchAll：默认不启用结果缓存（每次都真的请求）', async () => {
  clearSearchCache();
  let calls = 0;
  const source = {
    id: 'counter',
    name: 'Counter',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async () => {
      calls += 1;
      return [];
    },
  };

  await searchAll({ query: 'cache-off', sources: [source], ...ctx() });
  await searchAll({ query: 'cache-off', sources: [source], ...ctx() });

  assert.equal(calls, 2);
  assert.equal(searchCacheSize(), 0);
});

test('searchAll：cacheTtlMs > 0 时命中缓存并标记 cached', async () => {
  clearSearchCache();
  let calls = 0;
  const source = {
    id: 'counter',
    name: 'Counter',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async () => {
      calls += 1;
      return [fakeResult({ infoHash: 'a'.repeat(40), title: 'cached item', seeders: 5 })];
    },
  };

  const first = await searchAll({ query: 'cache-on', sources: [source], cacheTtlMs: 60_000, ...ctx() });
  const second = await searchAll({ query: 'cache-on', sources: [source], cacheTtlMs: 60_000, ...ctx() });

  assert.equal(calls, 1, '第二次应该命中缓存');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.total, 1);
  assert.equal(second.results[0].title, 'cached item');
  assert.equal(second.sources[0].cached, true);
  assert.equal(second.sources[0].count, 1);
  assert.equal(searchCacheSize(), 1);

  clearSearchCache();
});

test('searchAll：缓存过期后重新请求', async () => {
  clearSearchCache();
  let calls = 0;
  const source = {
    id: 'ttl',
    name: 'TTL',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async () => {
      calls += 1;
      return [];
    },
  };

  await searchAll({ query: 'ttl', sources: [source], cacheTtlMs: 1, ...ctx() });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await searchAll({ query: 'ttl', sources: [source], cacheTtlMs: 1, ...ctx() });

  assert.equal(calls, 2, '过期后应重新请求');
  clearSearchCache();
});

test('searchAll：bypassCache 跳过读取但仍刷新缓存', async () => {
  clearSearchCache();
  let calls = 0;
  const source = {
    id: 'bypass',
    name: 'Bypass',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async () => {
      calls += 1;
      return [];
    },
  };

  await searchAll({ query: 'bypass', sources: [source], cacheTtlMs: 60_000, ...ctx() });
  const forced = await searchAll({ query: 'bypass', sources: [source], cacheTtlMs: 60_000, bypassCache: true, ...ctx() });
  const after = await searchAll({ query: 'bypass', sources: [source], cacheTtlMs: 60_000, ...ctx() });

  assert.equal(calls, 2, 'bypass 时应重新请求');
  assert.equal(forced.cached, false);
  assert.equal(after.cached, true, 'bypass 之后的请求应该又能命中刷新过的缓存');

  clearSearchCache();
});

test('searchAll：缓存键区分关键词、源集合与每源抓取条数', async () => {
  clearSearchCache();
  let calls = 0;
  const source = {
    id: 'keyed',
    name: 'Keyed',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async () => {
      calls += 1;
      return [];
    },
  };

  await searchAll({ query: 'a', sources: [source], pageSize: 20, cacheTtlMs: 60_000, ...ctx() });
  await searchAll({ query: 'b', sources: [source], pageSize: 20, cacheTtlMs: 60_000, ...ctx() });
  // page: 10 → 每源 200 条（下限是 100，所以要用更大的页码才能拉开抓取条数）
  await searchAll({ query: 'a', sources: [source], pageSize: 20, page: 10, cacheTtlMs: 60_000, ...ctx() });

  assert.equal(calls, 3, '不同关键词/不同抓取条数不应共用缓存');
  assert.equal(searchCacheSize(), 3);

  await searchAll({ query: 'a', sources: [source], pageSize: 20, cacheTtlMs: 60_000, ...ctx() });
  assert.equal(calls, 3, '相同条件应命中缓存');

  clearSearchCache();
  assert.equal(searchCacheSize(), 0);
});

test('searchAll：缓存命中时过滤条件依然生效（缓存的是原始结果）', async () => {
  clearSearchCache();
  const source = fakeSource('filtered', [
    fakeResult({ infoHash: 'a'.repeat(40), title: 'keep', seeders: 50 }),
    fakeResult({ infoHash: 'b'.repeat(40), title: 'drop cam', seeders: 50 }),
  ]);

  await searchAll({ query: 'f', sources: [source], cacheTtlMs: 60_000, ...ctx() });
  const second = await searchAll({ query: 'f', sources: [source], cacheTtlMs: 60_000, exclude: 'cam', ...ctx() });

  assert.equal(second.cached, true);
  assert.equal(second.totalBeforeFilter, 2);
  assert.equal(second.total, 1);
  assert.equal(second.results[0].title, 'keep');

  clearSearchCache();
});

test('searchAll：缓存键包含 sort，不同排序的候选池不会互相复用', async () => {
  clearSearchCache();

  // 模拟真实站点行为：排序参数改变的是「返回哪一批结果」，而不只是顺序
  // （BitSearch 实测：sort=seeders 的候选池做种中位数 57，sort=size 只有 1）
  const pools = {
    seeders: [fakeResult({ infoHash: 'a'.repeat(40), title: 'alive torrent', seeders: 500 })],
    size: [fakeResult({ infoHash: 'b'.repeat(40), title: 'huge dead torrent', seeders: 0, size: 10 ** 12 })],
  };
  let calls = 0;
  const source = {
    id: 'pooled',
    name: 'Pooled',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async (query, context) => {
      calls += 1;
      return pools[context.sort] ?? pools.seeders;
    },
  };

  const bySeeders = await searchAll({ query: 'pool', sources: [source], sort: 'seeders', cacheTtlMs: 60_000, ...ctx() });
  const bySize = await searchAll({ query: 'pool', sources: [source], sort: 'size', cacheTtlMs: 60_000, ...ctx() });

  assert.deepEqual(bySeeders.results.map((r) => r.title), ['alive torrent']);
  assert.deepEqual(bySize.results.map((r) => r.title), ['huge dead torrent']);
  assert.equal(calls, 2, '不同 sort 不应复用同一个缓存条目');

  // 各自再请求一次：应命中各自的缓存，且结果不串味
  const seedersAgain = await searchAll({ query: 'pool', sources: [source], sort: 'seeders', cacheTtlMs: 60_000, ...ctx() });
  const sizeAgain = await searchAll({ query: 'pool', sources: [source], sort: 'size', cacheTtlMs: 60_000, ...ctx() });

  assert.equal(calls, 2);
  assert.equal(seedersAgain.cached, true);
  assert.deepEqual(seedersAgain.results.map((r) => r.title), ['alive torrent']);
  assert.deepEqual(sizeAgain.results.map((r) => r.title), ['huge dead torrent']);

  clearSearchCache();
});

test('searchAll：过滤条件作用于候选池（池子里没有高做种项时结果为空，如实反映数据）', async () => {
  clearSearchCache();

  const source = fakeSource('lowseeded', [
    fakeResult({ infoHash: 'a'.repeat(40), title: 'dead one', seeders: 0 }),
    fakeResult({ infoHash: 'b'.repeat(40), title: 'dead two', seeders: 1 }),
  ]);

  const result = await searchAll({ query: 'x', sources: [source], minSeeders: 50, ...ctx() });

  assert.equal(result.totalBeforeFilter, 2);
  assert.equal(result.total, 0);
  // 过滤前后都能拿到条数，界面才能提示"是被过滤掉的"而不是"没有资源"
  assert.deepEqual(result.filters, { minSeeders: 50, exclude: [], safe: false });
});
