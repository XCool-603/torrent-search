/**
 * 体积（字节）解析与格式化工具。
 *
 * 设计要点：
 * - 不同站点给的体积格式五花八门：apibay 给原始字节数字符串、nyaa 给 "624.0 MiB"、
 *   bitsearch 给 JSON 数字、academic 给 XML 数字。这里统一解析成字节整数。
 * - KiB/MiB/GiB 按 1024 进制，KB/MB/GB 按 1000 进制（站点用哪个就按哪个算，不做"纠正"）。
 */

const UNIT_FACTORS = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  pb: 1000 ** 5,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/**
 * 把站点给的体积文本解析成字节数。
 * 支持：数字、数字字符串、"3.40 GiB"、"624.0 MiB"、"1,024 MB"、null/非法值（返回 null）。
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null} 字节数（非负整数）或 null
 */
export function parseSizeText(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }

  const text = String(value).trim().replace(/,/g, '');
  if (text === '') return null;

  // 纯数字（apibay / academic 的原始字节）
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  const m = text.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if (!m) return null;

  const amount = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factor = UNIT_FACTORS[unit];
  if (!Number.isFinite(amount) || factor === undefined) return null;

  return Math.round(amount * factor);
}

/**
 * 把字节数格式化成人类可读文本（1024 进制，默认 2 位小数）。
 *
 * @param {number|null|undefined} bytes
 * @param {{decimals?: number, space?: boolean}} [options]
 * @returns {string|null}
 */
export function formatBytes(bytes, options = {}) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  const { decimals = 2, space = true } = options;

  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < BINARY_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fixed = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(decimals);
  const separator = space ? ' ' : '';
  return `${negative ? '-' : ''}${fixed}${separator}${BINARY_UNITS[unitIndex]}`;
}

/**
 * 解析各种时间表示：unix 秒/毫秒、ISO 字符串、RFC822（RSS pubDate）。
 *
 * @param {string|number|null|undefined} value
 * @returns {string|null} ISO 8601 字符串或 null
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000; // 秒 vs 毫秒
    return toIso(ms);
  }

  const text = String(value).trim();
  if (text === '') return null;

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return null;
    return toIso(n > 1e12 ? n : n * 1000);
  }

  // 无时区的 ISO（mikan 的 2026-08-11T18:47:25.461386）：按 UTC+8 解释，这是该站的本地时间
  const naive = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
  if (naive) {
    const ms = Date.parse(`${naive[1]}T${naive[2]}${naive[3] ?? ''}+08:00`);
    return Number.isFinite(ms) ? toIso(ms) : null;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? toIso(parsed) : null;
}

function toIso(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  // 超出合理范围（1970-01-01 ~ 2100）视为脏数据
  if (d.getTime() < 0 || d.getTime() > 4102444800000) return null;
  return d.toISOString();
}

/**
 * 把非负整数安全地转成 number，非法值返回 null。
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * 生成「3 天前」这类相对时间文本（CLI 用）。
 *
 * @param {string|null} iso
 * @returns {string}
 */
export function formatRelativeTime(iso) {
  if (!iso) return '-';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';

  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 0) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)} 天前`;
  if (diffSec < 86400 * 365) return `${Math.floor(diffSec / (86400 * 30))} 个月前`;
  return `${Math.floor(diffSec / (86400 * 365))} 年前`;
}
