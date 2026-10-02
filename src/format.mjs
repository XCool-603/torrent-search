/**
 * 终端表格渲染（含中英文混排宽度处理）。
 *
 * 为什么要自己算宽度：中文/全角字符占 2 列，用 String#length 对齐会错位。
 * 这里按 Unicode East Asian Width 的常用区间近似判断（足够覆盖中日常用字与全角标点）。
 */

import { formatBytes, formatRelativeTime } from './size.mjs';

/**
 * 字符串在终端里占用的列数。
 *
 * @param {string} text
 * @returns {number}
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 韩文字母
    (code >= 0x2e80 && code <= 0x303e) || // 中日韩部首、标点
    (code >= 0x3041 && code <= 0x33ff) || // 平假名/片假名/注音/兼容字符
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xfe30 && code <= 0xfe6f) || // 兼容标点
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) || // emoji
    (code >= 0x20000 && code <= 0x3fffd) // 扩展 B 及以上
  );
}

/**
 * 按显示宽度截断，超出部分用省略号。
 *
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string}
 */
export function truncateDisplay(text, maxWidth) {
  const value = String(text ?? '');
  if (maxWidth <= 0) return '';
  if (displayWidth(value) <= maxWidth) return value;

  let result = '';
  let width = 0;
  for (const char of value) {
    const charWidth = isWide(char.codePointAt(0)) ? 2 : 1;
    if (width + charWidth > maxWidth - 1) break;
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}

/**
 * 按显示宽度补空格对齐。
 *
 * @param {string} text
 * @param {number} width
 * @param {'left'|'right'} [align]
 * @returns {string}
 */
export function padDisplay(text, width, align = 'left') {
  const value = String(text ?? '');
  const padding = Math.max(0, width - displayWidth(value));
  return align === 'right' ? ' '.repeat(padding) + value : value + ' '.repeat(padding);
}

/**
 * 创建着色函数；`enabled` 为 false 时原样返回。
 *
 * @param {boolean} enabled
 * @returns {(code: string) => (text: string|number) => string}
 */
export function createColorizer(enabled) {
  return (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text));
}

export const COLORS = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  gray: '90',
};

/**
 * 渲染搜索结果表格。
 *
 * @param {Array<import('./models.mjs').TorrentResult & {sources?: string[]}>} results
 * @param {{width?: number, color?: (code: string) => (text: any) => string}} [options]
 * @returns {string}
 */
export function renderResultsTable(results, options = {}) {
  const color = options.color ?? createColorizer(false);
  const totalWidth = Math.max(80, Math.min(options.width ?? process.stdout.columns ?? 120, 240));

  const fixed = 3 + 9 + 6 + 6 + 16 + 10 + 6; // 序号/体积/做种/下载/来源/时间/间隔
  const titleWidth = Math.max(24, totalWidth - fixed);

  const lines = [];

  const header = [
    padDisplay('#', 3),
    padDisplay('标题', titleWidth),
    padDisplay('体积', 9, 'right'),
    padDisplay('做种', 6, 'right'),
    padDisplay('下载', 6, 'right'),
    padDisplay('来源', 16),
    padDisplay('时间', 10),
  ].join('  ');

  lines.push(color(COLORS.bold)(header));
  lines.push(color(COLORS.gray)('─'.repeat(Math.min(totalWidth, displayWidth(header)))));

  results.forEach((result, index) => {
    const seeders = result.seeders;
    const seederText = seeders === null || seeders === undefined ? '-' : String(seeders);
    const seederColor = seeders === null || seeders === undefined ? COLORS.gray : seeders >= 10 ? COLORS.green : seeders > 0 ? COLORS.yellow : COLORS.red;

    const sourceText = (result.sources && result.sources.length > 1 ? result.sources.join('+') : result.source) ?? '';

    lines.push(
      [
        padDisplay(String(index + 1), 3),
        padDisplay(truncateDisplay(result.title, titleWidth), titleWidth),
        padDisplay(result.sizeText ?? formatBytes(result.size) ?? '-', 9, 'right'),
        color(seederColor)(padDisplay(seederText, 6, 'right')),
        padDisplay(result.leechers === null || result.leechers === undefined ? '-' : String(result.leechers), 6, 'right'),
        padDisplay(truncateDisplay(sourceText, 16), 16),
        padDisplay(formatRelativeTime(result.publishedAt), 10),
      ].join('  '),
    );
  });

  return lines.join('\n');
}

/**
 * 渲染数据源状态一行摘要。
 *
 * @param {Array<{id: string, name: string, ok: boolean, count: number, tookMs: number, error: string|null, cached?: boolean}>} statuses
 * @param {{color?: (code: string) => (text: any) => string}} [options]
 * @returns {string}
 */
export function renderSourceStatus(statuses, options = {}) {
  const color = options.color ?? createColorizer(false);

  return statuses
    .map((status) => {
      const label = `${status.id}`;
      if (!status.ok) return color(COLORS.red)(`${label} ✗ ${status.error ?? '失败'}`);
      const cached = status.cached ? ' 缓存' : '';
      return color(COLORS.green)(`${label} ✓ ${status.count} 条 ${status.tookMs}ms${cached}`);
    })
    .join(color(COLORS.gray)('  ·  '));
}
