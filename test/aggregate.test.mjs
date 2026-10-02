import test from 'node:test';
import assert from 'node:assert/strict';

import { searchAll, searchOne, mergeResults, sortResults, scoreResult, describeError, selectSources } from '../src/aggregate.mjs';
import { fakeResult, fakeSource, memoryCache } from './helpers.mjs';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function ctx() {
  return { http: {}, cache: memoryCache(), logger: () => {} };
}

test('mergeResults：同一 info hash 跨源合并，字段取最有用的一边', () => {
  const merged = mergeResults([
    fakeResult({ source: 'apibay', infoHash: HASH_A, title: '短标题', seeders: 5, leechers: 1, size: null, sizeText: null }),
    fakeResult({
      source: 'bitsearch',
      infoHash: HASH_A,
      title: '更长更完整的标题 1080p',
      seeders: 42,
      leechers: 7,
      size: 2048,
      sizeText: '2.00 KiB',
      magnet: `magnet:?xt=urn:btih:${HASH_A}&dn=x`,
      publishedAt: '2024-01-01T00:00:00.000Z',
    }),
  ]);

  assert.equal(merged.length, 1);
  const [item] = merged;
  assert.deepEqual(item.sources, ['apibay', 'bitsearch']);
  assert.equal(item.seeders, 42);
  assert.equal(item.leechers, 7);
  assert.equal(item.size, 2048);
  assert.equal(item.sizeText, '2.00 KiB');
  assert.equal(item.title, '更长更完整的标题 1080p');
  assert.equal(item.publishedAt, '2024-01-01T00:00:00.000Z');
  assert.ok(item.magnet);
});

test('mergeResults：没有 hash 时用「标题+体积」兜底去重', () => {
  const merged = mergeResults([
    fakeResult({ source: 'a', infoHash: null, title: 'Same.Movie.2024.1080p', size: 100 }),
    fakeResult({ source: 'b', infoHash: null, title: 'same movie 2024 1080p', size: 100 }),
    fakeResult({ source: 'c', infoHash: null, title: 'Same.Movie.2024.1080p', size: 999 }),
  ]);

  // 前两条标题归一化后相同且体积相同 → 合并；第三条体积不同 → 保留
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].sources, ['a', 'b']);
});

test('mergeResults：跳过空标题与空值', () => {
  assert.deepEqual(mergeResults([null, undefined, { source: 'x', title: '' }]), []);
});

test('sortResults：四种排序都符合预期', () => {
  const items = [
    { ...fakeResult({ infoHash: HASH_A }), seeders: 1, size: 300, publishedAt: '2020-01-01T00:00:00.000Z', score: 10 },
    { ...fakeResult({ infoHash: HASH_B }), seeders: 99, size: 100, publishedAt: '2024-01-01T00:00:00.000Z', score: 50 },
  ];

  assert.deepEqual(sortResults(items, 'seeders').map((i) => i.seeders), [99, 1]);
  assert.deepEqual(sortResults(items, 'size').map((i) => i.size), [300, 100]);
  assert.deepEqual(sortResults(items, 'date').map((i) => i.publishedAt), ['2024-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z']);
  assert.deepEqual(sortResults(items, 'relevance').map((i) => i.score), [50, 10]);
});

test('sortResults：支持 leechers 排序与 asc 方向', () => {
  const items = [
    { ...fakeResult({ infoHash: HASH_A }), seeders: 1, leechers: 5, size: 300 },
    { ...fakeResult({ infoHash: HASH_B }), seeders: 99, leechers: 40, size: 100 },
  ];

  assert.deepEqual(sortResults(items, 'leechers').map((i) => i.leechers), [40, 5]);
  assert.deepEqual(sortResults(items, 'leechers', 'asc').map((i) => i.leechers), [5, 40]);
  assert.deepEqual(sortResults(items, 'seeders', 'asc').map((i) => i.seeders), [1, 99]);
  assert.deepEqual(sortResults(items, 'size', 'asc').map((i) => i.size), [100, 300]);
  // 这两条没有 score，相关度排序会退化到「做种数」再整体反转
  assert.deepEqual(sortResults(items, 'relevance', 'asc').map((i) => i.seeders), [1, 99]);
});

test('sortResults：未知排序名回退到 relevance，未知方向按 desc', () => {
  const items = [
    { ...fakeResult({ infoHash: HASH_A }), score: 10 },
    { ...fakeResult({ infoHash: HASH_B }), score: 50 },
  ];
  assert.deepEqual(sortResults(items, 'nonsense').map((i) => i.score), [50, 10]);
  assert.deepEqual(sortResults(items, 'seeders', 'sideways').map((i) => i.infoHash), sortResults(items, 'seeders').map((i) => i.infoHash));
});

