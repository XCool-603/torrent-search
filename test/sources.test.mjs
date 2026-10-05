import test from 'node:test';
import assert from 'node:assert/strict';

import apibay from '../src/sources/apibay.mjs';
import nyaa from '../src/sources/nyaa.mjs';
import sukebei from '../src/sources/sukebei.mjs';
import bitsearch from '../src/sources/bitsearch.mjs';
import mikan from '../src/sources/mikan.mjs';
import dmhy from '../src/sources/dmhy.mjs';
import academic from '../src/sources/academic.mjs';
import demo from '../src/sources/demo.mjs';
import { base32ToHex, parseMagnet } from '../src/magnet.mjs';
import { filterResults } from '../src/aggregate.mjs';
import { fixture, stubHttp, memoryCache } from './helpers.mjs';

/** 每个适配器的默认 ctx */
function ctxFor(http, overrides = {}) {
  return { http, cache: memoryCache(), limit: 100, timeoutMs: 5000, signal: undefined, ...overrides };
}

test('apibay：解析 JSON 接口并规范化字段', async () => {
  const http = stubHttp([['apibay.org/q.php', fixture('apibay-ubuntu.json')]]);
  const results = await apibay.search('ubuntu', ctxFor(http));

  assert.equal(results.length, 5);

  const [first] = results;
  assert.equal(first.source, 'apibay');
  assert.equal(first.title, 'Ubuntu 22.04 LTS');
  assert.equal(first.infoHash, '2c6b6858d61da9543d4231a71db4b1c9264b0685');
  assert.equal(first.size, 3_654_957_056);
  assert.equal(first.sizeText, '3.40 GiB');
  assert.equal(first.seeders, 31);
  assert.equal(first.leechers, 1);
  assert.equal(first.category, '软件'); // TPB 的 303 → 软件
  assert.equal(first.publishedAt, new Date(1_652_877_231_000).toISOString());
  assert.equal(first.detailsUrl, 'https://thepiratebay.org/description.php?id=59191690');
  assert.equal(first.torrentUrl, 'https://apibay.org/torrent/59191690');
  assert.equal(first.magnet, 'magnet:?xt=urn:btih:2c6b6858d61da9543d4231a71db4b1c9264b0685&dn=Ubuntu%2022.04%20LTS');
  assert.equal(first.id, 'apibay:2c6b6858d61da9543d4231a71db4b1c9264b0685');
});

test('apibay：无结果占位条目被过滤，返回空数组', async () => {
  const http = stubHttp([['apibay.org/q.php', fixture('apibay-empty.json')]]);
  const results = await apibay.search('zzzz', ctxFor(http));
  assert.deepEqual(results, []);
});

test('apibay：尊重 limit', async () => {
  const http = stubHttp([['apibay.org/q.php', fixture('apibay-ubuntu.json')]]);
  const results = await apibay.search('ubuntu', ctxFor(http, { limit: 2 }));
  assert.equal(results.length, 2);
});

test('apibay：响应不是数组时返回空数组（防站点返回错误对象）', async () => {
  const http = stubHttp([['apibay.org/q.php', '{"error":"rate limited"}']]);
  const results = await apibay.search('ubuntu', ctxFor(http));
  assert.deepEqual(results, []);
});

test('apibay：5xx 分类被标记为成人（安全过滤的依据）', async () => {
  const payload = JSON.stringify([
    {
      id: '1',
      name: 'Adult Category Item',
      info_hash: 'A'.repeat(40),
      leechers: '1',
      seeders: '2',
      size: '100',
      added: '1652877231',
      category: '505',
    },
  ]);

  const http = stubHttp([['apibay.org/q.php', payload]]);
  const [result] = await apibay.search('x', ctxFor(http));

  assert.equal(result.category, '成人');
  assert.equal(result.adult, true);
});

