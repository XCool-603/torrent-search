/**
 * bencode 编解码（BEP 3）。
 *
 * 设计取舍：**字节串一律用 latin1 字符串表示**。
 * 理由：bencode 的字节串是任意二进制（info_hash、pieces 里 20 字节一组的 SHA1、peer_id…），
 * 如果用 UTF-8 解码会损坏数据，如果全用 Buffer 又会让上层代码到处 `.toString()`。
 * latin1（binary）是字节 ↔ 字符的双射，因此：
 *   - 无损：`Buffer.from(str, 'latin1')` 能原样还原字节；
 *   - 重新编码与原始字节完全一致（这是校验 info hash 的前提）；
 *   - 需要人类可读文本时用 `toUtf8(str)` 转换（种子里的文件名可能是 UTF-8）。
 */

import crypto from 'node:crypto';

/**
 * 把 latin1 字符串还原成字节。
 *
 * @param {string} value
 * @returns {Buffer}
 */
export function toBytes(value) {
  return Buffer.from(value, 'latin1');
}

/**
 * 把 bencode 字节串按 UTF-8 解释成人类可读文本。
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function toUtf8(value) {
  if (typeof value !== 'string' || value === '') return '';
  return Buffer.from(value, 'latin1').toString('utf8');
}

/**
 * 把普通文本转成 bencode 字节串（UTF-8 编码后按 latin1 存放）。
 *
 * @param {string} text
 * @returns {string}
 */
export function fromUtf8(text) {
  return Buffer.from(String(text), 'utf8').toString('latin1');
}

/**
 * 编码。
 *
 * @param {any} value 支持 string（字节串）/ number / bigint / Buffer / Array / 普通对象
 * @returns {Buffer}
 */
export function encode(value) {
  const chunks = [];
  encodeInto(value, chunks);
  return Buffer.concat(chunks);
}

function encodeInto(value, chunks) {
  if (Buffer.isBuffer(value)) {
    chunks.push(Buffer.from(`${value.length}:`, 'latin1'), value);
    return;
  }

  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'latin1');
    chunks.push(Buffer.from(`${bytes.length}:`, 'latin1'), bytes);
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`bencode 不支持的数字：${value}`);
    chunks.push(Buffer.from(`i${Math.trunc(value)}e`, 'latin1'));
    return;
  }

  if (typeof value === 'bigint') {
    chunks.push(Buffer.from(`i${value}e`, 'latin1'));
    return;
  }

  if (Array.isArray(value)) {
    chunks.push(Buffer.from('l', 'latin1'));
    for (const item of value) encodeInto(item, chunks);
    chunks.push(Buffer.from('e', 'latin1'));
    return;
  }

  if (value && typeof value === 'object') {
    chunks.push(Buffer.from('d', 'latin1'));
    // 字典的键必须按字节序排序，否则算出来的 info hash 会与别人的不一致
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a, 'latin1'), Buffer.from(b, 'latin1')));
    for (const key of keys) {
      encodeInto(key, chunks);
      encodeInto(value[key], chunks);
    }
    chunks.push(Buffer.from('e', 'latin1'));
    return;
  }

  throw new TypeError(`bencode 不支持的类型：${typeof value}`);
}

/**
 * 解码（从 offset 开始解一个值）。
 *
 * @param {Buffer} buffer
 * @param {number} [offset]
 * @returns {{value: any, next: number}}
 */
export function decode(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('decode 需要 Buffer');
  return decodeAt(buffer, offset);
}

function decodeAt(buffer, offset) {
  if (offset >= buffer.length) throw new Error('bencode：数据意外结束');

  const marker = buffer[offset];

  // 整数 i...e
  if (marker === 0x69) {
    const end = buffer.indexOf(0x65, offset + 1);
    if (end === -1) throw new Error('bencode：整数缺少结束符 e');
    const text = buffer.toString('latin1', offset + 1, end);
    if (!/^-?\d+$/.test(text)) throw new Error(`bencode：非法整数 ${text}`);
    const value = Number(text);
    return { value: Number.isSafeInteger(value) ? value : BigInt(text), next: end + 1 };
  }

  // 列表 l...e
  if (marker === 0x6c) {
    const list = [];
    let cursor = offset + 1;
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      const decoded = decodeAt(buffer, cursor);
      list.push(decoded.value);
      cursor = decoded.next;
    }
    if (cursor >= buffer.length) throw new Error('bencode：列表缺少结束符 e');
    return { value: list, next: cursor + 1 };
  }

  // 字典 d...e
  if (marker === 0x64) {
    const dict = {};
    let cursor = offset + 1;
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      const key = decodeAt(buffer, cursor);
      if (typeof key.value !== 'string') throw new Error('bencode：字典的键必须是字节串');
      const value = decodeAt(buffer, key.next);
      dict[key.value] = value.value;
      cursor = value.next;
    }
    if (cursor >= buffer.length) throw new Error('bencode：字典缺少结束符 e');
    return { value: dict, next: cursor + 1 };
  }

  // 字节串 <长度>:<内容>
  if (marker >= 0x30 && marker <= 0x39) {
    const colon = buffer.indexOf(0x3a, offset);
    if (colon === -1) throw new Error('bencode：字节串缺少冒号');
    const lengthText = buffer.toString('latin1', offset, colon);
    if (!/^\d+$/.test(lengthText)) throw new Error(`bencode：非法长度 ${lengthText}`);
    const length = Number(lengthText);
    const start = colon + 1;
    const end = start + length;
    if (end > buffer.length) throw new Error('bencode：字节串长度超出数据范围');
    return { value: buffer.toString('latin1', start, end), next: end };
  }

  throw new Error(`bencode：未知的标记字节 0x${marker.toString(16)}（位置 ${offset}）`);
}

/**
 * 解码整段数据，并校验没有多余尾巴。
 *
 * @param {Buffer|string} input
 * @returns {any}
 */
export function decodeAll(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'latin1');
  const { value, next } = decode(buffer, 0);
  if (next !== buffer.length) throw new Error(`bencode：末尾有 ${buffer.length - next} 字节多余数据`);
  return value;
}

/**
 * 计算 info 字典的 SHA1（这就是 info hash）。
 *
 * 必须对**原始字节**求哈希：把解码后的字典重新编码不保证字节一致
 * （键顺序、整数写法都可能变），所以调用方要传原始切片。
 *
 * @param {Buffer} infoBytes
 * @returns {string} 小写 40 位 hex
 */
export function infoHashOf(infoBytes) {
  return crypto.createHash('sha1').update(infoBytes).digest('hex');
}
