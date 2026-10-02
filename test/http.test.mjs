import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { once } from 'node:events';

import { createHttpClient, normalizeProxy, detectSystemProxy, HttpError } from '../src/http.mjs';

/**
 * 起一个本地测试目标服务。
 */
async function startTarget() {
  let server500Hits = 0;

  const server = http.createServer((req, res) => {
    switch (req.url) {
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(JSON.stringify({ ok: true, name: '中文' })));
        return;
      case '/redirect':
        res.writeHead(302, { location: '/json' });
        res.end();
        return;
      case '/redirect-loop':
        res.writeHead(302, { location: '/redirect-loop' });
        res.end();
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(200_000, 7));
        return;
      case '/slow':
        // 故意不响应，交给客户端超时
        return;
      case '/404':
        res.writeHead(404);
        res.end('nope');
        return;
      case '/500':
        server500Hits += 1;
        res.writeHead(500);
        res.end('boom');
        return;
      default:
        res.writeHead(400);
        res.end('bad');
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    get hits500() {
      return server500Hits;
    },
    // 必须销毁 keep-alive 连接，否则 server.close() 会一直等 socket 释放
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}

/**
 * 起一个极简的 HTTP CONNECT 隧道代理（用来真实测试代理路径，而不是打桩）。
 */
async function startTunnelProxy({ rejectConnect = false } = {}) {
  /** CONNECT 隧道产生的裸 socket 不在 server.closeAllConnections() 的管理范围内，必须自己跟踪并销毁 */
  const tunnels = new Set();

  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });

  server.on('connect', (req, clientSocket, head) => {
    if (rejectConnect) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    tunnels.add(clientSocket);
    tunnels.add(upstream);
    const forget = () => {
      tunnels.delete(clientSocket);
      tunnels.delete(upstream);
    };
    clientSocket.on('close', forget);
    upstream.on('close', forget);

    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of tunnels) socket.destroy();
        tunnels.clear();
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}

test('normalizeProxy 归一化各种写法', () => {
  assert.equal(normalizeProxy('127.0.0.1:7897').href, 'http://127.0.0.1:7897/');
  assert.equal(normalizeProxy('http://127.0.0.1:7890').href, 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxy('127.0.0.1').port, '8080');
  assert.equal(normalizeProxy(null), null);
  assert.equal(normalizeProxy(''), null);
  assert.equal(normalizeProxy('none'), null);
  assert.equal(normalizeProxy('off'), null);

  assert.throws(() => normalizeProxy('socks5://127.0.0.1:1080'), (error) => error instanceof HttpError && error.code === 'bad_proxy');
});

