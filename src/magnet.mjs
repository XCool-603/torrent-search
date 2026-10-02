/**
 * 磁力链接（magnet URI）与 info hash 处理。
 *
 * 关键点：dmhy 等站点用 Base32 表示 btih（32 个字符），而 apibay/nyaa/bitsearch 用 40 位十六进制。
 * 去重必须以统一形式（小写 40 位 hex）为键，否则同一种子会重复出现。
 */

import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32（RFC 4648，无 padding）→ 小写 hex。用于 dmhy 的 btih。
 *
 * @param {string} input
 * @returns {string|null} 40 位 hex，或 null（非法输入）
 */
export function base32ToHex(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toUpperCase().replace(/=+$/, '');
  // btih 的 Base32 形式恰好是 20 字节 → 32 个字符；多一个少一个都不接受
  if (text.length !== 32 || !/^[A-Z2-7]+$/.test(text)) return null;

  let bits = '';
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    bits += index.toString(2).padStart(5, '0');
  }

  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  // 20 字节 = 160 bit = 40 位 hex
  return hex.length === 40 ? hex : null;
}

/**
 * 归一化 info hash：接受 40 位 hex（任意大小写）或 32 位 Base32。
 *
 * @param {string|null|undefined} value
 * @returns {string|null} 小写 40 位 hex 或 null
 */
export function normalizeInfoHash(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/^urn:btih:/i, '');
  if (text === '') return null;

  if (/^[0-9a-fA-F]{40}$/.test(text)) return text.toLowerCase();
  if (/^[0-9a-zA-Z]{32}$/.test(text)) return base32ToHex(text);

  return null;
}

/**
 * 判断是否为合法 info hash。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInfoHash(value) {
  return normalizeInfoHash(value) !== null;
}

/**
 * 构造磁力链接。
 *
 * @param {{infoHash?: string|null, name?: string|null, trackers?: string[]}} params
 * @returns {string|null}
 */
export function buildMagnet({ infoHash, name, trackers = [] } = {}) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return null;

  const parts = [`magnet:?xt=urn:btih:${hash}`];
  if (name) parts.push(`dn=${encodeURIComponent(name)}`);
  for (const tracker of trackers) {
    if (typeof tracker === 'string' && tracker.trim() !== '') {
      parts.push(`tr=${encodeURIComponent(tracker.trim())}`);
    }
  }
  return parts.join('&');
}

/**
 * 解析磁力链接。
 *
 * @param {string} uri
 * @returns {{infoHash: string|null, name: string|null, trackers: string[]}|null}
 */
export function parseMagnet(uri) {
  if (typeof uri !== 'string') return null;
  const text = uri.trim();
  if (!/^magnet:\?/i.test(text)) return null;

  let params;
  try {
    params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
  } catch {
    return null;
  }

  let infoHash = null;
  const xtValues = params.getAll('xt');
  for (const xt of xtValues) {
    const hash = normalizeInfoHash(xt);
    if (hash) {
      infoHash = hash;
      break;
    }
  }

  return {
    infoHash,
    name: params.get('dn') || null,
    trackers: params.getAll('tr').filter(Boolean),
  };
}

/**
 * 从任意文本中提取第一个磁力链接（dmhy 的 description 里混着 HTML）。
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function extractMagnet(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/magnet:\?[^\s"'<>]+/i);
  if (!match) return null;
  // HTML 实体还原后再交给 URLSearchParams
  return match[0].replace(/&amp;/g, '&').replace(/&#0?38;/g, '&');
}

/**
 * 给磁力链接补充 tracker（用于站点只给 hash 的情况）。
 *
 * @param {string|null} magnet
 * @param {string[]} trackers
 * @returns {string|null}
 */
export function withTrackers(magnet, trackers = []) {
  if (!magnet) return null;
  const parsed = parseMagnet(magnet);
  if (!parsed || !parsed.infoHash) return magnet;

  const existing = new Set(parsed.trackers);
  const merged = [...parsed.trackers];
  for (const tracker of trackers) {
    if (tracker && !existing.has(tracker)) {
      existing.add(tracker);
      merged.push(tracker);
    }
  }
  return buildMagnet({ infoHash: parsed.infoHash, name: parsed.name, trackers: merged });
}

/**
 * 解析用户给的「下载目标」：磁力链接、40 位 hex、32 位 Base32 都可以。
 *
 * @param {string} input
 * @returns {{infoHash: string, trackers: string[], name: string|null, magnet: string}}
 */
export function parseMagnetInput(input) {
  const text = String(input ?? '').trim();
  if (text === '') throw new Error('请提供磁力链接或 info hash');

  if (/^magnet:\?/i.test(text)) {
    const parsed = parseMagnet(text);
    if (!parsed?.infoHash) throw new Error('磁力链接里没有合法的 info hash');
    return { infoHash: parsed.infoHash, trackers: parsed.trackers, name: parsed.name, magnet: text };
  }

  const infoHash = normalizeInfoHash(text);
  if (!infoHash) throw new Error(`既不是磁力链接、也不是合法的 info hash：${text.slice(0, 60)}`);

  return { infoHash, trackers: [], name: null, magnet: buildMagnet({ infoHash }) };
}

/**
 * 稳定的短 id（当站点不提供 info hash 时用于去重）。
 *
 * @param {string} input
 * @param {number} [length]
 * @returns {string}
 */
export function shortHash(input, length = 16) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, length);
}
