/**
 * HTTP 客户端（零依赖）。
 *
 * 两条路径：
 * 1. 直连：用 Node 内置 fetch（自动处理重定向、gzip/br 解压、连接池）。
 * 2. 代理：自己实现 HTTP CONNECT 隧道 + TLS，因为 Node 的内置 fetch 只在
 *    启动时读 NODE_USE_ENV_PROXY（运行时设置 process.env 无效），而我们希望
 *    `--proxy` 参数在任何时候都能生效，也不想让用户去改启动参数。
 *
 * 统一提供：超时、响应大小上限、失败重试、错误分类（超时/网络/HTTP 状态/响应过大）。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * HTTP 请求错误，带分类信息便于展示给用户。
 */
export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, url?: string, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = info.code ?? 'network';
    this.status = info.status ?? null;
    this.url = info.url ?? null;
    if (info.cause) this.cause = info.cause;
  }
}

/**
 * 归一化代理配置：`127.0.0.1:7897` → `http://127.0.0.1:7897`。
 *
 * @param {string|null|undefined} proxy
 * @returns {URL|null}
 */
export function normalizeProxy(proxy) {
  if (!proxy) return null;
  const text = String(proxy).trim();
  if (text === '' || text.toLowerCase() === 'none' || text.toLowerCase() === 'off') return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new HttpError(`代理地址无法解析：${proxy}`, { code: 'bad_proxy' });
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new HttpError(`只支持 http/https 代理，收到：${url.protocol}`, { code: 'bad_proxy' });
  }
  if (!url.port) url.port = '8080';
  return url;
}

/**
 * 从环境变量或 Windows 系统设置里探测代理。
 *
 * @param {{includeSystem?: boolean}} [options]
 * @returns {Promise<string|null>}
 */
export async function detectSystemProxy(options = {}) {
  const { includeSystem = true } = options;

  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = process.env[key];
    if (value && value.trim() !== '') return value.trim();
  }

  if (!includeSystem || process.platform !== 'win32') return null;

  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { windowsHide: true, timeout: 3000 },
    );
    const match = stdout.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!match) return null;

    // 可能是 "http=127.0.0.1:7897;https=127.0.0.1:7897" 这种分协议格式
    const raw = match[1].trim();
    if (raw.includes('=')) {
      const parts = Object.fromEntries(
        raw.split(';').filter(Boolean).map((piece) => {
          const [scheme, address] = piece.split('=');
          return [scheme.trim().toLowerCase(), address?.trim()];
        }),
      );
      return parts.https ?? parts.http ?? null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * 创建 HTTP 客户端。
 *
 * @param {{
 *   proxy?: string|URL|null,
 *   timeoutMs?: number,
 *   userAgent?: string,
 *   maxBytes?: number,
 *   retries?: number,
 *   logger?: (msg: string) => void,
 * }} [options]
 */
export function createHttpClient(options = {}) {
  const proxy = normalizeProxy(options.proxy ?? null);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = options.retries ?? 1;
  const logger = options.logger ?? (() => {});

  /**
   * 发起一次请求（含重试），返回响应体 Buffer。
   *
   * @param {string} url
   * @param {{timeoutMs?: number, maxBytes?: number, headers?: Record<string,string>, signal?: AbortSignal, method?: string}} [perRequest]
   */
  async function request(url, perRequest = {}) {
    const attemptTimeout = perRequest.timeoutMs ?? timeoutMs;
    const attemptMaxBytes = perRequest.maxBytes ?? maxBytes;
    const headers = {
      'user-agent': userAgent,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...perRequest.headers,
    };

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (perRequest.signal?.aborted) {
        throw new HttpError('请求已取消', { code: 'aborted', url });
      }
      try {
        const response = proxy
          ? await requestViaProxy(url, { proxy, headers, timeoutMs: attemptTimeout, maxBytes: attemptMaxBytes, signal: perRequest.signal, method: perRequest.method ?? 'GET' })
          : await requestDirect(url, { headers, timeoutMs: attemptTimeout, maxBytes: attemptMaxBytes, signal: perRequest.signal, method: perRequest.method ?? 'GET' });
        return response;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof HttpError &&
          (error.code === 'network' || error.code === 'timeout' || (error.status !== null && error.status >= 500) || error.status === 429);
        if (!retryable || attempt === retries) throw error;
        logger(`请求失败，重试 (${attempt + 1}/${retries})：${url} → ${error.message}`);
        await delay(300 * (attempt + 1));
      }
    }
    throw lastError ?? new HttpError('请求失败', { url });
  }

  return {
    proxy,
    timeoutMs,
    userAgent,

    /**
     * @param {string} url
     * @param {object} [perRequest]
     * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer, url: string}>}
     */
    request,

    /**
     * @param {string} url
     * @param {object} [perRequest]
     * @returns {Promise<string>}
     */
    async getText(url, perRequest = {}) {
      const response = await request(url, perRequest);
      return response.body.toString('utf8');
    },

    /**
     * @param {string} url
     * @param {object} [perRequest]
     * @returns {Promise<any>}
     */
    async getJson(url, perRequest = {}) {
      const text = await this.getText(url, perRequest);
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new HttpError(`JSON 解析失败：${firstLine(text)}`, { code: 'parse', url, cause: error });
      }
    },
  };
}

