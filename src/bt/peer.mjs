/**
 * Peer 连接：BT 对等协议（BEP 3）+ 扩展协议（BEP 10）+ 元数据交换（BEP 9）。
 *
 * 只实现下载侧需要的最小集合：握手、interested/unchoke、bitfield/have、
 * request/piece、以及用 ut_metadata 从 peer 那里把 info 字典拉回来（磁力链接必需）。
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { encode, decode, toBytes, infoHashOf } from './bencode.mjs';

const PROTOCOL = 'BitTorrent protocol';
/**
 * 握手长度 = pstrlen(1) + pstr(19) + reserved(8) + info_hash(20) + peer_id(20) = 68。
 * 注意：**不是 49**（49 是漏算了 19 字节协议串的结果）。算错会让 peer_id 被截断、
 * 多出来的字节被当成消息帧，整条消息流从此错位——这个坑本项目真实踩过一次。
 */
const HANDSHAKE_LENGTH = 1 + PROTOCOL.length + 8 + 20 + 20;
const EXTENDED_ID = 20;
/** 我们自己的 ut_metadata 扩展号 */
const OUR_UT_METADATA_ID = 1;
/** 元数据分片大小（BEP 9 建议 16 KiB） */
const METADATA_PIECE_SIZE = 16 * 1024;

export const PEER_MESSAGE = {
  choke: 0,
  unchoke: 1,
  interested: 2,
  notInterested: 3,
  have: 4,
  bitfield: 5,
  request: 6,
  piece: 7,
  cancel: 8,
  port: 9,
  extended: 20,
};

/**
 * 一条 peer 连接。
 *
 * 事件：`bitfield`、`have`、`unchoke`、`choke`、`extended`、`close`、`error`
 */
export class Peer extends EventEmitter {
  /**
   * @param {{host: string, port: number, infoHash: string, peerId: Buffer, connectTimeoutMs?: number, limiter?: import('./limiter.mjs').SpeedLimiter|null, logger?: (msg: string) => void}} options
   */
  constructor(options) {
    super();
    this.host = options.host;
    this.port = options.port;
    this.infoHash = options.infoHash.toLowerCase();
    this.peerId = options.peerId;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 8000;
    this.limiter = options.limiter ?? null;
    this.logger = options.logger ?? (() => {});

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.closed = false;
    this.choked = true;
    this.interested = false;
    this.bitfield = null;
    /** 对端声明的扩展号 */
    this.remoteUtMetadataId = null;
    this.remoteMetadataSize = null;
    /** 待响应的块请求 */
    this.pending = new Map();
    this.metadataWaiter = null;
  }

  get key() {
    return `${this.host}:${this.port}`;
  }

