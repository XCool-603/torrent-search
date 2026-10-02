/**
 * DHT（BEP 5）最小实现：只做「下载侧」需要的能力——
 * 用 get_peers 为一个 info hash 找 peer，以及作为旁节点回应 ping/find_node，
 * 让自己在 DHT 网络里是个"会说人话"的节点。
 *
 * 刻意不做：
 *   - announce_peer（我们是下载方，不需要向 DHT 声明自己有这个种子）；
 *   - 完整 K 桶路由表持久化（每次查询从 bootstrap 节点重新迭代查找即可，
 *     对一次性下载足够，避免维护一大坨节点状态）；
 *   - IPv6 DHT。
 *
 * 关键约束：DHT 走 UDP，**无法经 HTTP 代理**（协议限制）；代理环境下 DHT 会失败，
 * 因此调用方必须把 DHT 当"尽力而为的补充"，不能让它成为唯一通路。
 */

import dgram from 'node:dgram';
import crypto from 'node:crypto';

import { encode, decode } from './bencode.mjs';

/** 公开 bootstrap 节点（这些主机名的解析走普通 DNS，可经代理的 DNS 不受影响） */
export const BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.aelitis.com', port: 6881 }, // Vuze
];

/** KRPC 方法名（BEP 5） */
export const DHT_QUERY = { PING: 'ping', FIND_NODE: 'find_node', GET_PEERS: 'get_peers', ANNOUNCE: 'announce_peer' };

/**
 * 生成 DHT 节点 ID（20 字节）。真实实现里 ID 应稳定持久，这里每次随机即可：
 * 我们不向 DHT 声明任何资源，ID 不稳定没有副作用。
 *
 * @returns {Buffer}
 */
export function generateNodeId() {
  return crypto.randomBytes(20);
}

/**
 * @param {string} host IPv4 地址字符串
 * @returns {Buffer|null} 4 字节 IP，非法返回 null
 */
export function ipToBytes(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4) return null;

  const bytes = Buffer.alloc(4);
  for (let index = 0; index < 4; index += 1) {
    const value = Number(parts[index]);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

/**
 * 编码「紧凑节点信息」：20 字节 node id + 4 字节 IP + 2 字节端口（大端）。
 *
 * @param {{id: Buffer, host: string, port: number}} node
 * @returns {Buffer}
 */
export function encodeNodeInfo(node) {
  const ip = ipToBytes(node.host);
  if (!ip) throw new Error(`节点 IP 非法：${node.host}`);
  if (!Buffer.isBuffer(node.id) || node.id.length !== 20) throw new Error('节点 ID 必须是 20 字节');

  const out = Buffer.alloc(26);
  node.id.copy(out, 0);
  ip.copy(out, 20);
  out.writeUInt16BE(node.port, 24);
  return out;
}

/**
 * 解析紧凑节点信息串。
 *
 * @param {string|undefined} raw latin1 字符串，26 字节一组
 * @returns {Array<{id: Buffer, host: string, port: number}>}
 */
export function decodeNodeInfo(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const bytes = Buffer.from(raw, 'latin1');
  const out = [];

  for (let offset = 0; offset + 26 <= bytes.length; offset += 26) {
    const id = bytes.subarray(offset, offset + 20);
    const host = `${bytes[offset + 20]}.${bytes[offset + 21]}.${bytes[offset + 22]}.${bytes[offset + 23]}`;
    const port = bytes.readUInt16BE(offset + 24);
    if (port > 0) out.push({ id: Buffer.from(id), host, port });
  }

  return out;
}

/**
 * XOR 距离（Kademlia）：距离越小越接近目标。返回 20 字节 buffer，用 Buffer.compare 比较大小。
 *
 * @param {Buffer|string} a
 * @param {Buffer|string} b
 * @returns {Buffer}
 */
export function distance(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, 'hex');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, 'hex');
  const out = Buffer.alloc(Math.min(left.length, right.length));
  for (let index = 0; index < out.length; index += 1) out[index] = left[index] ^ right[index];
  return out;
}

/**
 * 单次 KRPC 查询（发一个 bencoded 字典到 UDP，等一个响应）。
 *
 * @param {{socket: import('node:dgram').Socket, host: string, port: number, payload: Record<string, any>, timeoutMs: number, logger?: Function}} params
 * @returns {Promise<Record<string, any>|null>} 响应字典，超时返回 null
 */
function rpcQuery({ socket, host, port, payload, timeoutMs, logger }) {
  const transactionId = crypto.randomBytes(2).toString('hex');
  const message = encode({ t: transactionId, y: 'q', ...payload });

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };

    const timer = setTimeout(() => {
      logger?.(`DHT 查询超时：${host}:${port}`);
      finish(null);
    }, timeoutMs);

    const onMessage = (message_, remote) => {
      if (remote.port !== port || remote.address !== host) return;

      let parsed;
      try {
        parsed = decode(message_, 0).value;
      } catch {
        return;
      }
      if (parsed?.t !== transactionId) return;
      finish(parsed);
    };

    socket.on('message', onMessage);
    socket.send(message, port, host, (error) => {
      if (error) {
        logger?.(`DHT 发送失败：${host}:${port} ${error.message}`);
        finish(null);
      }
    });
  });
}

