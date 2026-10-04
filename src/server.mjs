/**
 * 本地 HTTP 服务：JSON API + Web UI 静态资源。
 *
 * 路由：
 *   GET /api/health              健康检查
 *   GET /api/sources             数据源列表
 *   GET /api/search?q=...        聚合搜索
 *   GET /api/stream/<hash>[/<i>] 边下边播（文件清单 / 支持 Range 的字节流）
 *   GET /*                        web/ 目录下的静态文件（默认 index.html）
 *
 * 只监听 127.0.0.1（默认），不对外暴露；API 带 CORS 头，方便被别的本地页面调用。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAll, SORT_MODES, SORT_ORDERS } from './aggregate.mjs';
import { listSources } from './sources/index.mjs';
import { parseRange, contentTypeFor, readReadyRange, DEFAULT_WAIT_MS, DEFAULT_CHUNK_BYTES } from './bt/stream.mjs';
import { assertInside } from './bt/storage.mjs';

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
const MAX_COVER_TITLES = 24; // 一次最多查多少个标题（前端按可见行分批请求）

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
      res.writeHead(204, { 'access-control-max-age': '86400', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type, range' });
      res.end();
      return;
    }

    // 下载相关接口需要 POST/DELETE 与请求体
    if (pathname.startsWith('/api/downloads')) {
      await handleDownloadsApi(req, res, url, pathname);
      return;
    }

    // 封面接口（GET 为主；图片走 /api/cover/<key>）
    if (pathname === '/api/covers' || pathname.startsWith('/api/cover/')) {
      await handleCoversApi(req, res, url, pathname);
      return;
    }

    // 边下边播（GET / HEAD，支持 Range）
    if (pathname === '/api/stream' || pathname.startsWith('/api/stream/')) {
      await handleStreamApi(req, res, url, pathname);
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
          covers: { enabled: options.coverFinder ? options.coverFinder.enabled === true : false },
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
   * 封面接口：
   *   GET /api/covers?title=..&title=..   批量查封面（最多 24 个标题），返回同源图片地址
   *   GET /api/cover/<key>                取封面图片字节（仅限缓存里已有的 key）
   *
   * 安全要点：`/api/cover/<key>` **只服务缓存中已存在的 key**，不接受任意 URL，
   * 否则这个接口就变成了一个任意请求代理（SSRF）。
   */
  async function handleCoversApi(req, res, url, pathname) {
    const finder = options.coverFinder;

    if (pathname === '/api/covers') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET' } });
        return;
      }
      if (!finder || finder.enabled !== true) {
        sendJson(res, 200, { enabled: false, covers: [] });
        return;
      }

      const titles = url.searchParams.getAll('title').slice(0, MAX_COVER_TITLES);
      const covers = [];
      for (const title of titles) {
        if (typeof title !== 'string' || title.trim() === '') continue;
        let hit = null;
        try {
          hit = await finder.lookup(title);
        } catch (error) {
          logger(`封面查询失败：${error?.message ?? error}`);
        }
        covers.push(
          hit
            ? {
                title,
                url: `/api/cover/${hit.key}`,
                provider: hit.provider,
                matchedTitle: hit.matchedTitle ?? null,
                pageUrl: hit.pageUrl ?? null,
              }
            : { title, url: null, provider: null, matchedTitle: null, pageUrl: null },
        );
      }
      sendJson(res, 200, { enabled: true, covers });
      return;
    }

    // /api/cover/<key>
    const key = pathname.slice('/api/cover/'.length);
    if (!finder || finder.enabled !== true) {
      sendJson(res, 404, { error: { code: 'covers_disabled', message: '封面功能未启用' } });
      return;
    }

    const image = await finder.image(key).catch(() => null);
    if (!image) {
      sendJson(res, 404, { error: { code: 'not_found', message: '没有这张封面' } });
      return;
    }

    res.writeHead(200, {
      'content-type': image.contentType,
      'content-length': image.body.length,
      // 图片内容按 URL 固定（key 是标题哈希），可以长时间缓存
      'cache-control': 'public, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : image.body);
  }

  /**
   * 边下边播接口：
   *   GET /api/stream/<infoHash>              文件清单（含下标、路径、大小、类型）
   *   GET /api/stream/<infoHash>/<fileIndex>  文件字节，支持 Range
   *
   * 只服务**已校验落盘**的分片：请求的数据还没到就等（默认最多 30 秒），
   * 超时返回 503 让播放器稍后重试 —— 起播时等首片是正常的。
   *
   * 只支持内置引擎的任务：qBittorrent 后端的数据在 qB 侧，我们拿不到它的分片位图，
   * 因此如实返回 409 说明原因，而不是返回读不出来的字节。
   *
   * 安全：只按 (infoHash, fileIndex) 定位**正在下载的任务**，不接受任意路径参数，
   * 所以这个接口无法被用来读本机其它文件。
   */
  async function handleStreamApi(req, res, url, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET' } });
      return;
    }

    const manager = options.downloadManager;
    if (!manager) {
      sendJson(res, 503, { error: { code: 'downloads_disabled', message: '未启用下载功能' } });
      return;
    }

    const rest = pathname.replace(/^\/api\/stream\/?/, '');
    const [rawHash, rawIndex] = rest.split('/');
    const infoHash = String(rawHash ?? '').toLowerCase();

    if (!/^[0-9a-f]{40}$/.test(infoHash)) {
      sendJson(res, 400, { error: { code: 'bad_info_hash', message: 'info hash 必须是 40 位十六进制' } });
      return;
    }

    const task = manager.internalByInfoHash(infoHash);
    if (!task) {
      sendJson(res, 404, { error: { code: 'task_not_found', message: '没有这个 info hash 的下载任务' } });
      return;
    }

    const session = task.session;
    const finishedOnDisk = !session && task.status === 'done' && Array.isArray(task.files) && task.files.length > 0;

    if (!session && !finishedOnDisk) {
      sendJson(res, 409, {
        error: {
          code: 'not_streamable',
          message:
            task.backend === 'qbittorrent'
              ? '该任务由 qBittorrent 下载，无法边下边播（数据在 qBittorrent 侧，取不到分片位图）'
              : '该任务当前不可播放：下载尚未进入分片阶段，或已失败/取消',
        },
      });
      return;
    }

    // 两种数据来源：
    //   下载中 → 会话（torrent 元数据 + 已校验分片位图 + 读盘句柄），只给已就绪的字节
    //   已下完 → 磁盘文件（此时引擎已关闭会话，文件本身是完整且校验过的）
    const torrent = session?.torrent ?? null;
    const fileCount = torrent ? torrent.files.length : task.files.length;
    const fileAt = (index) => (torrent ? torrent.files[index] : task.files[index]);

    // 不带下标：返回文件清单，方便调用方决定播哪一个
    if (rawIndex === undefined || rawIndex === '') {
      sendJson(res, 200, {
        infoHash,
        name: task.name ?? torrent?.name ?? null,
        totalBytes: torrent?.totalSize ?? task.totalBytes ?? null,
        pieceLength: torrent?.pieceLength ?? null,
        pieceCount: torrent?.pieceCount ?? task.pieceCount ?? null,
        piecesDone: session ? session.done.filter(Boolean).length : (task.pieceCount ?? 0),
        complete: Boolean(finishedOnDisk) || (session ? session.done.every(Boolean) : false),
        files: Array.from({ length: fileCount }, (_, index) => {
          const file = fileAt(index);
          return {
            index,
            path: file.path,
            length: file.length,
            contentType: contentTypeFor(file.path),
            url: `/api/stream/${infoHash}/${index}`,
          };
        }),
      });
      return;
    }

    const fileIndex = Number(rawIndex);
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= fileCount) {
      sendJson(res, 404, { error: { code: 'file_not_found', message: `文件下标不存在：${rawIndex}` } });
      return;
    }

    const file = fileAt(fileIndex);

    /** 流式响应共用的头。跨源播放器要能读到这几个头才能正确 seek / 判断总长。 */
    const streamHeaders = () => ({
      'content-type': contentTypeFor(file.path),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'access-control-expose-headers': 'content-range, accept-ranges, content-length',
    });

    // ---- 已下完：文件在磁盘上完整且校验过，直接按 Range 读文件流 ----
    // 比读进内存更省，也解决了「引擎已关闭会话、句柄不可用」的问题。
    if (finishedOnDisk) {
      const absolute = path.resolve(task.dir, file.path);
      assertInside(task.dir, absolute);

      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        sendJson(res, 404, { error: { code: 'file_missing', message: `文件不在磁盘上：${file.path}` } });
        return;
      }

      const diskSize = stat.size;
      if (diskSize === 0) {
        res.writeHead(200, { ...streamHeaders(), 'content-length': '0' });
        res.end();
        return;
      }

      const diskRange = parseRange(req.headers.range, diskSize);
      if (diskRange?.unsatisfiable) {
        res.writeHead(416, { ...streamHeaders(), 'content-range': `bytes */${diskSize}` });
        res.end();
        return;
      }

      const diskPartial = Boolean(diskRange && !diskRange.unsupported);
      const diskStart = diskPartial ? diskRange.start : 0;
      const diskEnd = diskPartial ? diskRange.end : diskSize - 1;
      const diskHeaders = { ...streamHeaders(), 'content-length': String(diskEnd - diskStart + 1) };
      if (diskPartial) diskHeaders['content-range'] = `bytes ${diskStart}-${diskEnd}/${diskSize}`;

      res.writeHead(diskPartial ? 206 : 200, diskHeaders);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(absolute, { start: diskStart, end: diskEnd }).pipe(res);
      return;
    }

    // ---- 下载中：只给「已校验且连续」的字节 ----
    const size = file.length;

    if (size === 0) {
      res.writeHead(200, { ...streamHeaders(), 'content-length': '0' });
      res.end();
      return;
    }

    const range = parseRange(req.headers.range, size);
    if (range?.unsatisfiable) {
      res.writeHead(416, { ...streamHeaders(), 'content-range': `bytes */${size}` });
      res.end();
      return;
    }

    const partial = Boolean(range && !range.unsupported);
    const start = partial ? range.start : 0;
    const end = partial ? range.end : size - 1;
    const wanted = end - start + 1;
    const maxChunk = options.streamChunkBytes ?? DEFAULT_CHUNK_BYTES;

    // HEAD 只回头部，不去等数据：播放器/探针常先发 HEAD，让它等 30 秒是错的
    if (req.method === 'HEAD') {
      const headers = { ...streamHeaders(), 'content-length': String(wanted) };
      if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(partial ? 206 : 200, headers);
      res.end();
      return;
    }

    // 客户端断开时立刻停止等待，别把 30 秒的等待留在后台
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);

    let result;
    try {
      result = await readReadyRange({
        session,
        fileIndex,
        offset: start,
        // 不一次等完整段：浏览器常发 bytes=0-（整个文件），等整段会白等且吃内存
        maxLength: Math.min(wanted, maxChunk),
        timeoutMs: options.streamWaitMs ?? DEFAULT_WAIT_MS,
        // 下载结束/失败后 session 会被清掉：此时再等也没有意义，立刻放弃
        isAlive: () => task.session === session,
        signal: controller.signal,
      });
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      sendJson(res, 503, {
        error: { code: 'data_not_ready', message: error?.message ?? String(error) },
      });
      return;
    } finally {
      res.off('close', onClose);
    }

    const buffer = result.buffer;
    const headers = { ...streamHeaders(), 'content-length': String(buffer.length) };
    // 如实告知本次实际返回的范围（可能少于请求的范围，播放器会继续请求后续）
    if (partial || buffer.length < wanted) {
      headers['content-range'] = `bytes ${start}-${start + buffer.length - 1}/${size}`;
    }
    res.writeHead(partial ? 206 : 200, headers);
    res.end(buffer);
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
