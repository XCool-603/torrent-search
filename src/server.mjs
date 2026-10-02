/**
 * 本地 HTTP 服务：JSON API + Web UI 静态资源。
 *
 * 路由：
 *   GET /api/health              健康检查
 *   GET /api/sources             数据源列表
 *   GET /api/search?q=...        聚合搜索
 *   GET /*                        web/ 目录下的静态文件（默认 index.html）
 *
 * 只监听 127.0.0.1（默认），不对外暴露；API 带 CORS 头，方便被别的本地页面调用。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAll, SORT_MODES, SORT_ORDERS } from './aggregate.mjs';
import { listSources } from './sources/index.mjs';

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

/** 服务端结果缓存默认 60 秒：翻页与重复搜索秒回，同时明显降低对站点的请求量 */
const DEFAULT_SEARCH_CACHE_TTL_MS = 60_000;
const MAX_QUERY_LENGTH = 200;
const MAX_EXCLUDE_KEYWORDS = 20;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * 创建 HTTP 服务（未监听）。
 *
 * @param {{
 *   http: any, cache: any, version?: string, webDir?: string,
 *   logger?: (msg: string) => void, defaultTimeoutMs?: number, maxPageSize?: number,
 *   downloadManager?: any,   // 提供后启用 /api/downloads* 下载接口
 * }} options
 * @returns {import('node:http').Server}
 */