/**
 * 一次 get_peers 查询的结果。
 *
 * @typedef {object} GetPeersResult
 * @property {Array<{host: string, port: number}>} peers 直接拿到 peer 的情况
 * @property {Array<{id: Buffer, host: string, port: number}>} nodes 需要继续逼近的情况
 * @property {string|null} token announce_peer 用的 token（本实现不使用）
 */

/**
 * 对单个节点发 get_peers。
 *
 * @returns {Promise<GetPeersResult|null>}
 */
async function getPeersFrom({ socket, node, infoHash, nodeId, timeoutMs, logger }) {
  const payload = {
    q: DHT_QUERY.GET_PEERS,
    a: { id: nodeId.toString('latin1'), info_hash: Buffer.from(infoHash, 'hex').toString('latin1') },
  };

  const response = await rpcQuery({ socket, host: node.host, port: node.port, payload, timeoutMs, logger });
  if (!response || response.y !== 'r') return null;

  const body = response.r ?? {};
  const peers = parseCompactPeers(body.values);
  const nodes = decodeNodeInfo(body.nodes);

  return { peers, nodes, token: typeof body.token === 'string' ? body.token : null };
}

/**
 * 解析紧凑 peer 列表（BEP 23）：6 字节一组（IPv4 + 端口）。
 *
 * @param {Array|undefined} values
 * @returns {Array<{host: string, port: number}>}
 */
function parseCompactPeers(values) {
  if (!Array.isArray(values)) return [];
  const out = [];

  for (const entry of values) {
    const bytes = typeof entry === 'string' ? Buffer.from(entry, 'latin1') : Buffer.isBuffer(entry) ? entry : null;
    if (!bytes || bytes.length < 6) continue;
    const host = `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
    const port = bytes.readUInt16BE(4);
    if (port > 0) out.push({ host, port });
  }

  return out;
}

/**
 * 用 DHT 为一个 info hash 找 peer（迭代查找，最多 lookups 轮）。
 *
 * @param {string} infoHash
 * @param {{bootstrap?: Array<{host: string, port: number}>, nodeId?: Buffer, timeoutMs?: number, perQueryTimeoutMs?: number, maxRounds?: number, maxNodes?: number, logger?: Function, socket?: import('node:dgram').Socket}} [options]
 * @returns {Promise<Array<{host: string, port: number}>>} 找到的 peer（去重，可能为空）
 */
export async function dhtGetPeers(infoHash, options = {}) {
  const hash = Buffer.from(String(infoHash), 'hex');
  if (hash.length !== 20) throw new Error(`info hash 必须是 40 位 hex：${infoHash}`);

  const logger = options.logger ?? (() => {});
  const nodeId = options.nodeId ?? generateNodeId();
  const overallMs = options.timeoutMs ?? 10_000;
  const perQueryMs = options.perQueryTimeoutMs ?? 2_500;
  const maxRounds = options.maxRounds ?? 4;
  const maxNodesPerRound = options.maxNodes ?? 16;

  const socket = options.socket ?? dgram.createSocket('udp4');
  const ownsSocket = !options.socket;

  if (ownsSocket) {
    await new Promise((resolve) => {
      const onError = () => resolve();
      socket.once('error', onError);
      socket.bind(0, () => {
        socket.off('error', onError);
        resolve();
      });
    });
  }

  const deadline = Date.now() + overallMs;
  const peers = new Map();
  const seen = new Set();
  const errored = new Set();

  let frontier = [...(options.bootstrap ?? BOOTSTRAP_NODES)].map((node) => ({ ...node }));
  let responded = 0;
  let nodesSeen = 0;

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      if (Date.now() > deadline) break;

      const candidates = frontier
        .filter((node) => !seen.has(`${node.host}:${node.port}`) && !errored.has(`${node.host}:${node.port}`))
        .slice(0, maxNodesPerRound);

      if (candidates.length === 0) break;

      const pending = candidates.map(async (node) => {
        seen.add(`${node.host}:${node.port}`);

        const result = await getPeersFrom({ socket, node, infoHash, nodeId, timeoutMs: perQueryMs, logger });
        if (!result) {
          errored.add(`${node.host}:${node.port}`);
          return [];
        }
        responded += 1;

        for (const peer of result.peers) peers.set(`${peer.host}:${peer.port}`, peer);
        nodesSeen += result.nodes.length;
        return result.nodes;
      });

      const rounds = await Promise.all(pending);
      const nextNodes = rounds.flat();
      if (nextNodes.length === 0) break;

      // 按到目标的距离排序，只保留最近的一批继续逼近
      frontier = nextNodes
        .filter((node) => !seen.has(`${node.host}:${node.port}`))
        .sort((a, b) => Buffer.compare(distance(a.id, hash), distance(b.id, hash)))
        .slice(0, maxNodesPerRound * 2);

      if (frontier.length === 0) break;
    }
  } finally {
    if (ownsSocket) {
      try {
        socket.close();
      } catch {
        /* 忽略 */
      }
    }
  }

  logger(`DHT 查找结束：响应 ${responded} 个节点，见到 ${nodesSeen} 个节点，拿到 ${peers.size} 个 peer`);
  return [...peers.values()];
}
