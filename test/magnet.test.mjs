import test from 'node:test';
import assert from 'node:assert/strict';

import {
  base32ToHex,
  normalizeInfoHash,
  buildMagnet,
  parseMagnet,
  extractMagnet,
  withTrackers,
  shortHash,
} from '../src/magnet.mjs';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 独立实现（BigInt 版）的 hex → Base32，用来交叉验证 base32ToHex。
 * 刻意用与生产代码不同的算法（大整数运算 vs 位串拼接），
 * 两个实现同时出错且互相吻合的概率极低。
 *
 * @param {string} hex
 * @returns {string}
 */
function hexToBase32Independent(hex) {
  let value = 0n;
  for (const char of hex.toLowerCase()) value = (value << 4n) | BigInt(parseInt(char, 16));

  // 必须补齐到 160 bit（20 字节），否则前导零会丢失（BigInt 不保留前导零）
  const bits = value.toString(2).padStart(hex.length * 4, '0');

  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return output;
}

test('base32ToHex 与独立实现互为逆运算', () => {
  const hashes = [
    '45008e48c8800b7d7643337b2e70a634e4c69f6a',
    '0000000000000000000000000000000000000000',
    'ffffffffffffffffffffffffffffffffffffffff',
    '0123456789abcdef0123456789abcdef01234567',
    'c2018b52e9e0dd17dd378ed8ff7b28e3717fdaa2',
  ];

  for (const hex of hashes) {
    const encoded = hexToBase32Independent(hex);
    assert.equal(encoded.length, 32, `${hex} 的 base32 应该是 32 字符`);
    assert.equal(base32ToHex(encoded), hex, `base32(${encoded}) 应还原为 ${hex}`);
  }
});

test('base32ToHex 能解出 dmhy 夹具里的真实 btih', () => {
  // 该值来自 test/fixtures/dmhy-shingeki.xml 的 enclosure
  const hash = base32ToHex('EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI');
  assert.match(hash, /^[0-9a-f]{40}$/);
});

test('base32ToHex 对非法输入返回 null', () => {
  for (const value of [null, undefined, '', 'short', '0189', '!!!!', 'A'.repeat(31), 'A'.repeat(33)]) {
    assert.equal(base32ToHex(value), null, `${JSON.stringify(value)} 应该是 null`);
  }
});

test('normalizeInfoHash 统一 hex / Base32 / urn 前缀', () => {
  assert.equal(normalizeInfoHash('45008E48C8800B7D7643337B2E70A634E4C69F6A'), '45008e48c8800b7d7643337b2e70a634e4c69f6a');
  assert.equal(
    normalizeInfoHash('urn:btih:45008E48C8800B7D7643337B2E70A634E4C69F6A'),
    '45008e48c8800b7d7643337b2e70a634e4c69f6a',
  );
  assert.equal(normalizeInfoHash('EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI'), base32ToHex('EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI'));
  assert.equal(normalizeInfoHash('  '), null);
  assert.equal(normalizeInfoHash('zzz'), null);
  assert.equal(normalizeInfoHash(null), null);
});

test('buildMagnet / parseMagnet 往返一致', () => {
  const hash = '45008e48c8800b7d7643337b2e70a634e4c69f6a';
  const magnet = buildMagnet({ infoHash: hash.toUpperCase(), name: 'Koha Live CD', trackers: ['udp://a:1/announce'] });

  assert.equal(magnet, `magnet:?xt=urn:btih:${hash}&dn=Koha%20Live%20CD&tr=udp%3A%2F%2Fa%3A1%2Fannounce`);

  const parsed = parseMagnet(magnet);
  assert.equal(parsed.infoHash, hash);
  assert.equal(parsed.name, 'Koha Live CD');
  assert.deepEqual(parsed.trackers, ['udp://a:1/announce']);
});

test('buildMagnet 对非法 hash 返回 null，parseMagnet 对非磁力返回 null', () => {
  assert.equal(buildMagnet({ infoHash: 'nope' }), null);
  assert.equal(buildMagnet({}), null);
  assert.equal(parseMagnet('https://example.com'), null);
  assert.equal(parseMagnet(null), null);
});

test('parseMagnet 支持 Base32 形式的 btih', () => {
  const parsed = parseMagnet('magnet:?xt=urn:btih:EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI&dn=x');
  assert.equal(parsed.infoHash, base32ToHex('EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI'));
});

test('extractMagnet 能从 HTML 片段里取出磁力并还原 &amp;', () => {
  const html = '<p>下载：<a href="magnet:?xt=urn:btih:EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI&amp;dn=&amp;tr=udp%3A%2F%2Fa%3A1">链接</a></p>';
  const magnet = extractMagnet(html);
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:EIR4OPTTBSTGLD2KXK6TFTG2QRRZNKSI&dn=&tr='));
  assert.equal(parseMagnet(magnet).trackers.length, 1);
  assert.equal(extractMagnet('没有磁力'), null);
});

test('withTrackers 追加 tracker 且不重复', () => {
  const base = buildMagnet({ infoHash: '45008e48c8800b7d7643337b2e70a634e4c69f6a', trackers: ['udp://a:1'] });
  const merged = withTrackers(base, ['udp://a:1', 'udp://b:2', '']);

  assert.deepEqual(parseMagnet(merged).trackers, ['udp://a:1', 'udp://b:2']);
  assert.equal(withTrackers(null, ['udp://a:1']), null);
});

test('shortHash 稳定且长度可控', () => {
  assert.equal(shortHash('abc', 8), shortHash('abc', 8));
  assert.equal(shortHash('abc', 8).length, 8);
  assert.notEqual(shortHash('abc'), shortHash('abd'));
});
