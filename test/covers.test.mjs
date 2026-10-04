import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanTitle,
  coverKey,
  createCoverFinder,
  createLimiter,
  parseKitsu,
  parseTvmaze,
  parseWikipedia,
  providersFor,
  titleMatches,
} from '../src/covers.mjs';
import { startServer } from '../src/server.mjs';
import { memoryCache } from './helpers.mjs';

/* ------------------------------------------------------------------ */
/* 标题清洗                                                            */
/* ------------------------------------------------------------------ */

test('cleanTitle：常见种子标题都能洗出片名', () => {
  const cases = [
    ['[Skymoon-Raws] 進撃の巨人 - 01 [1080p][x265]', '進撃の巨人'],
    // 片名本身在方括号里——早期版本会把整条清成空串
    ['[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPTC]', 'Sousou no Frieren'],
    ['[VCB-Studio] Violet Evergarden [01][Ma10p_1080p][x265_flac]', 'Violet Evergarden'],
    ['The Matrix 1999 1080p BluRay x264 DTS-FGT', 'The Matrix 1999'],
    ['Breaking.Bad.S01E05.1080p.WEB-DL.AAC2.0.H.264-NTb', 'Breaking Bad'],
    ['Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-TRiToN', 'Interstellar 2014'],
    // 季/篇标记处截断：只留主标题，否则拿整串去查封面必然查不到
    ['进击的巨人 第三季 [01-12合集][1080p][简繁中字]', '进击的巨人'],
    ['【高清影视之家发布 www.HDBTHD.com】进击的巨人 最终季 完结篇 后篇[简繁英字幕].Attack.on.Titan.S04.Part3.2023.', '进击的巨人'],
    // 多语言标题取第一段
    ['[VCB-Studio] 进击的巨人 / Shingeki no Kyojin / Attack on Titan / 進撃の巨人 10-bit 1080p HEVC', '进击的巨人'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(cleanTitle(input), expected, `清洗「${input}」`);
  }
});

test('cleanTitle：保留版本号里的点（24.04 不该变成 24 04）', () => {
  assert.equal(cleanTitle('Ubuntu 24.04 LTS Desktop amd64.iso'), 'Ubuntu 24.04 LTS Desktop amd64');
});

test('cleanTitle：没有有效片名时返回空串', () => {
  for (const input of ['', '   ', '[1080p]', '[x265][AAC]', '12345', null, undefined]) {
    assert.equal(cleanTitle(input), '', `「${input}」应判为无有效片名`);
  }
});

/* ------------------------------------------------------------------ */
/* 匹配校验：错封面比没封面更糟                                          */
/* ------------------------------------------------------------------ */

test('titleMatches：拒绝模糊搜索给出的错误结果', () => {
  const cases = [
    ['The Matrix 1999', 'The Animatrix', false], // 实测 Kitsu 真会这么匹配
    ['Ubuntu 24.04 LTS Desktop amd64', 'Ubuntu', false],
    ['The Matrix 1999', 'The Matrix', true],
    ['Interstellar 2014', 'Interstellar', true], // 年份不算身份特征
    ['Sousou no Frieren', 'Sousou no Frieren', true],
    ['進撃の巨人', '進撃の巨人 第三季', true],
    ['Violet Evergarden', 'Violet Evergarden: The Movie', true],
    ['', 'anything', false],
  ];

  for (const [query, matched, expected] of cases) {
    assert.equal(titleMatches(query, matched), expected, `${query} vs ${matched}`);
  }
});

/* ------------------------------------------------------------------ */
/* 数据源选择                                                          */
/* ------------------------------------------------------------------ */

test('providersFor：按标题特征把最可能的源排在前面', () => {
  const first = (title) => providersFor(cleanTitle(title), title)[0].id;

  assert.equal(first('[Nekomoe kissaten][Sousou no Frieren][01][1080p]'), 'kitsu');
  assert.equal(first('进击的巨人 第三季 [01-12合集]'), 'kitsu');
  assert.equal(first('Breaking.Bad.S01E05.1080p.WEB-DL'), 'tvmaze');
  assert.equal(first('The Matrix 1999 1080p BluRay x264'), 'wikipedia');

  // 每个源都要出现在候选里，保证降级链完整
  const all = providersFor('The Matrix 1999', 'The Matrix 1999').map((provider) => provider.id);
  assert.equal(new Set(all).size, 3);
});

/* ------------------------------------------------------------------ */
/* 各源响应解析                                                        */
/* ------------------------------------------------------------------ */

test('parseKitsu：取海报并给出站点链接', () => {
  const parsed = parseKitsu({
    data: [
      {
        attributes: {
          canonicalTitle: 'Sousou no Frieren',
          slug: 'sousou-no-frieren',
          posterImage: { medium: 'https://media.kitsu.io/anime/poster_images/46474/medium.jpg' },
        },
      },
    ],
  });

  assert.equal(parsed.imageUrl, 'https://media.kitsu.io/anime/poster_images/46474/medium.jpg');
  assert.equal(parsed.matchedTitle, 'Sousou no Frieren');
  assert.equal(parsed.pageUrl, 'https://kitsu.io/anime/sousou-no-frieren');
});

test('parseKitsu：空结果或缺图时返回 null', () => {
  assert.equal(parseKitsu({ data: [] }), null);
  assert.equal(parseKitsu({ data: [{ attributes: { posterImage: {} } }] }), null);
  assert.equal(parseKitsu(null), null);
  // 非 https 一律拒绝
  assert.equal(parseKitsu({ data: [{ attributes: { posterImage: { medium: 'http://x/y.jpg' } } }] }), null);
});

test('parseTvmaze：取剧集图片', () => {
  const parsed = parseTvmaze([
    { show: { name: 'Breaking Bad', url: 'https://www.tvmaze.com/shows/169/breaking-bad', image: { medium: 'https://static.tvmaze.com/x.jpg' } } },
  ]);
  assert.equal(parsed.imageUrl, 'https://static.tvmaze.com/x.jpg');
  assert.equal(parsed.matchedTitle, 'Breaking Bad');
});

test('parseTvmaze：无图或空结果返回 null', () => {
  assert.equal(parseTvmaze([]), null);
  assert.equal(parseTvmaze([{ show: { name: 'x', image: null } }]), null);
});

test('parseWikipedia：取缩略图并去掉跟踪参数', () => {
  const parsed = parseWikipedia({
    type: 'standard',
    title: 'The Matrix',
    thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/d/db/The_Matrix.png?utm_source=en.wikipedia.org' },
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/The_Matrix' } },
  });

  assert.equal(parsed.imageUrl, 'https://upload.wikimedia.org/wikipedia/en/d/db/The_Matrix.png');
  assert.equal(parsed.matchedTitle, 'The Matrix');
  assert.equal(parsed.pageUrl, 'https://en.wikipedia.org/wiki/The_Matrix');
});

test('parseWikipedia：消歧义页与无图页返回 null', () => {
  assert.equal(parseWikipedia({ type: 'disambiguation', thumbnail: { source: 'https://x/y.png' } }), null);
  assert.equal(parseWikipedia({ type: 'standard', title: 'x' }), null);
});

/* ------------------------------------------------------------------ */
/* 限流器                                                              */
/* ------------------------------------------------------------------ */

test('createLimiter：串行执行且遵守最小间隔', async () => {
  const limit = createLimiter(40);
  const order = [];
  const started = Date.now();

  await Promise.all([
    limit(async () => {
      order.push('a');
    }),
    limit(async () => {
      order.push('b');
    }),
    limit(async () => {
      order.push('c');
    }),
  ]);

  assert.deepEqual(order, ['a', 'b', 'c'], '应按提交顺序串行');
  assert.ok(Date.now() - started >= 80, '三次调用至少要等两个间隔（约 80ms）');
});

test('createLimiter：某个任务抛错不会卡住后续任务', async () => {
  const limit = createLimiter(1);
  await assert.rejects(() => limit(async () => {
    throw new Error('boom');
  }));
  assert.equal(await limit(async () => 'ok'), 'ok');
});

/* ------------------------------------------------------------------ */
/* 查找器：用假 http / 假缓存驱动                                        */
/* ------------------------------------------------------------------ */

/**
 * 造一个假 http 客户端：按 URL 返回预置响应，并记录调用次数。
 *
 * @param {Record<string, {status?: number, body: any}>} routes
 */
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async request(url, options = {}) {
      calls.push({ url, options });
      const route = routes[url];
      if (!route) return { status: 404, headers: {}, body: Buffer.from('{}'), url };
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return { status: route.status ?? 200, headers: route.headers ?? { 'content-type': 'application/json' }, body: Buffer.from(body), url };
    },
  };
}

