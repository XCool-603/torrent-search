/**
 * Tracker 交互：HTTP(S)（BEP 3 + 紧凑 peer 列表 BEP 23）与 UDP（BEP 15）。
 *
 * 为什么两种都要：公开种子里的 tracker 大量是 `udp://`，只支持 HTTP 会显著减少能拿到的 peer。
 * UDP 走不了 HTTP 代理（这是协议限制），失败只记日志不影响其它 tracker。
 */

import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { decode } from './bencode.mjs';

/** UDP tracker 协议魔数（BEP 15） */
const UDP_MAGIC = 0x41727101980n;
const UDP_ACTION_CONNECT = 0;
const UDP_ACTION_ANNOUNCE = 1;

/**
 * @typedef {object} AnnounceResult
 * @property {string} tracker
 * @property {boolean} ok
 * @property {Array<{host: string, port: number}>} peers
 * @property {number|null} interval
 * @property {number|null} complete 做种数
 * @property {number|null} incomplete 下载数
 * @property {string|null} error
 */

/**
 * 向一个 tracker 发起 announce。
 *
 * @param {{
 *   trackerUrl: string,
 *   infoHash: string,          // 小写 40 位 hex
 *   peerId: Buffer,            // 20 字节
 *   port: number,
 *   uploaded?: number,
 *   downloaded?: number,
 *   left?: number,
 *   event?: ''|'started'|'completed'|'stopped',
 *   numwant?: number,
 *   timeoutMs?: number,
 *   proxy?: URL|null,
 * }} options
 * @returns {Promise<AnnounceResult>}
 */
export async function announce(options) {
  const base = { tracker: options.trackerUrl, ok: false, peers: [], interval: null, complete: null, incomplete: null, error: null };

  try {
    const protocol = new URL(options.trackerUrl).protocol;
    if (protocol === 'udp:') return { ...base, ...(await announceUdp(options)) };
    if (protocol === 'http:' || protocol === 'https:') return { ...base, ...(await announceHttp(options)) };
    return { ...base, error: `不支持的 tracker 协议：${protocol}` };
  } catch (error) {
    return { ...base, error: error?.message ?? String(error) };
  }
}

/**
 * 对一组 tracker 并发 announce，合并去重 peer。
 *
 * @param {Parameters<typeof announce>[0] & {trackerUrls: string[]}} options
 * @returns {Promise<{peers: Array<{host: string, port: number}>, results: AnnounceResult[]}>}
 */
export async function announceAll(options) {
  const { trackerUrls, ...rest } = options;
  const results = await Promise.all(trackerUrls.map((trackerUrl) => announce({ ...rest, trackerUrl })));

  const seen = new Set();
  const peers = [];
  for (const result of results) {
    for (const peer of result.peers) {
      const key = `${peer.host}:${peer.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      peers.push(peer);
    }
  }

  return { peers, results };
}

/**
 * HTTP(S) tracker。
 *
 * @param {Parameters<typeof announce>[0]} options
 */
async function announceHttp(options) {
  const infoHash = Buffer.from(options.infoHash, 'hex');
  const url = buildAnnounceUrl(options.trackerUrl, {
    info_hash: infoHash,
    peer_id: options.peerId,
    port: options.port,
    uploaded: options.uploaded ?? 0,
    downloaded: options.downloaded ?? 0,
    left: options.left ?? 16_384,
    compact: 1,
    numwant: options.numwant ?? 50,
    ...(options.event ? { event: options.event } : {}),
  });

  const body = await httpGet(url, { timeoutMs: options.timeoutMs ?? 12_000, proxy: options.proxy ?? null });
  const response = decode(body, 0).value;

  if (response['failure reason']) {
    return { ok: false, peers: [], interval: null, complete: null, incomplete: null, error: String(response['failure reason']) };
  }

  return {
    ok: true,
    peers: parsePeers(response.peers, response.peers6),
    interval: toNumber(response.interval),
    complete: toNumber(response.complete),
    incomplete: toNumber(response.incomplete),
    error: null,
  };
}

/**
 * 构造 announce URL。`info_hash` / `peer_id` 是二进制，必须按字节百分号编码，
 * 不能走 encodeURIComponent（会把 UTF-8 之外的字节弄坏）。
 *
 * @param {string} trackerUrl
 * @param {Record<string, string|number|Buffer>} params
 * @returns {string}
 */
export function buildAnnounceUrl(trackerUrl, params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${Buffer.isBuffer(value) ? percentEncodeBytes(value) : encodeURIComponent(String(value))}`);
  }

  const separator = trackerUrl.includes('?') ? '&' : '?';
  return `${trackerUrl}${separator}${parts.join('&')}`;
}

/**
 * 按 RFC 3986 做百分号编码（非保留字节才保留原样）。
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function percentEncodeBytes(bytes) {
  let out = '';
  for (const byte of bytes) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e; // - _ . ~
    out += isUnreserved ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return out;
}

/**
 * 解析 tracker 返回的 peer 列表：紧凑格式（BEP 23）与字典数组两种都要支持。
 *
 * @param {string|Array<any>|undefined} peers
 * @param {string|undefined} peers6
 * @returns {Array<{host: string, port: number}>}
 */