test('apibay：普通分类不会被标记为成人', async () => {
  const http = stubHttp([['apibay.org/q.php', fixture('apibay-ubuntu.json')]]);
  const results = await apibay.search('ubuntu', ctxFor(http));
  assert.equal(results.every((result) => result.adult === false), true);
});

test('nyaa：解析 RSS 的命名空间标签', async () => {
  const http = stubHttp([['nyaa.si', fixture('nyaa-ubuntu.xml')]]);
  const results = await nyaa.search('ubuntu', ctxFor(http));

  assert.equal(results.length, 1);

  const [first] = results;
  assert.equal(first.source, 'nyaa');
  assert.equal(first.title, 'Koha Live CD Release 3 (3.0.4 Ubuntu 9.10 Desktop x86)');
  assert.equal(first.infoHash, '45008e48c8800b7d7643337b2e70a634e4c69f6a');
  assert.equal(first.size, 624 * 1024 ** 2);
  assert.equal(first.sizeText, '624.00 MiB');
  assert.equal(first.seeders, 0);
  assert.equal(first.category, 'Software - Applications');
  assert.equal(first.detailsUrl, 'https://nyaa.si/view/96659');
  assert.equal(first.torrentUrl, 'https://nyaa.si/download/96659.torrent');
});

test('bitsearch：解析 JSON API 并把 hash 统一成小写', async () => {
  const http = stubHttp([['bitsearch.to/api', fixture('bitsearch-ubuntu.json')]]);
  const results = await bitsearch.search('ubuntu', ctxFor(http));

  assert.equal(results.length, 5);

  const [first] = results;
  assert.equal(first.title, 'ubuntu-24.04.2-desktop-amd64.iso');
  assert.equal(first.infoHash, '611f70899d4e1d6a9c39cfc925f103dfef630328');
  assert.equal(first.size, 6_343_219_200);
  assert.equal(first.seeders, 165);
  assert.equal(first.leechers, 311);
  assert.equal(first.detailsUrl, 'https://bitsearch.to/torrent/68131baea48761f7a5a37bd9');
  assert.equal(first.torrentUrl, null);
  assert.ok(first.publishedAt.startsWith('2026-10-01T12:46:00'));
});

test('bitsearch：success=false 或缺少 results 时返回空数组', async () => {
  const http = stubHttp([['bitsearch.to/api', '{"success":false,"results":null}']]);
  const results = await bitsearch.search('x', ctxFor(http));
  assert.deepEqual(results, []);
});

test('bitsearch：分类编号按该站自己的分类表中文化', async () => {
  const http = stubHttp([['bitsearch.to/api', fixture('bitsearch-ubuntu.json')]]);
  const results = await bitsearch.search('ubuntu', ctxFor(http));

  // 夹具里的 category=1 → 其他
  assert.equal(results[0].category, '其他');
  assert.equal(results[0].adult, false);
});

test('bitsearch：category=10 被标记为成人', async () => {
  const payload = JSON.stringify({
    success: true,
    results: [{ id: 'x', infohash: 'A'.repeat(40), title: 'Adult Item', size: 1, category: 10, seeders: 1, leechers: 0 }],
  });

  const http = stubHttp([['bitsearch.to/api', payload]]);
  const [result] = await bitsearch.search('x', ctxFor(http));

  assert.equal(result.category, '成人');
  assert.equal(result.adult, true);
});

test('bitsearch：候选池固定按做种数抓取，不把用户排序透传给该站', async () => {
  const http = stubHttp([['bitsearch.to/api', fixture('bitsearch-ubuntu.json')]]);

  // 实测：该站 sort=size 会返回一批做种中位数只有 1 的结果（几乎全是死种），
  // 透传排序会让 --min-seeders 这类过滤直接返回空，所以候选池固定用 seeders。
  for (const sort of ['date', 'size', 'leechers', 'relevance', undefined]) {
    await bitsearch.search('ubuntu', ctxFor(http, { sort }));
  }

  for (const url of http.calls) {
    assert.match(url, /sort=seeders/, `请求应固定使用 sort=seeders：${url}`);
    assert.doesNotMatch(url, /sort=(created|size|leechers|relevance)/);
  }

  assert.match(http.calls[0], /limit=100/);
  assert.equal(bitsearch._poolSort, 'seeders');
});

