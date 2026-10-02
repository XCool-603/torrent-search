import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { startServer } from '../src/server.mjs';
import { memoryCache } from './helpers.mjs';
import { DownloadManager } from '../src/download/manager.mjs';

/**
 * 造一个假下载引擎（不联网、立即完成）。
 */
function fakeEngine() {
  return async (options) => {
    options.onProgress?.({ phase: 'metadata', name: 'dl.bin', totalBytes: 100, bytesDone: 0, piecesDone: 0, pieceCount: 1, speed: 0 });
    options.onProgress?.({ phase: 'downloading', name: 'dl.bin', totalBytes: 100, bytesDone: 100, piecesDone: 1, pieceCount: 1, speed: 0 });
    return {
      infoHash: options.infoHash,
      name: 'dl.bin',
      totalBytes: 100,
      downloadedBytes: 100,
      pieceCount: 1,
      files: [{ path: 'dl.bin', length: 100 }],
      completed: true,
      stoppedByLimit: false,
      tookMs: 1,
    };
  };
}

/**
 * 起一个带下载功能的测试服务。
 */
async function withServer(run, options = {}) {
  const downloadManager = options.noDownloads
    ? undefined
    : new DownloadManager({ dir: options.downloadDir, persistFile: null, engine: options.engine ?? fakeEngine(), logger: () => {} });

  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    http: { proxy: null },
    cache: memoryCache(),
    version: 'test',
    logger: () => {},
    downloadManager,
  });

  try {
    await run(instance, downloadManager);
  } finally {
    await instance.close();
  }
}

/**
 * 用原生 http 发请求，可以精确控制 path（fetch 会先规范化 URL，测不了穿越攻击）。
 *
 * @param {number} port
 * @param {string} rawPath
 * @param {string} [method]
 */
function rawRequest(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/health 返回服务信息', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, 'test');
    assert.equal(body.proxy, null);
    assert.match(body.node, /^v\d+/);
    assert.ok(Number.isInteger(body.uptimeSec));
    assert.equal(body.downloads.enabled, true);
  });
});

test('GET /api/sources 列出所有源，且 demo 默认关闭', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/sources`);
    assert.equal(response.status, 200);

    const { sources } = await response.json();
    const ids = sources.map((source) => source.id);

    assert.ok(ids.includes('apibay'));
    assert.ok(ids.includes('demo'));
    assert.equal(sources.find((source) => source.id === 'demo').defaultEnabled, false);
    assert.equal(sources.find((source) => source.id === 'apibay').defaultEnabled, true);
    // 不能把函数序列化出去
    assert.equal(typeof sources[0].search, 'undefined');
  });
});

test('GET /api/search 使用离线 demo 源返回规范结果', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/search?q=${encodeURIComponent('巨人')}&sources=demo`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.query, '巨人');
    assert.equal(body.total, 1);
    assert.equal(body.results[0].source, 'demo');
    assert.match(body.results[0].magnet, /^magnet:\?xt=urn:btih:[0-9a-f]{40}/);
    assert.equal(body.sources[0].id, 'demo');
    assert.equal(body.sources[0].ok, true);
  });
});

test('GET /api/search 支持分页与排序参数', async () => {
  await withServer(async ({ url }) => {
    // demo 源里有两条标题含 1080p 的数据，用 pageSize=1 正好能验证分页
    const body = await (await fetch(`${url}/api/search?q=1080p&sources=demo&page=2&pageSize=1&sort=seeders`)).json();
    assert.equal(body.page, 2);
    assert.equal(body.pageSize, 1);
    assert.equal(body.sort, 'seeders');
    assert.equal(body.total, 2);
    assert.equal(body.totalPages, 2);
    assert.equal(body.results.length, 1);
    assert.match(body.results[0].title, /1080p/);
  });
});

test('GET /api/search 缺少 q 返回 400 与中文错误信息', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/search`);
    assert.equal(response.status, 400);

    const body = await response.json();
    assert.equal(body.error.code, 'bad_request');
    assert.match(body.error.message, /q/);

    const blank = await fetch(`${url}/api/search?q=%20%20`);
    assert.equal(blank.status, 400);
  });
});

test('GET /api/search 非法 sort 返回 400', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/search?q=ubuntu&sort=bogus`);
    assert.equal(response.status, 400);

    const body = await response.json();
    assert.equal(body.error.code, 'bad_request');
    assert.match(body.error.message, /relevance/);
  });
});

test('GET /api/search 支持 order 方向，非法方向返回 400', async () => {
  await withServer(async ({ url }) => {
    const asc = await (await fetch(`${url}/api/search?q=1080p&sources=demo&sort=seeders&order=asc`)).json();
    assert.equal(asc.order, 'asc');
    assert.equal(asc.results[0].seeders <= asc.results[asc.results.length - 1].seeders, true);

    const desc = await (await fetch(`${url}/api/search?q=1080p&sources=demo&sort=seeders&order=desc`)).json();
    assert.equal(desc.order, 'desc');
    assert.equal(desc.results[0].seeders >= desc.results[desc.results.length - 1].seeders, true);

    const bogus = await fetch(`${url}/api/search?q=x&order=sideways`);
    assert.equal(bogus.status, 400);
    assert.match((await bogus.json()).error.message, /desc/);
  });
});