test('sortResults：日期缺失时按最旧处理，顺序确定', () => {
  const items = [
    { ...fakeResult({ infoHash: HASH_A }), publishedAt: null },
    { ...fakeResult({ infoHash: HASH_B }), publishedAt: 'garbage' },
    { ...fakeResult({ infoHash: 'c'.repeat(40) }), publishedAt: '2024-01-01T00:00:00.000Z' },
  ];

  const desc = sortResults(items, 'date');
  assert.equal(desc[0].publishedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(desc.length, 3);

  const asc = sortResults(items, 'date', 'asc');
  assert.equal(asc[asc.length - 1].publishedAt, '2024-01-01T00:00:00.000Z');
});

test('sortResults：null 值排在最后而不是崩掉', () => {
  const items = [
    { ...fakeResult({ infoHash: HASH_A }), seeders: null, size: null, publishedAt: null },
    { ...fakeResult({ infoHash: HASH_B }), seeders: 3, size: 5, publishedAt: '2024-01-01T00:00:00.000Z' },
  ];
  assert.equal(sortResults(items, 'seeders')[0].seeders, 3);
  assert.equal(sortResults(items, 'size')[0].size, 5);
  assert.equal(sortResults(items, 'date')[0].publishedAt, '2024-01-01T00:00:00.000Z');
});

test('scoreResult：全词命中 + 高做种 + 新鲜度得分更高', () => {
  const now = Date.parse('2024-06-01T00:00:00.000Z');
  const tokens = ['ubuntu', 'server'];

  const good = scoreResult(
    { title: 'Ubuntu Server 24.04', seeders: 500, publishedAt: '2024-05-01T00:00:00.000Z', sources: ['a', 'b'] },
    tokens,
    now,
  );
  const partial = scoreResult(
    { title: 'Ubuntu Desktop 24.04', seeders: 500, publishedAt: '2024-05-01T00:00:00.000Z', sources: ['a'] },
    tokens,
    now,
  );
  const stale = scoreResult(
    { title: 'Ubuntu Server 24.04', seeders: 0, publishedAt: '2015-01-01T00:00:00.000Z', sources: ['a'] },
    tokens,
    now,
  );

  assert.ok(good > partial, `全词命中(${good}) 应高于部分命中(${partial})`);
  assert.ok(good > stale, `有做种(${good}) 应高于无做种(${stale})`);
  assert.ok(good <= 105);
});

test('selectSources：支持 id 列表、default/all 与直接注入源对象', () => {
  assert.ok(selectSources('default').sources.length > 0);
  assert.equal(selectSources('default').sources.some((s) => s.id === 'demo'), false);
  assert.equal(selectSources('all').sources.some((s) => s.id === 'demo'), true);
  assert.deepEqual(selectSources('apibay,nyaa').sources.map((s) => s.id), ['apibay', 'nyaa']);
  assert.deepEqual(selectSources('apibay,nope').unknown, ['nope']);

  const injected = [fakeSource('x', [])];
  assert.equal(selectSources(injected).sources, injected);
});

test('searchAll：正常聚合、按相关度排序、返回源状态', async () => {
  const sources = [
    fakeSource('alpha', [fakeResult({ infoHash: HASH_A, title: 'ubuntu server iso', seeders: 10 })]),
    fakeSource('beta', [fakeResult({ infoHash: HASH_B, title: 'unrelated thing', seeders: 999 })]),
  ];

  const result = await searchAll({ query: 'ubuntu', sources, pageSize: 10, ...ctx() });

  assert.equal(result.query, 'ubuntu');
  assert.equal(result.total, 2);
  assert.equal(result.results[0].title, 'ubuntu server iso'); // 相关度优先于做种数
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every((s) => s.ok));
  assert.deepEqual(result.sources.map((s) => s.count), [1, 1]);
  assert.ok(typeof result.tookMs === 'number');
  // 未注册的源没有中文名，回退成 id（Web UI 契约要求 sourceName 一定存在）
  assert.equal(result.results[0].sourceName, 'alpha');
});

test('searchAll：注册表里的源会带上中文名 sourceName', async () => {
  const result = await searchAll({ query: '巨人', sources: 'demo', ...ctx() });
  assert.equal(result.results[0].sourceName, '演示数据源（离线）');
});

test('searchAll：order=asc 时整体反转，并在响应里回显', async () => {
  const sources = [
    fakeSource('many', [
      fakeResult({ infoHash: 'a'.repeat(40), title: 'low', seeders: 1 }),
      fakeResult({ infoHash: 'b'.repeat(40), title: 'high', seeders: 99 }),
    ]),
  ];

  const desc = await searchAll({ query: 'x', sources, sort: 'seeders', ...ctx() });
  assert.equal(desc.order, 'desc');
  assert.deepEqual(desc.results.map((r) => r.title), ['high', 'low']);

  const asc = await searchAll({ query: 'x', sources, sort: 'seeders', order: 'asc', ...ctx() });
  assert.equal(asc.order, 'asc');
  assert.deepEqual(asc.results.map((r) => r.title), ['low', 'high']);

  // 非法方向按 desc
  const bogus = await searchAll({ query: 'x', sources, sort: 'seeders', order: 'sideways', ...ctx() });
  assert.equal(bogus.order, 'desc');
});