test('mikan：Episode 编号被当作 info hash，并读出嵌套的 contentLength', async () => {
  const http = stubHttp([['mikanani.me', fixture('mikan-shingeki.xml')]]);
  const results = await mikan.search('进击的巨人', ctxFor(http));

  assert.equal(results.length, 3);

  const [first] = results;
  assert.equal(first.source, 'mikan');
  assert.equal(first.infoHash, 'c2018b52e9e0dd17dd378ed8ff7b28e3717fdaa2');
  assert.equal(first.size, 3_865_470_464);
  assert.equal(first.sizeText, '3.60 GiB');
  assert.equal(first.seeders, null); // 站点不提供，保持 null 而不是编造 0
  assert.equal(first.publishedAt, '2026-08-11T10:47:25.461Z');
  assert.equal(first.detailsUrl, 'https://mikanani.me/Home/Episode/c2018b52e9e0dd17dd378ed8ff7b28e3717fdaa2');
  assert.equal(first.torrentUrl, 'https://mikanani.me/Download/20260811/c2018b52e9e0dd17dd378ed8ff7b28e3717fdaa2.torrent');
  assert.equal(first.magnet, `magnet:?xt=urn:btih:c2018b52e9e0dd17dd378ed8ff7b28e3717fdaa2&dn=${encodeURIComponent(first.title)}`);
});

test('mikan：_hashFromLink 只认 40 位 hex 的 Episode 链接', () => {
  assert.equal(mikan._hashFromLink('https://mikanani.me/Home/Episode/c2018b52e9e0dd17dd378ed8ff7b28e3717fdaa2'), 'c2018b52e9e0dd17dd378ed8ff7b28e3717fdaa2');
  assert.equal(mikan._hashFromLink('https://mikanani.me/Home/Episode/xyz'), null);
  assert.equal(mikan._hashFromLink(null), null);
});

test('dmhy：Base32 磁力被归一化成 40 位 hex（跨站去重的关键）', async () => {
  const http = stubHttp([['share.dmhy.org', fixture('dmhy-shingeki.xml')]]);
  const results = await dmhy.search('进击的巨人', ctxFor(http));

  assert.equal(results.length, 3);

  const [first] = results;
  assert.equal(first.source, 'dmhy');
  assert.equal(first.infoHash, base32ToHex('EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI'));
  assert.match(first.infoHash, /^[0-9a-f]{40}$/);
  assert.equal(first.category, '季度全集');
  assert.equal(first.size, null); // 站点不给体积
  assert.equal(first.seeders, null);
  assert.ok(first.magnet.startsWith('magnet:?xt=urn:btih:EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI&'));
  assert.equal(first.detailsUrl, 'http://share.dmhy.org/topics/view/724610_7_ACG_THE_LAST_ATTACK_Shingeki_no_Kyojin_Movie_The_Last_Attack_2024_BDrip_1080p_x265_OPUS_2_0.html');

  // 磁力里的 hash 必须与 infoHash 一致（否则去重键就错了）
  assert.equal(parseMagnet(first.magnet).infoHash, first.infoHash);
});