test('GET /api/search 支持 minSeeders / exclude / safe 过滤', async () => {
  await withServer(async ({ url }) => {
    // demo 里两条 1080p：进击的巨人（233 做种）、葬送的芙莉莲（158 做种）
    const all = await (await fetch(`${url}/api/search?q=1080p&sources=demo`)).json();
    assert.equal(all.total, 2);
    assert.equal(all.totalBeforeFilter, 2);
    assert.deepEqual(all.filters, { minSeeders: 0, exclude: [], safe: false });

    const filtered = await (await fetch(`${url}/api/search?q=1080p&sources=demo&minSeeders=200`)).json();
    assert.equal(filtered.totalBeforeFilter, 2);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.filters.minSeeders, 200);

    const excluded = await (await fetch(`${url}/api/search?q=1080p&sources=demo&exclude=${encodeURIComponent('巨人')}`)).json();
    assert.equal(excluded.total, 1);
    assert.match(excluded.results[0].title, /芙莉莲/);
    assert.deepEqual(excluded.filters.exclude, ['巨人']);

    const safe = await (await fetch(`${url}/api/search?q=1080p&sources=demo&safe=1`)).json();
    assert.equal(safe.filters.safe, true);
    assert.equal(safe.total, 2); // demo 数据没有成人分类
  });
});

test('GET /api/search 的过滤参数有上限保护', async () => {
  await withServer(async ({ url }) => {
    const many = Array.from({ length: 25 }, (_, index) => `kw${index}`).join(',');
    const response = await fetch(`${url}/api/search?q=x&sources=demo&exclude=${many}`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /最多 20 个/);

    const longQuery = 'a'.repeat(201);
    const tooLong = await fetch(`${url}/api/search?q=${longQuery}`);
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error.message, /过长/);
  });
});

test('GET /api/search 的 noCache 参数可强制重新抓取', async () => {
  await withServer(async ({ url }) => {
    // 用本文件里没出现过的关键词，保证缓存键是全新的
    const first = await (await fetch(`${url}/api/search?q=${encodeURIComponent('集')}&sources=demo`)).json();
    const second = await (await fetch(`${url}/api/search?q=${encodeURIComponent('集')}&sources=demo`)).json();
    const forced = await (await fetch(`${url}/api/search?q=${encodeURIComponent('集')}&sources=demo&noCache=1`)).json();

    assert.equal(first.total, 2);
    assert.equal(first.cached, false, '首次请求不应标记为缓存');
    assert.equal(second.cached, true, '第二次应命中服务端 60 秒缓存');
    assert.equal(forced.cached, false, 'noCache=1 应强制重新抓取');
    assert.equal(forced.total, 2);
  });
});

test('GET /api/search 未知数据源返回 200 但在源状态里标记失败', async () => {
  await withServer(async ({ url }) => {
    const body = await (await fetch(`${url}/api/search?q=x&sources=nope`)).json();
    assert.equal(body.total, 0);
    assert.equal(body.sources[0].ok, false);
    assert.equal(body.sources[0].error, '未知数据源');
  });
});