test('detectSystemProxy 优先读环境变量', async () => {
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };

  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    process.env.HTTPS_PROXY = 'http://127.0.0.1:12345';
    assert.equal(await detectSystemProxy({ includeSystem: false }), 'http://127.0.0.1:12345');

    delete process.env.HTTPS_PROXY;
    process.env.https_proxy = 'http://127.0.0.1:23456';
    assert.equal(await detectSystemProxy({ includeSystem: false }), 'http://127.0.0.1:23456');
  } finally {
    for (const key of Object.keys(saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
});

test('直连：解析 gzip 的 JSON、跟随重定向', async () => {
  const target = await startTarget();
  try {
    const client = createHttpClient({ retries: 0, timeoutMs: 5000 });

    const data = await client.getJson(`${target.url}/json`);
    assert.deepEqual(data, { ok: true, name: '中文' });

    const text = await client.getText(`${target.url}/redirect`);
    assert.match(text, /"ok":true/);
  } finally {
    await target.close();
  }
});

test('直连：超过大小上限抛 too_large', async () => {
  const target = await startTarget();
  try {
    const client = createHttpClient({ retries: 0, maxBytes: 1000, timeoutMs: 5000 });
    await assert.rejects(
      client.getText(`${target.url}/big`),
      (error) => error instanceof HttpError && error.code === 'too_large',
    );
  } finally {
    await target.close();
  }
});

test('直连：超时被归类为 timeout', async () => {
  const target = await startTarget();
  try {
    const client = createHttpClient({ retries: 0, timeoutMs: 400 });
    await assert.rejects(
      client.getText(`${target.url}/slow`),
      (error) => error instanceof HttpError && error.code === 'timeout',
    );
  } finally {
    await target.close();
  }
});

test('直连：HTTP 错误状态带 status 字段', async () => {
  const target = await startTarget();
  try {
    const client = createHttpClient({ retries: 0, timeoutMs: 5000 });

    await assert.rejects(
      client.getText(`${target.url}/404`),
      (error) => error instanceof HttpError && error.code === 'http_status' && error.status === 404,
    );
  } finally {
    await target.close();
  }
});

test('直连：5xx 会重试，重试次数符合配置', async () => {
  const target = await startTarget();
  try {
    const noRetry = createHttpClient({ retries: 0, timeoutMs: 5000 });
    await assert.rejects(noRetry.getText(`${target.url}/500`));
    assert.equal(target.hits500, 1);

    const oneRetry = createHttpClient({ retries: 1, timeoutMs: 5000 });
    await assert.rejects(oneRetry.getText(`${target.url}/500`));
    assert.equal(target.hits500, 3); // 1 + 重试 1 次 = 2 次
  } finally {
    await target.close();
  }
});

test('直连：重定向过多时明确报错', async () => {
  const target = await startTarget();
  try {
    const client = createHttpClient({ retries: 0, timeoutMs: 5000 });
    // 内置 fetch 会在 20 次后放弃
    await assert.rejects(client.getText(`${target.url}/redirect-loop`), (error) => error instanceof HttpError);
  } finally {
    await target.close();
  }
});

test('代理路径：经自建 CONNECT 隧道完成请求（含 gzip 解压与重定向）', async () => {
  const target = await startTarget();
  const proxy = await startTunnelProxy();

  try {
    const client = createHttpClient({ proxy: proxy.url, retries: 0, timeoutMs: 5000 });
    assert.equal(client.proxy.href, `${proxy.url}/`);

    const data = await client.getJson(`${target.url}/json`);
    assert.deepEqual(data, { ok: true, name: '中文' });

    const redirected = await client.getJson(`${target.url}/redirect`);
    assert.equal(redirected.ok, true);
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('代理路径：大小上限与 HTTP 错误同样生效', async () => {
  const target = await startTarget();
  const proxy = await startTunnelProxy();

  try {
    const small = createHttpClient({ proxy: proxy.url, retries: 0, maxBytes: 1000, timeoutMs: 5000 });
    await assert.rejects(small.getText(`${target.url}/big`), (error) => error.code === 'too_large');

    const client = createHttpClient({ proxy: proxy.url, retries: 0, timeoutMs: 5000 });
    await assert.rejects(
      client.getText(`${target.url}/404`),
      (error) => error.code === 'http_status' && error.status === 404,
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('代理路径：代理拒绝 CONNECT 时给出可读错误', async () => {
  const target = await startTarget();
  const proxy = await startTunnelProxy({ rejectConnect: true });

  try {
    const client = createHttpClient({ proxy: proxy.url, retries: 0, timeoutMs: 5000 });
    await assert.rejects(
      client.getText(`${target.url}/json`),
      (error) => error instanceof HttpError && error.code === 'network' && /代理拒绝 CONNECT：HTTP 403/.test(error.message),
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('代理路径：代理端口不通时报网络错误', async () => {
  const client = createHttpClient({ proxy: 'http://127.0.0.1:1', retries: 0, timeoutMs: 2000 });
  await assert.rejects(
    client.getText('http://127.0.0.1:9/json'),
    (error) => error instanceof HttpError && error.code === 'network' && /代理连接失败/.test(error.message),
  );
});

test('JSON 解析失败归类为 parse 错误', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('<html>这不是 JSON</html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const client = createHttpClient({ retries: 0, timeoutMs: 5000 });
    await assert.rejects(
      client.getJson(`http://127.0.0.1:${server.address().port}/`),
      (error) => error instanceof HttpError && error.code === 'parse',
    );
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
});

test('已取消的 signal 立即返回 aborted', async () => {
  const target = await startTarget();
  try {
    const controller = new AbortController();
    controller.abort();

    const client = createHttpClient({ retries: 0, timeoutMs: 5000 });
    await assert.rejects(
      client.getText(`${target.url}/json`, { signal: controller.signal }),
      (error) => error.code === 'aborted',
    );
  } finally {
    await target.close();
  }
});

test('BT tracker 的 announce 可经 CONNECT 代理（复用同一套隧道实现）', async () => {
  const { startFakeSwarm } = await import('./helpers/fake-swarm.mjs');
  const { announce } = await import('../src/bt/tracker.mjs');

  const swarm = await startFakeSwarm({ content: Buffer.alloc(20_000, 3), name: 'proxy.bin' });
  const tunnels = new Set();
  const proxy = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    tunnels.add(clientSocket);
    tunnels.add(upstream);
    const forget = () => {
      tunnels.delete(clientSocket);
      tunnels.delete(upstream);
    };
    clientSocket.on('close', forget);
    upstream.on('close', forget);
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const result = await announce({
      trackerUrl: swarm.trackers[0],
      infoHash: swarm.infoHash,
      peerId: Buffer.from('-TS1000-abcdefghijkl', 'latin1'),
      port: 6881,
      left: 16_384,
      event: 'started',
      timeoutMs: 8000,
      proxy: new URL(`http://127.0.0.1:${proxy.address().port}`),
    });

    assert.equal(result.ok, true);
    assert.equal(result.peers.length, 1);
    assert.equal(swarm.stats.announceCount, 1, '请求应真的经过代理到达 tracker');
  } finally {
    for (const socket of tunnels) socket.destroy();
    await new Promise((resolve) => {
      proxy.close(resolve);
      proxy.closeAllConnections?.();
    });
    await swarm.close();
  }
});
