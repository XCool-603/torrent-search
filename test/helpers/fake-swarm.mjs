/**
 * 测试用的「本地假种子群」：一个 HTTP tracker + 一个做种 peer。
 *
 * 为什么要自己实现对端：BT 协议是双向的，只有自己扮演对端才能在不联网、
 * 不依赖任何外部资源的情况下**真实**验证客户端（握手、元数据交换、分片下载、校验、落盘）。
 *
 * 这里刻意**不使用** src/bt/bencode.mjs 来构造 info 字典，而是手写字节拼接，
 * 这样测试数据是独立构造的，能真正检验客户端的解析能力（而不是自证）。
 */

import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';

/** 独立实现的最小 bencode 编码（只覆盖测试需要：字节串/整数/字典） */
function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
  }
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const parts = [Buffer.from('d')];
    for (const key of Object.keys(value).sort()) {
      parts.push(bencode(key), bencode(value[key]));
    }
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  throw new Error(`测试用 bencode 不支持：${typeof value}`);
}

/**
 * 构造真实的 info 字典字节（键按字节序排列）。
 *
 * @param {{name: string, pieceLength: number, content: Buffer}} params
 */
export function buildInfoDict({ name, pieceLength, content }) {
  const pieces = [];
  for (let offset = 0; offset < content.length; offset += pieceLength) {
    pieces.push(crypto.createHash('sha1').update(content.subarray(offset, offset + pieceLength)).digest());
  }

  const nameBytes = Buffer.from(name, 'utf8');
  return Buffer.concat([
    Buffer.from('d'),
    Buffer.from('6:length'), Buffer.from(`i${content.length}e`),
    Buffer.from('4:name'), Buffer.from(`${nameBytes.length}:`), nameBytes,
    Buffer.from('12:piece length'), Buffer.from(`i${pieceLength}e`),
    Buffer.from('6:pieces'), Buffer.from(`${pieces.length * 20}:`), Buffer.concat(pieces),
    Buffer.from('e'),
  ]);
}

/**
 * 构造多文件种子的 info 字典字节（键按字节序：files < name < piece length < pieces）。
 *
 * @param {{name: string, pieceLength: number, content: Buffer, files: Array<{length: number, path: string[]}>}} params
 */
export function buildMultiFileInfoDict({ name, pieceLength, content, files }) {
  const pieces = [];
  for (let offset = 0; offset < content.length; offset += pieceLength) {
    pieces.push(crypto.createHash('sha1').update(content.subarray(offset, offset + pieceLength)).digest());
  }

  const filesBytes = Buffer.concat(
    files.map((file) => {
      const parts = file.path.map((part) => {
        const bytes = Buffer.from(part, 'utf8');
        return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
      });
      return Buffer.concat([
        Buffer.from('d'),
        Buffer.from('6:length'), Buffer.from(`i${file.length}e`),
        Buffer.from('4:path'), Buffer.from('l'), ...parts, Buffer.from('e'),
        Buffer.from('e'),
      ]);
    }),
  );

  const nameBytes = Buffer.from(name, 'utf8');
  return Buffer.concat([
    Buffer.from('d'),
    Buffer.from('5:files'), Buffer.from('l'), filesBytes, Buffer.from('e'),
    Buffer.from('4:name'), Buffer.from(`${nameBytes.length}:`), nameBytes,
    Buffer.from('12:piece length'), Buffer.from(`i${pieceLength}e`),
    Buffer.from('6:pieces'), Buffer.from(`${pieces.length * 20}:`), Buffer.concat(pieces),
    Buffer.from('e'),
  ]);
}

/**
 * 启动假种子群。
 *
 * @param {{content?: Buffer, pieceLength?: number, name?: string, peerId?: Buffer, overrideInfoBytes?: Buffer}} [options]
 */