test('academic：从全量数据库里本地检索，AND 匹配优先', async () => {
  const body = fixture('academic-database.xml');
  const entries = academic._parseDatabase(body);

  assert.equal(entries.length, 5);
  assert.equal(entries[0].title, 'Celebrity in Places');
  assert.equal(entries[0].infoHash, '04200d16ba377e1bc0c5690d87ee047e1e70a5b5');
  assert.equal(entries[0].size, '1976719940');
  assert.equal(entries[0].category, 'Dataset');

  // 全部关键词命中
  const all = academic._searchEntries(entries, 'celebrity places', 10);
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'Celebrity in Places');

  // 只命中部分关键词时仍然返回（降级召回），但排在后面
  const partial = academic._searchEntries(entries, 'celebrity zzzznotexist', 10);
  assert.equal(partial.length, 1);

  // 完全不命中
  assert.deepEqual(academic._searchEntries(entries, 'zzzznotexist', 10), []);
});

test('academic：走缓存 + 产出规范结果', async () => {
  const http = stubHttp([['academictorrents.com/database.xml', fixture('academic-database.xml')]]);
  const cache = memoryCache({ body: fixture('academic-database.xml') });

  const results = await academic.search('celebrity places', ctxFor(http, { cache }));

  assert.equal(results.length, 1);
  const [first] = results;
  assert.equal(first.source, 'academic');
  assert.equal(first.infoHash, '04200d16ba377e1bc0c5690d87ee047e1e70a5b5');
  assert.equal(first.size, 1_976_719_940);
  assert.equal(first.torrentUrl, 'https://academictorrents.com/download/04200d16ba377e1bc0c5690d87ee047e1e70a5b5.torrent');
  assert.equal(first.publishedAt, null); // 数据库没有时间字段
});

test('demo：离线、确定性、可按关键词过滤', async () => {
  const all = await demo.search('', { limit: 100 });
  assert.equal(all.length, 10);

  const giant = await demo.search('巨人', { limit: 100 });
  assert.equal(giant.length, 1);
  assert.match(giant[0].title, /进击的巨人/);
  assert.match(giant[0].infoHash, /^[0-9a-f]{40}$/);

  // 确定性：两次调用结果一致
  const again = await demo.search('巨人', { limit: 100 });
  assert.deepEqual(again.map((r) => r.id), giant.map((r) => r.id));

  assert.deepEqual(await demo.search('zzzznotexist', { limit: 100 }), []);
});

test('sukebei：解析成人分站的 RSS，并把结果全部标记为成人', async () => {
  const http = stubHttp([['sukebei.nyaa.si', fixture('sukebei-wuma.xml')]]);
  const results = await sukebei.search('无码', ctxFor(http));

  assert.ok(results.length > 50, `夹具应有大量条目，实际 ${results.length}`);

  const [first] = results;
  assert.equal(first.source, 'sukebei');
  assert.ok(first.title.length > 0);
  assert.match(first.infoHash, /^[0-9a-f]{40}$/);

  // 关键行为：整站都是成人内容，必须逐条标记，否则「安全过滤」形同虚设
  assert.equal(results.every((result) => result.adult === true), true);
});

test('sukebei：结果会被安全过滤排除（与 apibay 成人分类一致）', async () => {
  const http = stubHttp([['sukebei.nyaa.si', fixture('sukebei-wuma.xml')]]);
  const results = await sukebei.search('无码', ctxFor(http));

  const kept = filterResults(results, { safe: false });
  const dropped = filterResults(results, { safe: true });

  assert.equal(kept.length, results.length, '不开安全过滤时应全部保留');
  assert.equal(dropped.length, 0, '开安全过滤后应一条不剩');
});

test('所有适配器都满足统一契约', async () => {
  const modules = [apibay, nyaa, sukebei, bitsearch, mikan, dmhy, academic, demo];
  for (const source of modules) {
    assert.equal(typeof source.id, 'string', `${source.id} 缺少 id`);
    assert.equal(typeof source.name, 'string');
    assert.equal(typeof source.description, 'string');
    assert.equal(typeof source.search, 'function');
    assert.ok(Array.isArray(source.kinds));
    assert.equal(typeof source.defaultEnabled, 'boolean');
  }

  // demo 必须默认关闭，避免污染真实搜索
  assert.equal(demo.defaultEnabled, false);
});
