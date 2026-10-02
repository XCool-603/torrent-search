/**
 * 网络诊断（P2P 可用性）。
 *
 * 背景：BT 下载失败最常见的原因不是代码，而是网络环境——
 * 代理 TUN 模式接管全局路由后，机场普遍静默丢弃 P2P 流量（TCP 能连上，
 * 但 BT 握手数据有去无回）。用户看到"握手期间连接被关闭"完全不知道原因。
 *
 * 这个模块把"失败原因 → 可执行的修复建议"固化下来：
 *   - 检测本机是否有代理 TUN 虚拟网卡（Clash/Mihomo 的 Meta、fake-ip 段等）；
 *   - 把 peer 握手失败的错误分类，归纳出主导原因；
 *   - 生成一句中文建议，直接拼进下载失败的报错里。
 */

import os from 'node:os';

/** Clash/mihomo 的 fake-ip 基准段（198.18.0.0/15），TUN 网卡的典型特征 */
const FAKE_IP_RANGES = [
  { start: [198, 18, 0, 0], end: [198, 19, 255, 255] },
];

/** 常见代理 TUN 网卡名（收紧匹配，避免把普通 VPN 一律误判） */
const TUN_NAME_RE = /clash|mihomo|meta|tun\b|wintun|utun/i;

/**
 * 检测本机是否有代理 TUN 虚拟网卡。
 *
 * @param {Record<string, Array<{family: string, address: string, internal: boolean}>>|null} [interfaces] 便于测试注入
 * @returns {{detected: boolean, name?: string, address?: string, reason?: string}}
 */
export function detectTunAdapter(interfaces = null) {
  const list = interfaces ?? os.networkInterfaces();

  for (const [name, addresses] of Object.entries(list)) {
    if (!Array.isArray(addresses)) continue;

    for (const entry of addresses) {
      if (entry.internal || entry.family !== 'IPv4') continue;

      if (TUN_NAME_RE.test(name)) {
        return { detected: true, name, address: entry.address, reason: `网卡「${name}」疑似代理 TUN 虚拟网卡` };
      }
      if (isInFakeIpRange(entry.address)) {
        return { detected: true, name, address: entry.address, reason: `网卡「${name}」使用 fake-ip 段（${entry.address}），是代理 TUN 的典型特征` };
      }
    }
  }

  return { detected: false };
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
export function isInFakeIpRange(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) return false;

  return FAKE_IP_RANGES.some(({ start, end }) => {
    for (let index = 0; index < 4; index += 1) {
      if (parts[index] < start[index] || parts[index] > end[index]) return false;
    }
    return true;
  });
}

/**
 * 把单个 peer 失败信息分类。
 *
 * @param {string} message
 * @returns {'peer_dead'|'tcp_timeout'|'handshake_reset'|'handshake_timeout'|'other'}
 */
export function classifyPeerError(message) {
  const text = String(message ?? '');
  if (/ECONNREFUSED/i.test(text)) return 'peer_dead';
  if (/握手期间连接被关闭|ECONNRESET|EPIPE/i.test(text)) return 'handshake_reset';
  if (/握手超时/.test(text)) return 'handshake_timeout';
  if (/ETIMEDOUT|超时/i.test(text)) return 'tcp_timeout';
  return 'other';
}

/**
 * 归纳一批 peer 失败的主导原因。
 *
 * @param {string[]} errors 每个 peer 的失败原因（"host:port → 原因"或就是原因）
 * @returns {{dominant: string, counts: Record<string, number>, total: number}|null}
 */
export function summarizePeerFailures(errors) {
  const list = (errors ?? []).filter(Boolean);
  if (list.length === 0) return null;

  /** @type {Record<string, number>} */
  const counts = {};
  for (const error of list) {
    const kind = classifyPeerError(error);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return { dominant, counts, total: list.length };
}

const PEER_HINTS = {
  handshake_reset: 'TCP 能连上但 BT 握手数据被丢弃，这是代理/防火墙拦截 P2P 流量的典型表现',
  handshake_timeout: 'TCP 能连上但对端不回应握手，同样是 P2P 流量被拦截的典型表现',
  tcp_timeout: '网络层面无法到达这些 peer',
  peer_dead: 'tracker 返回的 peer 已下线（资源可能无人做种）',
  other: 'peer 连接失败',
};

/**
 * 生成给用户看的诊断结论（拼进下载失败的报错里）。
 *
 * @param {string[]} errors peer 失败原因列表
 * @param {{detected: boolean, name?: string, reason?: string}|null} [tun]
 * @returns {string} 多行建议；没有可说的就返回空字符串
 */
export function buildPeerFailureHint(errors, tun = null) {
  const summary = summarizePeerFailures(errors);
  if (!summary) return '';

  const lines = [];

  if (tun?.detected) {
    lines.push(`检测到本机存在代理 TUN 虚拟网卡：${tun.reason ?? tun.name ?? ''}`.trim());
  }

  const hint = PEER_HINTS[summary.dominant];
  if (hint) lines.push(`主要失败原因：${hint}（${summary.counts[summary.dominant]}/${summary.total} 个 peer 属于此类）`);

  if (summary.dominant === 'handshake_reset' || summary.dominant === 'handshake_timeout') {
    lines.push('建议：① 若在用 Clash 等代理的 TUN 模式，切换为「系统代理」模式或暂时关闭 TUN 后重试（BT 流量需要直连）；② 或改用 qBittorrent/aria2 等成熟客户端下载。');
  } else if (summary.dominant === 'peer_dead' || summary.dominant === 'tcp_timeout') {
    lines.push('建议：换一个做种更多的资源，或在 Clash 里确认 BT 流量未被拦截。');
  }

  return lines.join('\n');
}

/**
 * 生成"没拿到任何 peer"时的诊断结论（tracker/DHT 层面，而非 peer 层面）。
 *
 * @param {{detected: boolean, name?: string, reason?: string}|null} [tun]
 * @returns {string}
 */
export function buildNoPeersHint(tun = null) {
  const lines = [];

  if (tun?.detected) {
    lines.push(`检测到代理 TUN 虚拟网卡（${tun.name ?? '未知'}）：DHT 走 UDP、BT peer 走直连 TCP，都无法通过 HTTP 代理，很可能被整体拦截。`);
    lines.push('建议：切换 Clash 为「系统代理」模式或暂时关闭 TUN 后重试。');
  } else {
    lines.push('可能原因：tracker 失效且 DHT 不可达、该资源无人做种、或本机防火墙拦截了出站连接。');
  }

  return lines.join('\n');
}