export async function startFakeSwarm(options = {}) {
  const content = options.content ?? crypto.randomBytes(100_000);
  const pieceLength = options.pieceLength ?? 16_384;
  const name = options.name ?? 'fake-file.bin';

  // 允许调用方直接给一份 info 字典字节（用于构造多文件等特殊布局）
  const infoBytes = options.overrideInfoBytes ?? buildInfoDict({ name, pieceLength, content });
  const infoHash = crypto.createHash('sha1').update(infoBytes).digest('hex');
  const infoHashBytes = Buffer.from(infoHash, 'hex');
  const peerId = options.peerId ?? Buffer.from('-FAKE00-123456789012', 'latin1');

  const stats = { handshakes: 0, metadataRequests: 0, pieceRequests: 0, badRequests: 0, announceCount: 0 };

  // ---------- 做种 peer ----------
  const peerServer = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    /** 对端（客户端）声明的 ut_metadata 扩展号 */
    let clientMetadataId = 1;

    const send = (messageId, payload = Buffer.alloc(0)) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1 + payload.length, 0);
      socket.write(Buffer.concat([header, Buffer.from([messageId]), payload]));
    };

    const sendExtended = (extendedId, dict, raw = null) => {
      const payload = Buffer.concat([Buffer.from([extendedId]), bencode(dict), raw ?? Buffer.alloc(0)]);
      send(20, payload);
    };

    const handle = (payload) => {
      const id = payload[0];
      const body = payload.subarray(1);

      if (id === 2) {
        // interested → unchoke，并把整份 bitfield 发过去
        send(1);
        const bitfield = Buffer.alloc(Math.ceil(content.length / pieceLength / 8), 0xff);
        send(5, bitfield);
        return;
      }

      if (id === 6) {
        const index = body.readUInt32BE(0);
        const begin = body.readUInt32BE(4);
        const length = body.readUInt32BE(8);
        stats.pieceRequests += 1;

        const start = index * pieceLength + begin;
        const chunk = content.subarray(start, start + length);
        if (chunk.length !== length) {
          stats.badRequests += 1;
          return;
        }
        const piece = Buffer.alloc(8 + chunk.length);
        piece.writeUInt32BE(index, 0);
        piece.writeUInt32BE(begin, 4);
        chunk.copy(piece, 8);
        send(7, piece);
        return;
      }

      if (id === 20) {
        const extendedId = body[0];
        const dict = decodeOne(body.subarray(1)).value;

        if (extendedId === 0) {
          clientMetadataId = Number(dict?.m?.ut_metadata ?? 1);
          // 回自己的扩展握手，声明 ut_metadata 扩展号 = 2 与元数据大小
          sendExtended(0, { m: { ut_metadata: 2 }, metadata_size: infoBytes.length, v: 'fake-seeder/1.0' });
          return;
        }

        if (extendedId === 2 && Number(dict?.msg_type) === 0) {
          stats.metadataRequests += 1;
          const piece = Number(dict.piece);
          const start = piece * 16_384;
          const chunk = infoBytes.subarray(start, start + 16_384);
          // 数据消息必须用**客户端**声明的扩展号发回去
          sendExtended(clientMetadataId, { msg_type: 1, piece, total_size: infoBytes.length }, chunk);
        }
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshakeDone) {
        if (buffer.length < 1) return;
        const pstrlen = buffer[0];
        // 握手总长 = 1 + pstrlen + 8(reserved) + 20(info_hash) + 20(peer_id)
        const totalLength = 1 + pstrlen + 48;
        if (buffer.length < totalLength) return;

        const remoteHash = buffer.subarray(1 + pstrlen + 8, 1 + pstrlen + 28);
        if (!remoteHash.equals(infoHashBytes)) {
          socket.destroy();
          return;
        }

        const reserved = Buffer.alloc(8);
        reserved[5] |= 0x10; // 支持扩展协议
        socket.write(
          Buffer.concat([
            Buffer.from([19]),
            Buffer.from('BitTorrent protocol', 'latin1'),
            reserved,
            infoHashBytes,
            peerId,
          ]),
        );

        buffer = buffer.subarray(totalLength);
        handshakeDone = true;
        stats.handshakes += 1;
      }

      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          buffer = buffer.subarray(4);
          continue;
        }
        if (buffer.length < 4 + length) break;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        handle(payload);
      }
    });

    socket.on('error', () => {});
  });

  peerServer.listen(0, '127.0.0.1');
  await once(peerServer, 'listening');
  const peerPort = peerServer.address().port;

  // ---------- HTTP tracker ----------
  const trackerServer = http.createServer((request, response) => {
    if (!request.url.startsWith('/announce')) {
      response.writeHead(404);
      response.end();
      return;
    }

    stats.announceCount += 1;
    const compact = Buffer.alloc(6);
    compact[0] = 127;
    compact[1] = 0;
    compact[2] = 0;
    compact[3] = 1;
    compact.writeUInt16BE(peerPort, 4);

    const body = bencode({
      interval: 60,
      complete: 1,
      incomplete: 0,
      // 紧凑 peer 列表是**二进制**：必须按 Buffer 传，绝不能走字符串（会被 UTF-8 撑长，
      // 端口字节 >= 0x80 时长度和内容都会变——这个坑本项目在测试里真实踩过一次）
      peers: compact,
    });

    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(body);
  });

  trackerServer.listen(0, '127.0.0.1');
  await once(trackerServer, 'listening');
  const trackerPort = trackerServer.address().port;

  return {
    infoHash,
    infoBytes,
    content,
    name,
    pieceLength,
    magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=${encodeURIComponent(`http://127.0.0.1:${trackerPort}/announce`)}`,
    trackers: [`http://127.0.0.1:${trackerPort}/announce`],
    peerPort,
    trackerPort,
    stats,
    close: async () => {
      await new Promise((resolve) => peerServer.close(resolve));
      await new Promise((resolve) => trackerServer.close(resolve));
      peerServer.closeAllConnections?.();
      trackerServer.closeAllConnections?.();
    },
  };
}

/** 只解一个 bencode 值（测试用，够用即可） */
function decodeOne(buffer, offset = 0) {
  const marker = buffer[offset];
  if (marker === 0x69) {
    const end = buffer.indexOf(0x65, offset + 1);
    return { value: Number(buffer.toString('latin1', offset + 1, end)), next: end + 1 };
  }
  if (marker === 0x64) {
    const dict = {};
    let cursor = offset + 1;
    while (buffer[cursor] !== 0x65) {
      const key = decodeOne(buffer, cursor);
      const value = decodeOne(buffer, key.next);
      dict[key.value] = value.value;
      cursor = value.next;
    }
    return { value: dict, next: cursor + 1 };
  }
  if (marker >= 0x30 && marker <= 0x39) {
    const colon = buffer.indexOf(0x3a, offset);
    const length = Number(buffer.toString('latin1', offset, colon));
    return { value: buffer.toString('latin1', colon + 1, colon + 1 + length), next: colon + 1 + length };
  }
  throw new Error(`测试解码器遇到未知标记 0x${marker.toString(16)}`);
}
