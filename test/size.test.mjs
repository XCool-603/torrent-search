import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSizeText, formatBytes, parseTimestamp, toCount, formatRelativeTime } from '../src/size.mjs';

test('parseSizeText 解析各种站点的体积写法', () => {
  assert.equal(parseSizeText('624.0 MiB'), 624 * 1024 ** 2);
  assert.equal(parseSizeText('3.40 GiB'), Math.round(3.4 * 1024 ** 3));
  assert.equal(parseSizeText('1,024 MB'), 1_024_000_000);
  assert.equal(parseSizeText('3654957056'), 3_654_957_056);
  assert.equal(parseSizeText(2_097_152_000), 2_097_152_000);
  assert.equal(parseSizeText('1.5 TB'), 1_500_000_000_000);
  assert.equal(parseSizeText('500 B'), 500);
});

test('parseSizeText 对脏数据返回 null 而不是 NaN', () => {
  for (const value of [null, undefined, '', '   ', 'abc', 'MiB', '-5 MiB', {}, []]) {
    assert.equal(parseSizeText(value), null, `${JSON.stringify(value)} 应该是 null`);
  }
});

test('formatBytes 使用 1024 进制并保留两位小数', () => {
  assert.equal(formatBytes(3_654_957_056), '3.40 GiB');
  assert.equal(formatBytes(624 * 1024 ** 2), '624.00 MiB');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(undefined), null);
  assert.equal(formatBytes(Number.NaN), null);
});

test('parseTimestamp 支持 unix 秒、unix 毫秒、RFC822 与无时区 ISO', () => {
  assert.equal(parseTimestamp('1652877231'), new Date(1_652_877_231_000).toISOString());
  assert.equal(parseTimestamp(1_652_877_231), new Date(1_652_877_231_000).toISOString());
  assert.equal(parseTimestamp(1_652_877_231_000), new Date(1_652_877_231_000).toISOString());
  assert.equal(parseTimestamp('Tue, 03 Nov 2009 07:03:00 -0000'), new Date('2009-11-03T07:03:00Z').toISOString());
  // mikan 的时间没有时区，按 UTC+8 解释
  assert.equal(parseTimestamp('2026-08-11T18:47:25.461386'), '2026-08-11T10:47:25.461Z');
});

test('parseTimestamp 对非法/越界值返回 null', () => {
  for (const value of [null, undefined, '', '0', 0, 'not-a-date', '99999999999999999']) {
    assert.equal(parseTimestamp(value), null, `${JSON.stringify(value)} 应该是 null`);
  }
});

test('toCount 只接受非负数字', () => {
  assert.equal(toCount('31'), 31);
  assert.equal(toCount('1,234'), 1234);
  assert.equal(toCount(0), 0);
  assert.equal(toCount(-1), null);
  assert.equal(toCount('abc'), null);
  assert.equal(toCount(null), null);
  assert.equal(toCount(''), null);
});

test('formatRelativeTime 输出中文相对时间', () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(new Date(now - 30_000).toISOString()), '30 秒前');
  assert.equal(formatRelativeTime(new Date(now - 5 * 60_000).toISOString()), '5 分钟前');
  assert.equal(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString()), '3 小时前');
  assert.equal(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString()), '2 天前');
  assert.equal(formatRelativeTime(null), '-');
  assert.equal(formatRelativeTime('garbage'), '-');
});