export function createApiServer(options) {
  const webDir = path.resolve(options.webDir ?? DEFAULT_WEB_DIR);
  const logger = options.logger ?? (() => {});
  const startedAt = Date.now();
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 8_000;
  const maxPageSize = options.maxPageSize ?? 100;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logger(`请求处理异常：${error?.stack ?? error}`);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal_error', message: '服务器内部错误' } });
      else res.end();
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    const requestStarted = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = safeDecode(url.pathname);

    res.on('finish', () => {
      logger(`${req.method} ${pathname}${url.search ? url.search : ''} → ${res.statusCode} (${Date.now() - requestStarted}ms)`);
    });

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, url, pathname);
      return;
    }

    await serveStatic(req, res, pathname);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {string} pathname
   */
  async function handleApi(req, res, url, pathname) {
    setCors(req, res, pathname);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-max-age': '86400', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' });
      res.end();
      return;
    }

    // 下载相关接口需要 POST/DELETE 与请求体
    if (pathname.startsWith('/api/downloads')) {
      await handleDownloadsApi(req, res, url, pathname);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET' } });
      return;
    }

    switch (pathname) {
      case '/api/health': {
        sendJson(res, 200, {
          ok: true,
          version: options.version ?? '1.0.0',
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          node: process.version,
          proxy: options.http?.proxy ? String(options.http.proxy.href) : null,
          downloads: options.downloadManager
            ? {
                enabled: true,
                dir: options.downloadManager.dir,
                active: options.downloadManager.running.size,
                backend: options.downloadManager.backend ?? 'builtin',
                qbit: options.downloadManager.qbit ? { configured: true } : { configured: false },
              }
            : { enabled: false },
        });
        return;
      }

      case '/api/sources': {
        sendJson(res, 200, { sources: listSources() });
        return;
      }

      case '/api/search': {
        await handleSearch(res, url);
        return;
      }

      default: {
        sendJson(res, 404, { error: { code: 'not_found', message: `未知接口：${pathname}` } });
      }
    }
  }

  /**
   * 下载任务接口：
   *   GET    /api/downloads            任务列表
   *   GET    /api/downloads/stream     SSE 实时进度
   *   GET    /api/downloads/:id        单个任务
   *   POST   /api/downloads            新建任务，body: {input, dir?, name?}
   *   DELETE /api/downloads/:id        取消并删除记录（?deleteFiles=1 连文件一起删）
   */
  async function handleDownloadsApi(req, res, url, pathname) {
    const manager = options.downloadManager;
    if (!manager) {
      sendJson(res, 503, { error: { code: 'downloads_disabled', message: '下载功能未启用（缺少 downloadManager）' } });
      return;
    }

    const parts = pathname.split('/').filter(Boolean); // ['api', 'downloads', ...]
    const rest = parts.slice(2);
    const method = req.method.toUpperCase();

    // SSE 进度流
    if (rest[0] === 'stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', tasks: manager.list() })}\n\n`);

      const send = (type, payload) => {
        try {
          res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
        } catch {
          /* 连接已断 */
        }
      };

      const onUpdate = (task) => send('update', { task });
      const onProgress = (task) => send('progress', { task });
      const onRemoved = (info) => send('removed', info);
      manager.on('update', onUpdate);
      manager.on('progress', onProgress);
      manager.on('removed', onRemoved);

      // 进度事件可能很密（每个分片一次），SSE 里按 500ms 合流
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* 忽略 */
        }
      }, 15_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        manager.off('update', onUpdate);
        manager.off('progress', onProgress);
        manager.off('removed', onRemoved);
      });
      return;
    }

    if (rest.length === 0) {
      if (method === 'GET') {
        // 列表里附带后端配置与 qBittorrent 可用性，方便界面提示
        const qbit = manager.checkQbit ? await manager.checkQbit().catch(() => ({ ok: false })) : { ok: false };
        sendJson(res, 200, {
          tasks: manager.list(),
          dir: manager.dir,
          backend: manager.backend ?? 'builtin',
          qbit: { ok: qbit.ok === true, version: qbit.version ?? null },
        });
        return;
      }

      if (method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 64 * 1024) {
            sendJson(res, 413, { error: { code: 'too_large', message: '请求体过大' } });
            return;
          }
        }

        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          sendJson(res, 400, { error: { code: 'bad_request', message: '请求体必须是 JSON' } });
          return;
        }

        const input = String(parsed.input ?? '').trim();
        if (input === '') {
          sendJson(res, 400, { error: { code: 'bad_request', message: '缺少 input（磁力链接或 info hash）' } });
          return;
        }

        try {
          const task = manager.add({
            input,
            dir: parsed.dir,
            name: parsed.name ?? null,
            backend: parsed.backend,
            maxBytes: Number(parsed.maxBytes) > 0 ? Math.floor(Number(parsed.maxBytes)) : undefined,
          });
          sendJson(res, 201, task);
        } catch (error) {
          sendJson(res, 400, { error: { code: 'bad_request', message: error?.message ?? '任务创建失败' } });
        }
        return;
      }

      sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET / POST' } });
      return;
    }

    const id = rest[0];
    if (method === 'GET') {
      const task = manager.get(id);
      if (!task) {
        sendJson(res, 404, { error: { code: 'not_found', message: `任务不存在：${id}` } });
        return;
      }
      sendJson(res, 200, task);
      return;
    }

    if (method === 'DELETE') {
      const deleteFiles = ['1', 'true', 'yes'].includes((url.searchParams.get('deleteFiles') ?? '').toLowerCase());
      const removed = await manager.remove(id, { deleteFiles });
      if (!removed) {
        sendJson(res, 404, { error: { code: 'not_found', message: `任务不存在：${id}` } });
        return;
      }
      sendJson(res, 200, { ok: true, id });
      return;
    }

    sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET / DELETE' } });
  }

  async function handleSearch(res, url) {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query === '') {
      sendJson(res, 400, { error: { code: 'bad_request', message: '缺少参数 q（搜索关键词）' } });
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      sendJson(res, 400, { error: { code: 'bad_request', message: `关键词过长（最多 ${MAX_QUERY_LENGTH} 个字符）` } });
      return;
    }

    const sort = (url.searchParams.get('sort') ?? 'relevance').trim() || 'relevance';
    if (!SORT_MODES.includes(sort)) {
      sendJson(res, 400, { error: { code: 'bad_request', message: `sort 只能是 ${SORT_MODES.join(' / ')}` } });
      return;
    }

    const order = (url.searchParams.get('order') ?? 'desc').trim().toLowerCase() || 'desc';
    if (!SORT_ORDERS.includes(order)) {
      sendJson(res, 400, { error: { code: 'bad_request', message: `order 只能是 ${SORT_ORDERS.join(' / ')}` } });
      return;
    }

    const minSeeders = parseNonNegativeInt(url.searchParams.get('minSeeders'), 0);
    const exclude = (url.searchParams.get('exclude') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (exclude.length > MAX_EXCLUDE_KEYWORDS) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: `exclude 关键词过多（最多 ${MAX_EXCLUDE_KEYWORDS} 个）` },
      });
      return;
    }

    const safe = parseBoolean(url.searchParams.get('safe'));
    const bypassCache = parseBoolean(url.searchParams.get('noCache'));

    const page = parsePositiveInt(url.searchParams.get('page'), 1);
    const pageSize = Math.min(maxPageSize, parsePositiveInt(url.searchParams.get('pageSize'), 20));
    const timeoutMs = Math.min(60_000, parsePositiveInt(url.searchParams.get('timeoutMs'), defaultTimeoutMs));
    const sourcesParam = url.searchParams.get('sources');

    try {
      const result = await searchAll({
        query,
        sources: sourcesParam && sourcesParam.trim() !== '' ? sourcesParam : 'default',
        sort,
        order,
        page,
        pageSize,
        timeoutMs,
        minSeeders,
        exclude,
        safe,
        cacheTtlMs: options.cacheTtlMs ?? DEFAULT_SEARCH_CACHE_TTL_MS,
        bypassCache,
        http: options.http,
        cache: options.cache,
        logger,
      });
      sendJson(res, 200, result);
    } catch (error) {
      logger(`搜索失败：${error?.stack ?? error}`);
      sendJson(res, 500, { error: { code: 'search_failed', message: error?.message ?? '搜索失败' } });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   */
  async function serveStatic(req, res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.resolve(webDir, relative);

    // 目录穿越防护：解析后的路径必须仍在 webDir 内
    if (target !== webDir && !target.startsWith(webDir + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 禁止访问');
      return;
    }

    let filePath = target;
    let stat = await statOrNull(filePath);

    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await statOrNull(filePath);
    }

    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 页面不存在');
      return;
    }

    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      // 本地工具，不做强缓存，改完刷新即可生效
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  server.on('clientError', (error, socket) => {
    logger(`客户端连接错误：${error.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/**
 * 启动服务。
 *
 * @param {{port?: number, host?: string, onListen?: (info: {url: string, port: number}) => void} & Parameters<typeof createApiServer>[0]} options
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number, host: string, close: () => Promise<void>}>}
 */
export async function startServer(options) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const server = createApiServer(options);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${actualPort}`;

  options.onListen?.({ url, port: actualPort });

  return {
    server,
    url,
    port: actualPort,
    host,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * CORS 策略（安全关键）：
 * - 搜索类接口保持开放（`*`）：这是当初设计给本地其它页面调用的只读接口，无副作用；
 * - **下载接口绝不能开放 CORS**：浏览器同源策略是本地服务的最后一道防线。
 *   若对 /api/downloads 也开 `*`，任何网页都能向 127.0.0.1:8787 发 POST，
 *   把访客的机器当成下载节点、甚至触发 deleteFiles 删除文件（drive-by 攻击面）。
 *   收紧后：跨源页面可以读任务列表（GET 开放，方便只读集成），但创建/删除只允许同源。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
function setCors(req, res, pathname) {
  const isDownloadMutation = pathname.startsWith('/api/downloads') && req.method !== 'GET' && req.method !== 'HEAD';
  res.setHeader('access-control-allow-origin', isDownloadMutation ? 'null' : '*');
  res.setHeader('vary', 'origin');
}

function parsePositiveInt(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * 解析非负整数（0 合法，例如 minSeeders=0）。
 *
 * @param {string|null} value
 * @param {number} fallback
 * @returns {number}
 */
function parseNonNegativeInt(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * 解析布尔型查询参数（`1`/`true`/`yes`/`on` 都算真）。
 *
 * @param {string|null} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  if (value === null || value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}