test('未知 API 路径返回 404 JSON', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/nope`);
    assert.equal(response.status, 404);

    const body = await response.json();
    assert.equal(body.error.code, 'not_found');
  });
});

test('非 GET 方法返回 405，OPTIONS 返回 204 且带 CORS 头', async () => {
  await withServer(async ({ url, port }) => {
    const post = await rawRequest(port, '/api/search?q=x', 'POST');
    assert.equal(post.status, 405);
    assert.equal(JSON.parse(post.body).error.code, 'method_not_allowed');

    const options = await rawRequest(port, '/api/search', 'OPTIONS');
    assert.equal(options.status, 204);
    assert.equal(options.headers['access-control-allow-origin'], '*');
  });
});

test('静态资源：/ 返回 Web UI，/app.js 与 /style.css 可加载', async () => {
  await withServer(async ({ url }) => {
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    assert.match(html, /种子搜索/);
    assert.match(html, /\/app\.js/);
    assert.match(html, /\/style\.css/);

    const app = await fetch(`${url}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get('content-type'), /javascript/);
    assert.ok((await app.text()).length > 1000);

    const css = await fetch(`${url}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  });
});

test('静态资源：目录穿越被拒绝，未知文件 404', async () => {
  await withServer(async ({ port }) => {
    const traversal = await rawRequest(port, '/..%2Fpackage.json');
    assert.equal(traversal.status, 403);

    const nested = await rawRequest(port, '/..%2F..%2Fsrc%2Fserver.mjs');
    assert.equal(nested.status, 403);

    const missing = await rawRequest(port, '/nope.css');
    assert.equal(missing.status, 404);
  });
});

test('startServer 返回可用的 URL 并能正常关闭', async () => {
  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    http: { proxy: null },
    cache: memoryCache(),
    logger: () => {},
  });

  assert.match(instance.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(instance.port > 0);

  const response = await fetch(`${instance.url}/api/health`);
  assert.equal(response.status, 200);

  await instance.close();
  await assert.rejects(fetch(`${instance.url}/api/health`));
});

test('端口被占用时 startServer 明确报错', async () => {
  const blocker = http.createServer(() => {});
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');

  const port = blocker.address().port;
  try {
    await assert.rejects(
      startServer({ port, host: '127.0.0.1', http: { proxy: null }, cache: memoryCache(), logger: () => {} }),
      (error) => error.code === 'EADDRINUSE',
    );
  } finally {
    blocker.close();
  }
});

test('POST /api/downloads 创建任务并异步完成', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: `magnet:?xt=urn:btih:${'c'.repeat(40)}&dn=from-api` }),
    });
    assert.equal(response.status, 201);

    const task = await response.json();
    assert.equal(task.infoHash, 'c'.repeat(40));
    assert.equal(task.name, 'from-api');
    assert.ok(['queued', 'metadata', 'downloading', 'done'].includes(task.status));

    // 等它跑完
    for (let index = 0; index < 40; index += 1) {
      const current = await (await fetch(`${url}/api/downloads/${task.id}`)).json();
      if (current.status === 'done') {
        assert.equal(current.progress, 1);
        assert.equal(current.files[0].path, 'dl.bin');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('任务没有在预期时间内完成');
  });
});

test('POST /api/downloads 的入参校验', async () => {
  await withServer(async ({ url }) => {
    const empty = await fetch(`${url}/api/downloads`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error.message, /input/);

    const badJson = await fetch(`${url}/api/downloads`, { method: 'POST', body: 'not json' });
    assert.equal(badJson.status, 400);

    const badMagnet = await fetch(`${url}/api/downloads`, { method: 'POST', body: JSON.stringify({ input: 'nope' }) });
    assert.equal(badMagnet.status, 400);
    assert.match((await badMagnet.json()).error.message, /info hash/);
  });
});

test('GET /api/downloads 列表与 404', async () => {
  await withServer(async ({ url }) => {
    const list = await (await fetch(`${url}/api/downloads`)).json();
    assert.deepEqual(list.tasks, []);
    assert.ok(typeof list.dir === 'string');

    const missing = await fetch(`${url}/api/downloads/no-such-id`);
    assert.equal(missing.status, 404);
  });
});

test('DELETE /api/downloads/:id 删除任务', async () => {
  await withServer(async ({ url }) => {
    const created = await (await fetch(`${url}/api/downloads`, {
      method: 'POST',
      body: JSON.stringify({ input: 'd'.repeat(40) }),
    })).json();

    for (let index = 0; index < 40; index += 1) {
      const current = await (await fetch(`${url}/api/downloads/${created.id}`)).json();
      if (current.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const removed = await fetch(`${url}/api/downloads/${created.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);

    const gone = await fetch(`${url}/api/downloads/${created.id}`);
    assert.equal(gone.status, 404);
  });
});

test('GET /api/downloads/stream 推送进度（SSE）', async () => {
  await withServer(async ({ url }) => {
    const controller = new AbortController();
    const stream = await fetch(`${url}/api/downloads/stream`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';

    // 收一小段 SSE 数据
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.includes('"update"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    controller.abort();

    assert.ok(seen.includes('hello'), 'SSE 应该先发 hello');
  });
});

test('未提供 downloadManager 时下载接口返回 503', async () => {
  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    http: { proxy: null },
    cache: memoryCache(),
    version: 'test',
    logger: () => {},
  });

  try {
    const response = await fetch(`${instance.url}/api/downloads`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'downloads_disabled');
  } finally {
    await instance.close();
  }
});

test('安全：下载接口的写操作不对跨源开放（CORS 收紧）', async () => {
  await withServer(async ({ url }) => {
    // 搜索接口保持开放（只读集成用）
    const search = await fetch(`${url}/api/search?q=x&sources=demo`);
    assert.equal(search.headers.get('access-control-allow-origin'), '*');

    // 下载的 GET（含 SSE）开放给跨源只读；写操作必须不允许跨源
    const getDownloads = await fetch(`${url}/api/downloads`);
    assert.equal(getDownloads.headers.get('access-control-allow-origin'), '*');

    const post = await fetch(`${url}/api/downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'e'.repeat(40) }),
    });
    assert.equal(post.headers.get('access-control-allow-origin'), 'null');

    const sse = await fetch(`${url}/api/downloads/stream`);
    assert.equal(sse.headers.get('access-control-allow-origin'), '*');
    await sse.body.cancel();
  });
});

test('安全：dir 参数不能把下载写到下载根目录之外', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'f'.repeat(40), dir: path.join(os.tmpdir(), 'evil-target') }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /下载根目录之内/);
  });
});