  /**
   * 建立 TCP 连接并完成握手。
   *
   * @returns {Promise<{peerId: string, supportsExtensions: boolean}>}
   */
  async connect() {
    this.socket = net.connect({ host: this.host, port: this.port });
    this.socket.setNoDelay(true);
    this.socket.setTimeout(this.connectTimeoutMs);

    await new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error('连接超时'));
      };
      const cleanup = () => {
        this.socket.off('connect', onConnect);
        this.socket.off('error', onError);
        this.socket.off('timeout', onTimeout);
      };

      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
      this.socket.once('timeout', onTimeout);
    });

    this.socket.setTimeout(0);

    // 握手：pstrlen + pstr + 8 字节保留位 + info_hash + peer_id
    const reserved = Buffer.alloc(8);
    reserved[5] |= 0x10; // 支持 BEP 10 扩展协议

    const handshake = Buffer.concat([
      Buffer.from([PROTOCOL.length]),
      Buffer.from(PROTOCOL, 'latin1'),
      reserved,
      Buffer.from(this.infoHash, 'hex'),
      this.peerId,
    ]);

    const remoteHandshake = await this.exchangeHandshake(handshake);

    this.connected = true;
    this.attachReader();

    return {
      peerId: remoteHandshake.peerId.toString('hex'),
      supportsExtensions: (remoteHandshake.reserved[5] & 0x10) !== 0,
    };
  }

  /**
   * 发送握手并读取对端握手。
   *
   * @param {Buffer} handshake
   * @returns {Promise<{peerId: Buffer, reserved: Buffer}>}
   */
  exchangeHandshake(handshake) {
    return new Promise((resolve, reject) => {
      let received = Buffer.alloc(0);
      let sent = false;

      const onData = (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length < 1) return;

        const pstrlen = received[0];
        // 长度由对端声明的 pstrlen 决定，而不是写死常量
        const totalLength = 1 + pstrlen + 8 + 20 + 20;
        if (received.length < totalLength) return;

        if (pstrlen !== PROTOCOL.length) {
          fail(new Error(`对端协议标识长度异常：${pstrlen}`));
          return;
        }
        const protocol = received.toString('latin1', 1, 1 + pstrlen);
        if (protocol !== PROTOCOL) {
          fail(new Error(`对端不是 BT 协议：${protocol}`));
          return;
        }

        const reserved = received.subarray(1 + pstrlen, 1 + pstrlen + 8);
        const remoteInfoHash = received.subarray(1 + pstrlen + 8, 1 + pstrlen + 28).toString('hex');
        if (remoteInfoHash !== this.infoHash) {
          fail(new Error('对端的 info hash 与请求不一致'));
          return;
        }

        const peerId = received.subarray(1 + pstrlen + 28, totalLength);
        const leftover = received.subarray(totalLength);

        cleanup();
        if (leftover.length > 0) this.buffer = Buffer.concat([this.buffer, leftover]);
        resolve({ peerId, reserved });
      };

      const onError = (error) => fail(error);
      const onClose = () => fail(new Error('握手期间连接被关闭'));
      const onTimeout = () => fail(new Error('握手超时'));

      const cleanup = () => {
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
        this.socket.off('timeout', onTimeout);
      };
      const fail = (error) => {
        cleanup();
        this.destroy();
        reject(error);
      };

      this.socket.setTimeout(this.connectTimeoutMs);
      this.socket.on('data', onData);
      this.socket.on('error', onError);
      this.socket.on('close', onClose);
      this.socket.on('timeout', onTimeout);

      if (!sent) {
        sent = true;
        this.socket.write(handshake);
      }
    });
  }

  /** 开始解析消息流 */
  attachReader() {
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => this.onClose(error));
    this.socket.on('close', () => this.onClose(null));
  }

  /**
   * @param {Buffer} chunk
   */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0) {
        this.buffer = this.buffer.subarray(4); // keep-alive
        continue;
      }
      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      this.handleMessage(payload);
    }
  }

  /**
   * @param {Buffer} payload
   */
  handleMessage(payload) {
    const id = payload[0];
    const body = payload.subarray(1);

    switch (id) {
      case PEER_MESSAGE.choke:
        this.choked = true;
        this.emit('choke');
        break;

      case PEER_MESSAGE.unchoke:
        this.choked = false;
        this.emit('unchoke');
        break;

      case PEER_MESSAGE.have: {
        const index = body.readUInt32BE(0);
        this.markHave(index);
        this.emit('have', index);
        break;
      }

      case PEER_MESSAGE.bitfield:
        this.bitfield = Buffer.from(body);
        this.emit('bitfield', this.bitfield);
        break;

      case PEER_MESSAGE.piece: {
        const index = body.readUInt32BE(0);
        const begin = body.readUInt32BE(4);
        const block = body.subarray(8);
        const key = `${index}:${begin}`;
        const waiter = this.pending.get(key);
        if (waiter) {
          this.pending.delete(key);
          clearTimeout(waiter.timer);
          waiter.resolve(block);
        }
        break;
      }

      case PEER_MESSAGE.extended:
        this.handleExtended(body);
        break;

      default:
        break;
    }
  }

  /**
   * 处理扩展协议消息（BEP 10）。
   *
   * @param {Buffer} body 第一个字节是扩展消息号，其后是 bencode 载荷
   */
  handleExtended(body) {
    const extendedId = body[0];
    const payload = body.subarray(1);

    let dict;
    let next = payload.length;
    try {
      const decoded = decode(payload, 0);
      dict = decoded.value;
      next = decoded.next;
    } catch {
      return;
    }

    // 对端的扩展握手
    if (extendedId === 0) {
      const utMetadataId = dict?.m?.ut_metadata;
      if (Number.isFinite(Number(utMetadataId))) this.remoteUtMetadataId = Number(utMetadataId);
      if (Number.isFinite(Number(dict?.metadata_size))) this.remoteMetadataSize = Number(dict.metadata_size);
      this.emit('extended-handshake', dict);
      return;
    }

    if (extendedId === OUR_UT_METADATA_ID && this.metadataWaiter) {
      const msgType = Number(dict?.msg_type);
      if (msgType === 1) {
        // data：bencode 字典之后紧跟着原始分片字节
        this.metadataWaiter.onData(Number(dict.piece), payload.subarray(next), Number(dict.total_size));
      } else if (msgType === 2) {
        this.metadataWaiter.onReject(Number(dict.piece));
      }
      return;
    }

    this.emit('extended', extendedId, dict, payload.subarray(next));
  }

  markHave(index) {
    if (!this.bitfield) return;
    const byte = index >> 3;
    if (byte >= this.bitfield.length) return;
    this.bitfield[byte] |= 0x80 >> (index & 7);
  }

  /**
   * 对端是否声称拥有某个分片。没有 bitfield 时保守返回 true（让对方用 piece 消息回答）。
   *
   * @param {number} index
   * @returns {boolean}
   */
  hasPiece(index) {
    if (!this.bitfield) return true;
    const byte = index >> 3;
    if (byte >= this.bitfield.length) return false;
    return (this.bitfield[byte] & (0x80 >> (index & 7))) !== 0;
  }

  send(messageId, payload = Buffer.alloc(0)) {
    if (this.closed || !this.socket) return;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1 + payload.length, 0);
    this.socket.write(Buffer.concat([header, Buffer.from([messageId]), payload]));
  }

  sendInterested() {
    if (this.interested) return;
    this.interested = true;
    this.send(PEER_MESSAGE.interested);
  }

  /**
   * 发送扩展握手，声明我们支持 ut_metadata。
   *
   * @param {number|null} metadataSize
   */
  sendExtendedHandshake(metadataSize = null) {
    const dict = {
      m: { ut_metadata: OUR_UT_METADATA_ID },
      v: 'torrent-search/1.0',
      ...(metadataSize ? { metadata_size: metadataSize } : {}),
    };
    const payload = Buffer.concat([Buffer.from([0]), encode(dict)]);
    this.send(EXTENDED_ID, payload);
  }

  /**
   * 等待对端的扩展握手（里面才有它的 ut_metadata 扩展号与 metadata_size）。
   *
   * @param {number} timeoutMs
   * @returns {Promise<Record<string, any>>}
   */
  waitForExtendedHandshake(timeoutMs) {
    if (this.remoteUtMetadataId !== null) return Promise.resolve({ m: { ut_metadata: this.remoteUtMetadataId } });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('extended-handshake', onHandshake);
        reject(new Error('等待扩展握手超时（对端可能不支持元数据交换）'));
      }, timeoutMs);

      const onHandshake = (dict) => {
        clearTimeout(timer);
        this.off('extended-handshake', onHandshake);
        resolve(dict);
      };

      this.on('extended-handshake', onHandshake);
    });
  }

  /**
   * 通过 ut_metadata 拉取完整的 info 字典并校验哈希。
   *
   * @param {{timeoutMs?: number, expectedInfoHash?: string}} [options]
   * @returns {Promise<{infoBytes: Buffer, info: Record<string, any>, infoHash: string}>}
   */
  async fetchMetadata(options = {}) {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const expected = (options.expectedInfoHash ?? this.infoHash).toLowerCase();

    this.sendExtendedHandshake();
    await this.waitForExtendedHandshake(timeoutMs);

    if (this.remoteUtMetadataId === null) throw new Error('对端不支持 ut_metadata');
    if (!this.remoteMetadataSize) throw new Error('对端没有提供 metadata_size');

    const totalSize = this.remoteMetadataSize;
    const pieceCount = Math.ceil(totalSize / METADATA_PIECE_SIZE);
    const pieces = new Array(pieceCount).fill(null);

    const requestPiece = (piece) => {
      const payload = Buffer.concat([
        Buffer.from([this.remoteUtMetadataId]),
        encode({ msg_type: 0, piece }),
      ]);
      this.send(EXTENDED_ID, payload);
    };

    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.metadataWaiter = null;
        reject(new Error(`拉取元数据超时（已收到 ${pieces.filter(Boolean).length}/${pieceCount} 片）`));
      }, timeoutMs);

      this.metadataWaiter = {
        onData: (piece, data, total) => {
          if (piece < 0 || piece >= pieceCount) return;
          pieces[piece] = data;
          if (Number.isFinite(total) && total > 0) this.remoteMetadataSize = total;

          const missing = pieces.findIndex((entry) => entry === null);
          if (missing === -1) {
            clearTimeout(timer);
            this.metadataWaiter = null;
            resolve(Buffer.concat(pieces));
          } else {
            requestPiece(missing);
          }
        },
        onReject: (piece) => {
          clearTimeout(timer);
          this.metadataWaiter = null;
          reject(new Error(`对端拒绝了元数据分片 ${piece}`));
        },
      };

      // 先把所有分片请求出去（数量很少，不用做窗口控制）
      for (let index = 0; index < pieceCount; index += 1) requestPiece(index);
    });

    const infoBytes = await received;
    const infoHash = infoHashOf(infoBytes);
    if (infoHash !== expected) {
      throw new Error(`元数据校验失败：算出的 info hash 是 ${infoHash}，期望 ${expected}`);
    }

    return { infoBytes, info: decode(infoBytes, 0).value, infoHash };
  }

  /**
   * 请求一个块（16 KiB），返回数据。
   *
   * 限速说明：BT 的分片请求本身没有流量计费（数据是对端推回来的），
   * 所以限速的正确位置是**发请求之前**拿令牌——请求速率被压下来，
   * 回来的数据量自然被压下来。若不设 limiter 则零开销直通。
   *
   * @param {number} index
   * @param {number} begin
   * @param {number} length
   * @param {number} [timeoutMs]
   * @returns {Promise<Buffer>}
   */
  async requestBlock(index, begin, length, timeoutMs = 20_000) {
    const key = `${index}:${begin}`;

    if (this.limiter) {
      await this.limiter.acquire(length);
      // 拿令牌可能等了较久，原来的 timeout 已不适用，重新计时
      if (this.closed) throw new Error('连接已关闭');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`请求分片 ${index}@${begin} 超时`));
      }, timeoutMs);

      this.pending.set(key, { resolve, reject, timer });

      const payload = Buffer.alloc(12);
      payload.writeUInt32BE(index, 0);
      payload.writeUInt32BE(begin, 4);
      payload.writeUInt32BE(length, 8);
      this.send(PEER_MESSAGE.request, payload);
    });
  }

  /**
   * 等待对端解除阻塞。
   *
   * @param {number} timeoutMs
   */
  waitForUnchoke(timeoutMs) {
    if (!this.choked) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('unchoke', onUnchoke);
        reject(new Error('等待 unchoke 超时'));
      }, timeoutMs);

      const onUnchoke = () => {
        clearTimeout(timer);
        this.off('unchoke', onUnchoke);
        resolve();
      };

      this.on('unchoke', onUnchoke);
    });
  }

  /**
   * @param {Error|null} error
   */
  onClose(error) {
    if (this.closed) return;
    this.closed = true;

    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('连接已关闭'));
    }
    this.pending.clear();

    if (error) this.emit('error', error);
    this.emit('close');
  }

  destroy() {
    this.closed = true;
    this.socket?.destroy();
  }
}

export { OUR_UT_METADATA_ID, METADATA_PIECE_SIZE, toBytes };