test('createCoverFinder：命中后写缓存，第二次不再请求', async () => {
  const title = 'Sousou no Frieren';
  const kitsuUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`;
  const http = fakeHttp({
    [kitsuUrl]: {
      body: { data: [{ attributes: { canonicalTitle: title, posterImage: { medium: 'https://media.kitsu.io/a.jpg' } } }] },
    },
  });

  const finder = createCoverFinder({ http, cache: memoryCache(), logger: () => {} });
  const first = await finder.lookup(`[Nekomoe kissaten][${title}][01][1080p]`);

  assert.ok(first, '应命中封面');
  assert.equal(first.provider, 'kitsu');
  assert.equal(first.imageUrl, 'https://media.kitsu.io/a.jpg');
  assert.equal(first.key, coverKey(title));

  const callsAfterFirst = http.calls.length;
  const second = await finder.lookup(`[Nekomoe kissaten][${title}][01][1080p]`);
  assert.equal(second.provider, 'kitsu');
  assert.equal(http.calls.length, callsAfterFirst, '第二次应命中缓存，不再发请求');
});

test('createCoverFinder：源返回错误片名时降级到下一个源', async () => {
  const title = 'The Matrix 1999';
  const http = fakeHttp({
    // 维基先被查到，但返回的是别的条目
    [`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, '_'))}`]: {
      body: { type: 'standard', title: 'The Animatrix', thumbnail: { source: 'https://upload.wikimedia.org/wrong.png' } },
    },
    [`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`]: {
      body: { data: [{ attributes: { canonicalTitle: 'The Animatrix', posterImage: { medium: 'https://media.kitsu.io/wrong.jpg' } } }] },
    },
    [`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`]: { body: [] },
  });

  const finder = createCoverFinder({ http, cache: memoryCache(), logger: () => {} });
  const result = await finder.lookup(title);

  assert.equal(result, null, '三个源都没有真正匹配的条目 → 不给封面');
  assert.equal(http.calls.length >= 2, true, '应依次尝试多个源');
});

test('createCoverFinder：未命中会写负缓存（短时间内不再重试）', async () => {
  const title = 'Ubuntu 24.04 LTS Desktop amd64';
  const http = fakeHttp({});
  const cache = memoryCache();
  const finder = createCoverFinder({ http, cache, logger: () => {} });

  assert.equal(await finder.lookup(title), null);
  const callsAfterFirst = http.calls.length;
  assert.ok(callsAfterFirst > 0, '第一次应该真的查过');

  assert.equal(await finder.lookup(title), null);
  assert.equal(http.calls.length, callsAfterFirst, '负缓存生效，不再重复查');
});

test('createCoverFinder：关闭后不做任何查询', async () => {
  const http = fakeHttp({});
  const finder = createCoverFinder({ http, cache: memoryCache(), enabled: false, logger: () => {} });

  assert.equal(await finder.lookup('The Matrix 1999'), null);
  assert.equal(http.calls.length, 0);
  assert.equal(await finder.image('0'.repeat(20)), null);
});

test('createCoverFinder.image：取图并缓存字节，非法 key 直接拒绝', async () => {
  const title = 'Sousou no Frieren';
  const imageUrl = 'https://media.kitsu.io/a.jpg';
  const http = fakeHttp({
    [`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`]: {
      body: { data: [{ attributes: { canonicalTitle: title, posterImage: { medium: imageUrl } } }] },
    },
    [imageUrl]: { status: 200, headers: { 'content-type': 'image/jpeg' }, body: 'FAKEJPEG' },
  });

  const finder = createCoverFinder({ http, cache: memoryCache(), logger: () => {} });
  const hit = await finder.lookup(title);

  const image = await finder.image(hit.key);
  assert.equal(image.contentType, 'image/jpeg');
  assert.equal(image.body.toString(), 'FAKEJPEG');

  const callsAfterImage = http.calls.length;
  const again = await finder.image(hit.key);
  assert.equal(again.body.toString(), 'FAKEJPEG');
  assert.equal(http.calls.length, callsAfterImage, '图片字节应命中缓存');

  // 安全：未知 key / 非法 key 一律不查
  assert.equal(await finder.image('a'.repeat(20)), null);
  assert.equal(await finder.image('../../etc/passwd'), null);
  assert.equal(await finder.image('short'), null);
  assert.equal(http.calls.length, callsAfterImage, '非法 key 不该触发任何请求');
});

/* ------------------------------------------------------------------ */
/* 服务端接口                                                          */
/* ------------------------------------------------------------------ */

/** 假的封面查找器，用于接口层测试。 */
function fakeFinder(options = {}) {
  const images = new Map([
    ['0'.repeat(20), { body: Buffer.from('JPEGBYTES'), contentType: 'image/jpeg' }],
  ]);
  return {
    enabled: options.enabled !== false,
    async lookup(title) {
      if (title.includes('找不到')) return null;
      return {
        key: '0'.repeat(20),
        title,
        provider: 'kitsu',
        imageUrl: 'https://example.invalid/a.jpg',
        pageUrl: 'https://kitsu.io/anime/x',
        matchedTitle: title,
      };
    },
    async image(key) {
      return images.get(key) ?? null;
    },
  };
}

/**
 * 起一个测试服务。
 *
 * @param {(instance: any) => Promise<void>} run
 * @param {any} [coverFinder]
 */
async function withServer(run, coverFinder = fakeFinder()) {
  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    http: { proxy: null },
    cache: memoryCache(),
    version: 'test',
    logger: () => {},
    coverFinder,
  });

  try {
    await run(instance);
  } finally {
    await instance.close();
  }
}

test('接口 /api/covers：批量返回封面地址，未命中给 null', async () => {
  await withServer(async (instance) => {
    const url = `${instance.url}/api/covers?title=${encodeURIComponent('Sousou no Frieren')}&title=${encodeURIComponent('找不到的东西')}`;
    const response = await fetch(url);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.equal(data.enabled, true);
    assert.equal(data.covers.length, 2);
    assert.equal(data.covers[0].provider, 'kitsu');
    assert.equal(data.covers[0].url, `/api/cover/${'0'.repeat(20)}`);
    assert.equal(data.covers[1].url, null);
  });
});

test('接口 /api/covers：关闭封面时返回 enabled:false 且不查任何东西', async () => {
  let looked = 0;
  const finder = {
    enabled: false,
    async lookup() {
      looked += 1;
      return null;
    },
    async image() {
      return null;
    },
  };

  await withServer(async (instance) => {
    const response = await fetch(`${instance.url}/api/covers?title=x`);
    const data = await response.json();
    assert.equal(data.enabled, false);
    assert.deepEqual(data.covers, []);
    assert.equal(looked, 0, '关闭时不该触发查询');

    const image = await fetch(`${instance.url}/api/cover/${'0'.repeat(20)}`);
    assert.equal(image.status, 404);
  }, finder);
});

test('接口 /api/cover/<key>：返回图片字节并带长缓存头', async () => {
  await withServer(async (instance) => {
    const response = await fetch(`${instance.url}/api/cover/${'0'.repeat(20)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.match(response.headers.get('cache-control'), /max-age=604800/);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'JPEGBYTES');
  });
});

test('接口 /api/cover/<key>：未知或非法 key 一律 404（不能当任意 URL 代理）', async () => {
  await withServer(async (instance) => {
    for (const key of ['f'.repeat(20), 'not-a-key', encodeURIComponent('../../etc/passwd'), '..%2f..%2fetc%2fpasswd']) {
      const response = await fetch(`${instance.url}/api/cover/${key}`);
      assert.equal(response.status, 404, `key=${key} 应 404`);
    }
  });
});

test('接口 /api/health：报告封面功能是否启用', async () => {
  await withServer(async (instance) => {
    const data = await (await fetch(`${instance.url}/api/health`)).json();
    assert.equal(data.covers.enabled, true);
  });
});