/**
 * 直连：走内置 fetch。
 */
async function requestDirect(url, { headers, timeoutMs, maxBytes, signal, method }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response;
  try {
    response = await fetch(url, { method, headers, redirect: 'follow', signal: combined });
  } catch (error) {
    throw classifyFetchError(error, url, timeoutMs);
  }

  if (!response.ok) {
    await safeCancel(response);
    throw new HttpError(`HTTP ${response.status}`, { code: 'http_status', status: response.status, url });
  }

  const body = await readWebStream(response, maxBytes, url);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
    url: response.url || url,
  };
}

async function readWebStream(response, maxBytes, url) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(`响应超过大小上限 (${Math.round(maxBytes / 1024)} KiB)`, { code: 'too_large', url });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

async function safeCancel(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* 忽略 */
  }
}

function classifyFetchError(error, url, timeoutMs) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code ?? '';
  const message = cause?.message ?? error?.message ?? String(error);

  if (error?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || /timeout/i.test(message)) {
    return new HttpError(`超时 (${timeoutMs}ms)`, { code: 'timeout', url, cause: error });
  }
  if (error?.name === 'AbortError') {
    return new HttpError('请求已取消', { code: 'aborted', url, cause: error });
  }
  return new HttpError(`网络错误：${code || message}`, { code: 'network', url, cause: error });
}

/**
 * 经 HTTP 代理请求：CONNECT 隧道 + 可选 TLS。
 *
 * 导出给 src/bt/tracker.mjs 复用（tracker 也需要走代理），保证两条路径行为一致。
 */
export async function requestViaProxy(url, { proxy, headers, timeoutMs, maxBytes, signal, method }) {
  let current = new URL(url);

  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await singleProxyRequest(current, { proxy, headers, timeoutMs, maxBytes, signal, method });

    if (REDIRECT_STATUS.has(response.status) && response.headers.location) {
      const next = new URL(response.headers.location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new HttpError(`不支持的跳转协议：${next.protocol}`, { code: 'network', url: current.href });
      }
      current = next;
      continue;
    }

    if (response.status >= 400) {
      throw new HttpError(`HTTP ${response.status}`, { code: 'http_status', status: response.status, url: current.href });
    }
    return { ...response, url: current.href };
  }

  throw new HttpError('重定向次数过多', { code: 'network', url });
}

