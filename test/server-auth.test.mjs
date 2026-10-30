import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startServer } from '../src/server.mjs';
import { memoryCache } from './helpers.mjs';

const TOKEN = 'secret123';

/**
 * 起一个测试服务；只有显式传 token 时才注入 options.token，
 * 不传时由 startServer 读 TORRENT_SEARCH_TOKEN（用来验证环境变量接线）。
 *
 * @param {(instance: {url: string, port: number}) => Promise<void>} run
 * @param {{token?: string}} [options]
 */
async function withServer(run, options = {}) {
  const serverOptions = {
    port: 0,
    host: '127.0.0.1',
    http: { proxy: null },
    cache: memoryCache(),
    version: 'test',
    logger: () => {},
  };
  if (options.token !== undefined) serverOptions.token = options.token;

  const instance = await startServer(serverOptions);
  try {
    await run(instance);
  } finally {
    await instance.close();
  }
}

/**
 * 用原生 http 发请求，方便精确控制 Authorization / Cookie 头。
 *
 * @param {number} port
 * @param {string} rawPath
 * @param {Record<string, string>} [headers]
 */
function request(port, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers }, (res) => {
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

/**
 * 临时清空环境变量，保证「未设置 token」的用例不受开发机环境影响。
 *
 * @param {() => Promise<void>} run
 */
async function withoutTokenEnv(run) {
  const saved = process.env.TORRENT_SEARCH_TOKEN;
  delete process.env.TORRENT_SEARCH_TOKEN;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.TORRENT_SEARCH_TOKEN;
    else process.env.TORRENT_SEARCH_TOKEN = saved;
  }
}

test('未设置 token：/api/search 与 /api/health 都免鉴权', async () => {
  await withoutTokenEnv(async () => {
    await withServer(async ({ port }) => {
      const search = await request(port, `/api/search?q=${encodeURIComponent('1080p')}&sources=demo`);
      assert.equal(search.status, 200);
      assert.equal(JSON.parse(search.body).total, 2);

      const health = await request(port, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(JSON.parse(health.body).ok, true);

      // 静态页面同样不应被拦（中间件不能误伤 Web UI）
      const index = await request(port, '/');
      assert.equal(index.status, 200);
      assert.match(index.body, /种子搜索/);
    });
  });
});

test('设置了 token：不带 token 返回 401 与约定 JSON，且不泄露业务数据', async () => {
  await withServer(async ({ port }) => {
    const response = await request(port, `/api/search?q=${encodeURIComponent('1080p')}&sources=demo`);
    assert.equal(response.status, 401);
    assert.match(String(response.headers['content-type']), /application\/json/);

    const body = JSON.parse(response.body);
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.message.length > 0);
    assert.equal(body.total, undefined);
    assert.equal(body.results, undefined);
  }, { token: TOKEN });
});

test('设置了 token：?token= 正确返回 200 并下发 HttpOnly Cookie', async () => {
  await withServer(async ({ port }) => {
    const response = await request(port, `/api/search?q=${encodeURIComponent('1080p')}&sources=demo&token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).total, 2);

    const cookies = response.headers['set-cookie'];
    assert.ok(Array.isArray(cookies) && cookies.length > 0, '应返回 Set-Cookie');
    const cookie = cookies.join('\n');
    assert.match(cookie, new RegExp(`^ts_token=${TOKEN};`));
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=\d+/);
  }, { token: TOKEN });
});

test('设置了 token：访问 /?token= 也能进 Web UI 并记住 Cookie', async () => {
  await withServer(async ({ port }) => {
    const response = await request(port, `/?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.match(response.body, /种子搜索/);
    assert.match(response.headers['set-cookie'].join('\n'), new RegExp(`ts_token=${TOKEN}`));
  }, { token: TOKEN });
});

test('设置了 token：Authorization: Bearer 正确返回 200', async () => {
  await withServer(async ({ port }) => {
    const response = await request(port, '/api/search?q=1080p&sources=demo', {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).total, 2);
  }, { token: TOKEN });
});

test('设置了 token：Cookie: ts_token= 正确返回 200', async () => {
  await withServer(async ({ port }) => {
    const response = await request(port, '/api/search?q=1080p&sources=demo', {
      cookie: `ts_token=${TOKEN}`,
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).total, 2);
  }, { token: TOKEN });
});

test('设置了 token：三种方式带错 token 都返回 401', async () => {
  await withServer(async ({ port }) => {
    const byQuery = await request(port, `/api/search?q=1080p&sources=demo&token=wrong-token`);
    assert.equal(byQuery.status, 401);
    assert.equal(JSON.parse(byQuery.body).error.code, 'unauthorized');
    // 错误的 query token 不能下发 Cookie，否则等于把失败尝试也记住
    assert.equal(byQuery.headers['set-cookie'], undefined);

    const byHeader = await request(port, '/api/search?q=1080p&sources=demo', {
      authorization: 'Bearer wrong-token',
    });
    assert.equal(byHeader.status, 401);
    assert.equal(JSON.parse(byHeader.body).error.code, 'unauthorized');

    const byCookie = await request(port, '/api/search?q=1080p&sources=demo', {
      cookie: 'ts_token=wrong-token',
    });
    assert.equal(byCookie.status, 401);
    assert.equal(JSON.parse(byCookie.body).error.code, 'unauthorized');
  }, { token: TOKEN });
});

test('设置了 token：/api/health 仍免鉴权（健康检查不能被拦）', async () => {
  await withServer(async ({ port }) => {
    const anonymous = await request(port, '/api/health');
    assert.equal(anonymous.status, 200);
    assert.equal(JSON.parse(anonymous.body).ok, true);

    // 带错 token 也不该影响健康检查：它只回运行状态，没有业务数据
    const wrong = await request(port, '/api/health?token=wrong-token');
    assert.equal(wrong.status, 200);
  }, { token: TOKEN });
});

test('未传 options.token 时从 TORRENT_SEARCH_TOKEN 环境变量读取', async () => {
  const saved = process.env.TORRENT_SEARCH_TOKEN;
  process.env.TORRENT_SEARCH_TOKEN = TOKEN;
  try {
    await withServer(async ({ port }) => {
      const anonymous = await request(port, '/api/search?q=1080p&sources=demo');
      assert.equal(anonymous.status, 401);

      const authorized = await request(port, `/api/search?q=1080p&sources=demo&token=${TOKEN}`);
      assert.equal(authorized.status, 200);
    });
  } finally {
    if (saved === undefined) delete process.env.TORRENT_SEARCH_TOKEN;
    else process.env.TORRENT_SEARCH_TOKEN = saved;
  }
});