test('searchAll：排序方向参数会透传给数据源（供 BitSearch 这类支持排序的源使用）', async () => {
  const seen = [];
  const spy = {
    id: 'spy-sort',
    name: 'Spy',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async (query, context) => {
      seen.push(context.sort);
      return [];
    },
  };

  await searchAll({ query: 'x', sources: [spy], sort: 'date', ...ctx() });
  await searchAll({ query: 'x', sources: [spy], sort: 'leechers', ...ctx() });

  assert.deepEqual(seen, ['date', 'leechers']);
});

test('searchAll：单个源抛异常不影响其它源，并如实报告失败原因', async () => {
  const sources = [
    fakeSource('good', [fakeResult({ infoHash: HASH_A, title: 'good result' })]),
    fakeSource('bad', [], { error: new Error('连接被重置') }),
  ];

  const result = await searchAll({ query: 'x', sources, ...ctx() });

  assert.equal(result.total, 1);
  assert.equal(result.results[0].source, 'good');

  const bad = result.sources.find((s) => s.id === 'bad');
  assert.equal(bad.ok, false);
  assert.equal(bad.count, 0);
  assert.match(bad.error, /连接被重置/);
});

test('searchAll：源超时被识别为超时（尊重 ctx.signal）', async () => {
  const slowSource = {
    id: 'slow',
    name: 'Slow',
    description: '很慢的源',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: (query, context) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        context.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
        });
      }),
  };

  const result = await searchAll({ query: 'x', sources: [slowSource], timeoutMs: 1000, ...ctx() });

  assert.equal(result.sources[0].ok, false);
  assert.equal(result.sources[0].error, '超时 (1000ms)');
});

test('searchAll：源返回非数组时不崩溃', async () => {
  const weird = { ...fakeSource('weird', []), search: async () => 'not-an-array' };
  const result = await searchAll({ query: 'x', sources: [weird], ...ctx() });
  assert.equal(result.total, 0);
  assert.equal(result.sources[0].ok, true);
  assert.equal(result.sources[0].count, 0);
});

test('searchAll：未知数据源被标记为失败而不是被忽略', async () => {
  const result = await searchAll({ query: 'x', sources: 'nope', ...ctx() });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].ok, false);
  assert.equal(result.sources[0].error, '未知数据源');
});

test('searchAll：分页正确（含最后一页）', async () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    fakeResult({ source: 'many', infoHash: String(index).padStart(40, '0'), title: `item ${index}`, seeders: index }),
  );
  const sources = [fakeSource('many', many)];

  const page1 = await searchAll({ query: '', sources, page: 1, pageSize: 3, ...ctx() });
  assert.equal(page1.total, 10);
  assert.equal(page1.totalPages, 4);
  assert.equal(page1.results.length, 3);

  const page4 = await searchAll({ query: '', sources, page: 4, pageSize: 3, ...ctx() });
  assert.equal(page4.results.length, 1);

  const page9 = await searchAll({ query: '', sources, page: 9, pageSize: 3, ...ctx() });
  assert.equal(page9.results.length, 0);
  assert.equal(page9.total, 10);
});

test('searchAll：limitPerSource 默认随页码增长，便于翻页', async () => {
  let observed = null;
  const spy = {
    id: 'spy',
    name: 'Spy',
    description: '',
    homepage: '',
    kinds: [],
    defaultEnabled: true,
    search: async (query, context) => {
      observed = context.limit;
      return [];
    },
  };

  await searchAll({ query: 'x', sources: [spy], page: 1, pageSize: 20, ...ctx() });
  assert.equal(observed, 50);

  await searchAll({ query: 'x', sources: [spy], page: 5, pageSize: 20, ...ctx() });
  assert.equal(observed, 100);
});

test('searchOne：返回单源状态与样例', async () => {
  const ok = await searchOne(fakeSource('ok', [fakeResult({ infoHash: HASH_A, title: 'sample' })]), 'q', ctx());
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 1);
  assert.equal(ok.sample[0].title, 'sample');

  const failed = await searchOne(fakeSource('bad', [], { error: new Error('403 Forbidden') }), 'q', ctx());
  assert.equal(failed.ok, false);
  assert.match(failed.error, /403/);
});

test('describeError 把各种异常翻译成一句话', () => {
  assert.equal(describeError({ code: 'timeout' }, 8000), '超时 (8000ms)');
  assert.equal(describeError({ code: 'too_large' }, 8000), '响应过大，已放弃');
  assert.equal(describeError({ code: 'bad_proxy', message: '只支持 http/https 代理' }, 8000), '只支持 http/https 代理');
  assert.equal(describeError({ name: 'AbortError' }, 1000), '超时 (1000ms)');
  assert.equal(describeError(new Error('boom'), 1000), 'boom');
  assert.equal(describeError(null, 1000), '未知错误');
});