export function parsePeers(peers, peers6) {
  const out = [];

  if (typeof peers === 'string') {
    const bytes = Buffer.from(peers, 'latin1');
    for (let offset = 0; offset + 6 <= bytes.length; offset += 6) {
      const host = `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
      const port = bytes.readUInt16BE(offset + 4);
      if (port > 0) out.push({ host, port });
    }
  } else if (Array.isArray(peers)) {
    for (const entry of peers) {
      if (!entry || typeof entry !== 'object') continue;
      const host = String(entry.ip ?? '');
      const port = Number(entry.port);
      if (host && Number.isFinite(port) && port > 0) out.push({ host, port });
    }
  }

  if (typeof peers6 === 'string') {
    const bytes = Buffer.from(peers6, 'latin1');
    for (let offset = 0; offset + 18 <= bytes.length; offset += 18) {
      const groups = [];
      for (let index = 0; index < 8; index += 1) groups.push(bytes.readUInt16BE(offset + index * 2).toString(16));
      const port = bytes.readUInt16BE(offset + 16);
      if (port > 0) out.push({ host: groups.join(':'), port });
    }
  }

  return out;
}

/**
 * UDP tracker（BEP 15）。
 *
 * @param {Parameters<typeof announce>[0]} options
 */
async function announceUdp(options) {
  const url = new URL(options.trackerUrl);
  const host = url.hostname;
  const port = Number(url.port || 80);
  const timeoutMs = options.timeoutMs ?? 8000;

  const socket = dgram.createSocket(url.protocol === 'udp:' ? (host.includes(':') ? 'udp6' : 'udp4') : 'udp4');

  try {
    const connectionId = await udpConnect(socket, host, port, timeoutMs);
    const response = await udpAnnounce(socket, host, port, connectionId, options, timeoutMs);

    return {
      ok: true,
      peers: response.peers,
      interval: response.interval,
      complete: response.seeders,
      incomplete: response.leechers,
      error: null,
    };
  } finally {
    socket.close();
  }
}

function udpConnect(socket, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transactionId = crypto.randomBytes(4).readUInt32BE(0);
    const packet = Buffer.alloc(16);
    packet.writeBigUInt64BE(UDP_MAGIC, 0);
    packet.writeUInt32BE(UDP_ACTION_CONNECT, 8);
    packet.writeUInt32BE(transactionId, 12);

    const onMessage = (message) => {
      if (message.length < 16 || message.readUInt32BE(0) !== UDP_ACTION_CONNECT || message.readUInt32BE(4) !== transactionId) return;
      cleanup();
      resolve(message.readBigUInt64BE(8));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('UDP tracker 连接超时'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.send(packet, port, host, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

function udpAnnounce(socket, host, port, connectionId, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transactionId = crypto.randomBytes(4).readUInt32BE(0);
    const eventCode = { '': 0, none: 0, completed: 1, started: 2, stopped: 3 }[options.event ?? ''] ?? 0;

    const packet = Buffer.alloc(98);
    packet.writeBigUInt64BE(connectionId, 0);
    packet.writeUInt32BE(UDP_ACTION_ANNOUNCE, 8);
    packet.writeUInt32BE(transactionId, 12);
    Buffer.from(options.infoHash, 'hex').copy(packet, 16);
    options.peerId.copy(packet, 36);
    packet.writeBigUInt64BE(BigInt(options.downloaded ?? 0), 56);
    packet.writeBigUInt64BE(BigInt(options.left ?? 16_384), 64);
    packet.writeBigUInt64BE(BigInt(options.uploaded ?? 0), 72);
    packet.writeUInt32BE(eventCode, 80);
    packet.writeUInt32BE(0, 84); // ip
    packet.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 88); // key
    packet.writeInt32BE(options.numwant ?? 50, 92);
    packet.writeUInt16BE(options.port, 96);

    const onMessage = (message) => {
      if (message.length < 20 || message.readUInt32BE(0) !== UDP_ACTION_ANNOUNCE || message.readUInt32BE(4) !== transactionId) return;
      cleanup();

      const interval = message.readUInt32BE(8);
      const leechers = message.readUInt32BE(12);
      const seeders = message.readUInt32BE(16);

      const peers = [];
      for (let offset = 20; offset + 6 <= message.length; offset += 6) {
        const ip = `${message[offset]}.${message[offset + 1]}.${message[offset + 2]}.${message[offset + 3]}`;
        const peerPort = message.readUInt16BE(offset + 4);
        if (peerPort > 0) peers.push({ host: ip, port: peerPort });
      }

      resolve({ interval, leechers, seeders, peers });
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('UDP tracker announce 超时'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.send(packet, port, host, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

/**
 * 极简 HTTP GET（返回 Buffer）。
 *
 * 为什么不复用 src/http.mjs：tracker 的 `info_hash` 需要自定义百分号编码，
 * 且响应是 bencode 不是 JSON/文本；但**代理能力**直接复用那边的 CONNECT 隧道实现，
 * 避免两套实现行为不一致。
 *
 * 说明：UDP tracker 无法走 HTTP 代理（协议限制），仍直连。
 *
 * @param {string} url
 * @param {{timeoutMs: number, proxy: URL|null}} options
 */
async function httpGet(url, options) {
  if (options.proxy) {
    // 复用搜索侧的 CONNECT 隧道实现（src/http.mjs），行为保持一致
    const { requestViaProxy } = await import('../http.mjs');
    const response = await requestViaProxy(url, {
      proxy: options.proxy,
      headers: { 'user-agent': 'torrent-search/1.0', accept: '*/*', connection: 'close' },
      timeoutMs: options.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
    });
    if (response.status >= 400) {
      throw new Error(`tracker 返回 HTTP ${response.status}`);
    }
    return response.body;
  }

  return rawHttpGet(url, options);
}

function rawHttpGet(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;

    const request = mod.request(
      {
        method: 'GET',
        host: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: { 'user-agent': 'torrent-search/1.0', accept: '*/*', connection: 'close' },
        timeout: options.timeoutMs,
      },
      (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          // tracker 跳转很常见，跟随一次即可
          httpGet(new URL(response.headers.location, target), options).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`tracker 返回 HTTP ${response.statusCode}`));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('tracker 请求超时'));
    });
    request.on('error', reject);
    request.end();
  });
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