async function singleProxyRequest(target, { proxy, headers, timeoutMs, maxBytes, signal, method }) {
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port || (isHttps ? 443 : 80));
  const deadline = Date.now() + timeoutMs;

  const rawSocket = await connectViaProxy(proxy, target.hostname, port, timeoutMs, signal);
  let socket = rawSocket;
  if (isHttps) {
    socket = await tlsConnect(rawSocket, target.hostname, Math.max(1000, deadline - Date.now()), signal);
  }

  return await new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      socket.destroy();
      finish(reject, new HttpError(`超时 (${timeoutMs}ms)`, { code: 'timeout', url: target.href }));
    }, Math.max(1000, deadline - Date.now()));
    timer.unref?.();

    const request = mod.request(
      {
        method,
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, host: target.host, connection: 'close' },
        agent: false,
        setHost: false,
        createConnection: () => socket,
      },
      (response) => {
        const chunks = [];
        let total = 0;

        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            request.destroy();
            finish(reject, new HttpError(`响应超过大小上限 (${Math.round(maxBytes / 1024)} KiB)`, { code: 'too_large', url: target.href }));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          const body = Buffer.concat(chunks);
          decompress(body, response.headers['content-encoding'])
            .then((decoded) => {
              finish(resolve, {
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: decoded,
                url: target.href,
              });
            })
            .catch((error) => finish(reject, new HttpError(`解压失败：${error.message}`, { code: 'network', url: target.href, cause: error })));
        });

        response.on('error', (error) => {
          finish(reject, new HttpError(`网络错误：${error.message}`, { code: 'network', url: target.href, cause: error }));
        });
      },
    );

    request.on('error', (error) => {
      socket.destroy();
      finish(reject, new HttpError(`网络错误：${error.code || error.message}`, { code: 'network', url: target.href, cause: error }));
    });

    if (signal) {
      const onAbort = () => {
        request.destroy();
        socket.destroy();
        finish(reject, new HttpError('请求已取消', { code: 'aborted', url: target.href }));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    request.end();
  });
}

function connectViaProxy(proxy, hostname, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const mod = proxy.protocol === 'https:' ? https : http;
    const request = mod.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: `${hostname}:${port}`,
      headers: { host: `${hostname}:${port}`, 'proxy-connection': 'keep-alive' },
      agent: false,
      timeout: timeoutMs,
    });

    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new HttpError(`代理拒绝 CONNECT：HTTP ${response.statusCode}`, { code: 'network', status: response.statusCode }));
        return;
      }
      socket.setNoDelay?.(true);
      resolve(socket);
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new HttpError(`代理连接超时 (${timeoutMs}ms)`, { code: 'timeout' }));
    });

    request.on('error', (error) => {
      reject(new HttpError(`代理连接失败：${error.code || error.message}`, { code: 'network', cause: error }));
    });

    if (signal) {
      if (signal.aborted) {
        request.destroy();
        reject(new HttpError('请求已取消', { code: 'aborted' }));
        return;
      }
      signal.addEventListener('abort', () => request.destroy(), { once: true });
    }

    request.end();
  });
}

function tlsConnect(socket, servername, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] }, () => {
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new HttpError(`TLS 握手超时 (${timeoutMs}ms)`, { code: 'timeout' }));
    }, timeoutMs);
    timer.unref?.();

    tlsSocket.on('error', (error) => {
      clearTimeout(timer);
      reject(new HttpError(`TLS 握手失败：${error.code || error.message}`, { code: 'network', cause: error }));
    });

    if (signal) signal.addEventListener('abort', () => tlsSocket.destroy(), { once: true });
  });
}

async function decompress(buffer, encoding) {
  const value = String(encoding ?? '').toLowerCase();
  if (buffer.length === 0) return buffer;

  if (value.includes('gzip')) return zlib.gunzipSync(buffer);
  if (value.includes('br')) return zlib.brotliDecompressSync(buffer);
  if (value.includes('zstd')) return zlib.zstdDecompressSync(buffer);
  if (value.includes('deflate')) {
    try {
      return zlib.inflateSync(buffer);
    } catch {
      return zlib.inflateRawSync(buffer);
    }
  }
  return buffer;
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 120);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
