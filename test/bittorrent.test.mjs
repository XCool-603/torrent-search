import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { startFakeSwarm, buildInfoDict, buildMultiFileInfoDict } from './helpers/fake-swarm.mjs';
import { download, fetchMetadataOnly, generatePeerId, normalizeTrackers } from '../src/bt/engine.mjs';
import { parseInfoDict, pieceSize, pieceToFileRanges, splitIntoBlocks, sanitizeRelativePath } from '../src/bt/torrent.mjs';
import { assertInside } from '../src/bt/storage.mjs';
import { encode, decode, decodeAll, infoHashOf, toUtf8, fromUtf8 } from '../src/bt/bencode.mjs';
import { buildAnnounceUrl, percentEncodeBytes, parsePeers } from '../src/bt/tracker.mjs';

/**
 * 每个用例一个临时下载目录。
 */
async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-search-dl-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('bencode：编解码往返一致，且字节级无损', () => {
  const value = { b: 2, a: 'x', list: [1, 'two', { nested: 'y' }] };
  const encoded = encode(value);
  assert.equal(encoded.toString('latin1'), 'd1:a1:x1:bi2e4:listli1e3:twod6:nested1:yeee');
  assert.deepEqual(decodeAll(encoded), value);

  // 二进制字节串必须无损（这是校验 info hash 的前提）
  const binary = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a]);
  const roundTrip = decodeAll(encode(binary.toString('latin1')));
  assert.equal(Buffer.from(roundTrip, 'latin1').equals(binary), true);
});

test('bencode：字典键按字节序排序（info hash 正确性的前提）', () => {
  const encoded = encode({ name: 'a', length: 1 }).toString('latin1');
  assert.equal(encoded, 'd6:lengthi1e4:name1:ae');
});

test('bencode：toUtf8/fromUtf8 处理中文文件名', () => {
  const name = '进击的巨人 第01集.mkv';
  const asBytes = fromUtf8(name);
  assert.equal(toUtf8(asBytes), name);
  assert.equal(Buffer.from(asBytes, 'latin1').toString('utf8'), name);
});

test('bencode：infoHashOf 对原始字节求 SHA1', () => {
  const infoBytes = buildInfoDict({ name: 'x.bin', pieceLength: 16_384, content: Buffer.alloc(40_000, 7) });
  assert.equal(infoHashOf(infoBytes), crypto.createHash('sha1').update(infoBytes).digest('hex'));
});

test('bencode：非法输入抛出可读错误', () => {
  assert.throws(() => decode(Buffer.from('i12', 'latin1')), /缺少结束符/);
  assert.throws(() => decode(Buffer.from('5:abc', 'latin1')), /超出数据范围/);
  assert.throws(() => decodeAll(Buffer.from('i1ei2e', 'latin1')), /多余数据/);
  assert.throws(() => decode(Buffer.from('z', 'latin1')), /未知的标记字节/);
});

test('torrent：解析 info 字典并算好分片/文件布局', () => {
  const content = crypto.randomBytes(50_000);
  const infoBytes = buildInfoDict({ name: 'movie.mkv', pieceLength: 16_384, content });
  const info = decodeAll(infoBytes);
  const torrent = parseInfoDict(info, infoHashOf(infoBytes));

  assert.equal(torrent.name, 'movie.mkv');
  assert.equal(torrent.totalSize, 50_000);
  assert.equal(torrent.pieceCount, 4); // 16384*3 + 848
  assert.equal(torrent.isSingleFile, true);
  assert.equal(torrent.files.length, 1);
  assert.equal(pieceSize(torrent, 0), 16_384);
  assert.equal(pieceSize(torrent, 3), 50_000 - 3 * 16_384);
  assert.equal(torrent.pieceHashes.length, 4);
});

test('torrent：多文件种子正确计算偏移与分片映射', () => {
  const info = {
    name: 'pack',
    'piece length': 4,
    pieces: Buffer.alloc(20 * 3, 1).toString('latin1'),
    files: [
      { length: 5, path: ['a.txt'] },
      { length: 7, path: ['sub', 'b.txt'] },
    ],
  };
  const torrent = parseInfoDict(info, 'a'.repeat(40));

  assert.equal(torrent.isSingleFile, false);
  assert.equal(torrent.totalSize, 12);
  assert.equal(torrent.pieceCount, 3);
  assert.deepEqual(torrent.files.map((file) => file.path), ['pack/a.txt', 'pack/sub/b.txt']);
  assert.deepEqual(torrent.files.map((file) => file.offset), [0, 5]);

  // 分片 1 覆盖字节 4..8：跨越两个文件
  assert.deepEqual(pieceToFileRanges(torrent, 1), [
    { fileIndex: 0, fileOffset: 4, pieceOffset: 0, length: 1 },
    { fileIndex: 1, fileOffset: 0, pieceOffset: 1, length: 3 },
  ]);

  assert.deepEqual(splitIntoBlocks(torrent, 0, 2), [
    { offset: 0, length: 2 },
    { offset: 2, length: 2 },
  ]);
});

test('torrent：恶意路径被清洗（路径穿越防护）', () => {
  const info = {
    name: '..',
    'piece length': 4,
    pieces: Buffer.alloc(20 * 3, 1).toString('latin1'), // 12 字节内容 / 4 字节一片 = 3 片
    files: [
      { length: 4, path: ['..', '..', 'evil.txt'] },
      { length: 4, path: ['C:', 'windows', 'system32.txt'] },
      { length: 4, path: ['.'] },
    ],
  };

  const torrent = parseInfoDict(info, 'b'.repeat(40));
  for (const file of torrent.files) {
    assert.equal(file.path.includes('..'), false, `路径不应包含 ..：${file.path}`);
    assert.equal(file.path.includes('\\'), false);
    assert.equal(/^[a-zA-Z]:/.test(file.path), false);
  }

  assert.equal(sanitizeRelativePath(['..', 'a', '..', 'b']), 'a/b');
  assert.equal(sanitizeRelativePath(['.', '']), 'unnamed');
});

test('storage：越界路径被拒绝', () => {
  const base = path.resolve(os.tmpdir(), 'base');
  assert.doesNotThrow(() => assertInside(base, path.join(base, 'a', 'b.txt')));
  assert.throws(() => assertInside(base, path.resolve(base, '..', 'evil.txt')), /越界路径/);
  assert.throws(() => assertInside(base, path.resolve(base, '..', '..', 'evil.txt')), /越界路径/);
});

test('tracker：announce URL 里 info_hash 按字节百分号编码', () => {
  const infoHash = Buffer.from('00112233445566778899aabbccddeeff00112233', 'hex');
  const url = buildAnnounceUrl('http://tracker.example/announce', {
    info_hash: infoHash,
    peer_id: Buffer.from('-TS1000-abcdefghijkl', 'latin1'),
    port: 6881,
    uploaded: 0,
    left: 100,
    compact: 1,
  });

  assert.match(url, /^http:\/\/tracker\.example\/announce\?/);
  // 按 RFC 3986：非保留字节（数字/字母/-_.~）保持原样，其余百分号编码。
  // 0x33='3'、0x44='D'、0x55='U'、0x66='f'、0x77='w' 都是非保留字符，因此原样出现。
  assert.match(url, /info_hash=%00%11%223DUfw%88%99%AA%BB%CC%DD%EE%FF%00%11%223&/);
  assert.match(url, /port=6881/);
  assert.match(url, /left=100/);

  // 真正要保证的性质：编码结果能被还原回原始字节
  const encoded = url.match(/info_hash=([^&]+)/)[1];
  const restored = Buffer.from(
    encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  );
  assert.equal(restored.equals(infoHash), true, '百分号编码必须可逆');

  assert.equal(percentEncodeBytes(Buffer.from('aZ0-_.~', 'latin1')), 'aZ0-_.~');
  assert.equal(percentEncodeBytes(Buffer.from([0x20, 0x2f, 0xff])), '%20%2F%FF');
});

test('tracker：解析紧凑 peer 列表与字典数组', () => {
  const compact = Buffer.from([127, 0, 0, 1, 0x1a, 0xe1, 10, 0, 0, 5, 0x00, 0x50]);
  assert.deepEqual(parsePeers(compact.toString('latin1'), undefined), [
    { host: '127.0.0.1', port: 6881 },
    { host: '10.0.0.5', port: 80 },
  ]);

  assert.deepEqual(parsePeers([{ ip: '1.2.3.4', port: 1234 }], undefined), [{ host: '1.2.3.4', port: 1234 }]);
  assert.deepEqual(parsePeers(undefined, undefined), []);
});

test('engine：normalizeTrackers 补默认 tracker 并去重（可关闭）', () => {
  const list = normalizeTrackers(['udp://a:1/announce', 'udp://a:1/announce', 'http://b/announce', 'not-a-url']);
  assert.equal(list[0], 'udp://a:1/announce');
  assert.equal(list[1], 'http://b/announce');
  assert.equal(list.includes('not-a-url'), false);
  assert.ok(list.length > 2, '默认应补上公共 tracker');
  assert.equal(new Set(list).size, list.length);

  // 关掉之后只保留磁力自带的
  assert.deepEqual(normalizeTrackers(['http://b/announce'], false), ['http://b/announce']);
  assert.deepEqual(normalizeTrackers([], false), []);
});

test('engine：generatePeerId 是 20 字节且带客户端前缀', () => {
  const peerId = generatePeerId();
  assert.equal(peerId.length, 20);
  assert.equal(peerId.subarray(0, 8).toString('latin1'), '-TS1000-');
  assert.notEqual(generatePeerId().toString('hex'), peerId.toString('hex'));
});

test('端到端：从本地假种子群用磁力下载单文件并逐字节校验', async () => {
  await withTempDir(async (dir) => {
    const content = crypto.randomBytes(70_000); // 5 个分片，最后一片不满
    const swarm = await startFakeSwarm({ content, name: 'hello.bin', pieceLength: 16_384 });

    const events = [];
    try {
      const result = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
        onProgress: (progress) => events.push(progress.phase),
      });

      assert.equal(result.completed, true);
      assert.equal(result.name, 'hello.bin');
      assert.equal(result.totalBytes, content.length);
      assert.equal(result.downloadedBytes, content.length);
      assert.equal(result.pieceCount, 5);

      const written = await fs.readFile(path.join(dir, 'hello.bin'));
      assert.equal(written.length, content.length);
      assert.equal(written.equals(content), true, '下载结果必须与原文件逐字节一致');

      assert.equal(swarm.stats.handshakes >= 1, true);
      assert.equal(swarm.stats.metadataRequests >= 1, true);
      assert.equal(swarm.stats.pieceRequests >= 5, true);
      assert.equal(swarm.stats.badRequests, 0);
      assert.ok(events.includes('metadata'));
      assert.ok(events.includes('done'));
    } finally {
      await swarm.close();
    }
  });
});

test('端到端：多文件种子按各自路径落盘', async () => {
  await withTempDir(async (dir) => {
    const first = crypto.randomBytes(20_000);
    const second = crypto.randomBytes(30_000);
    const content = Buffer.concat([first, second]);
    const pieceLength = 16_384;

    const infoBytes = buildMultiFileInfoDict({
      name: 'pack',
      pieceLength,
      content,
      files: [
        { length: first.length, path: ['a.txt'] },
        { length: second.length, path: ['sub', 'b.txt'] },
      ],
    });

    const swarm = await startFakeSwarm({ content, name: 'pack', pieceLength, overrideInfoBytes: infoBytes });
    try {
      const result = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
      });

      assert.equal(result.completed, true);
      assert.equal(result.files.length, 2);
      assert.deepEqual(result.files.map((file) => file.path), ['pack/a.txt', 'pack/sub/b.txt']);
      assert.equal((await fs.readFile(path.join(dir, 'pack', 'a.txt'))).equals(first), true);
      assert.equal((await fs.readFile(path.join(dir, 'pack', 'sub', 'b.txt'))).equals(second), true);
    } finally {
      await swarm.close();
    }
  });
});

test('端到端：metadataOnly 只解析元数据不落盘', async () => {
  await withTempDir(async (dir) => {
    const content = crypto.randomBytes(40_000);
    const swarm = await startFakeSwarm({ content, name: 'meta-only.bin' });

    try {
      const result = await fetchMetadataOnly({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
      });

      assert.equal(result.metadataOnly, true);
      assert.equal(result.name, 'meta-only.bin');
      assert.equal(result.totalBytes, content.length);
      assert.equal(result.downloadedBytes, 0);
      assert.equal(result.files.length, 1);
      assert.equal(swarm.stats.pieceRequests, 0, '不应请求任何分片');
      await assert.rejects(fs.readFile(path.join(dir, 'meta-only.bin')), /ENOENT/);
    } finally {
      await swarm.close();
    }
  });
});

test('端到端：maxBytes 安全阀会在达到上限后停下', async () => {
  await withTempDir(async (dir) => {
    const content = crypto.randomBytes(100_000);
    const swarm = await startFakeSwarm({ content, name: 'limited.bin' });

    try {
      const result = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
        maxBytes: 20_000,
      });

      assert.equal(result.completed, false);
      assert.equal(result.stoppedByLimit, true);
      assert.ok(result.downloadedBytes >= 20_000);
      assert.ok(result.downloadedBytes < content.length);
    } finally {
      await swarm.close();
    }
  });
});

test('端到端：续传会校验已有分片并跳过（不按文件大小粗判）', async () => {
  await withTempDir(async (dir) => {
    const content = crypto.randomBytes(100_000); // 7 个分片
    const swarm = await startFakeSwarm({ content, name: 'resume.bin' });

    try {
      // 第一趟：只下两个分片就停
      const partial = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
        maxBytes: 32_768,
      });
      assert.equal(partial.completed, false);
      const requestsAfterPartial = swarm.stats.pieceRequests;

      // 预分配会让文件大小等于完整长度，所以"按大小判断进度"一定会误判成已下完
      const sizeAfterPartial = (await fs.stat(path.join(dir, 'resume.bin'))).size;
      assert.equal(sizeAfterPartial, content.length, '文件应已被预分配到完整长度');

      // 第二趟：应该只补下剩下的分片
      const full = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
      });

      assert.equal(full.completed, true);
      assert.equal((await fs.readFile(path.join(dir, 'resume.bin'))).equals(content), true);

      const secondRunRequests = swarm.stats.pieceRequests - requestsAfterPartial;
      assert.ok(
        secondRunRequests < full.pieceCount,
        `续传应少请求一些分片（第二趟请求 ${secondRunRequests}，总 ${full.pieceCount} 片）`,
      );
    } finally {
      await swarm.close();
    }
  });
});

test('端到端：已有数据校验不通过时重新下载', async () => {
  await withTempDir(async (dir) => {
    const content = crypto.randomBytes(40_000);
    const swarm = await startFakeSwarm({ content, name: 'corrupt.bin' });

    try {
      // 先放一个同名但内容错误、长度正确的文件（模拟"看起来下过但其实是坏的"）
      await fs.writeFile(path.join(dir, 'corrupt.bin'), Buffer.alloc(content.length, 0xab));

      const result = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
      });

      assert.equal(result.completed, true);
      assert.equal((await fs.readFile(path.join(dir, 'corrupt.bin'))).equals(content), true, '坏数据必须被覆盖');
    } finally {
      await swarm.close();
    }
  });
});

test('端到端：没有 tracker 时给出明确错误（而不是静默卡住）', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      download({
        infoHash: 'a'.repeat(40),
        trackers: [],
        useDefaultTrackers: false,
        dir,
        timeoutMs: 3000,
        maxPeers: 1,
      }),
      /没有带任何 tracker|DHT/,
    );
  });
});

test('端到端：tracker 返回的 peer 不可用时明确失败（关掉 DHT 回退以保证确定性）', async () => {
  await withTempDir(async (dir) => {
    // 指向一个没人监听的端口
    await assert.rejects(
      download({
        infoHash: 'b'.repeat(40),
        trackers: ['http://127.0.0.1:1/announce'],
        useDefaultTrackers: false,
        useDht: false, // DHT 会做 UDP 迭代查找，这里要的是确定性的 tracker 失败路径
        dir,
        timeoutMs: 2000,
        maxPeers: 2,
      }),
      /既没从 tracker 拿到 peer|没有返回 peer|无法从任何 peer/,
    );
  });
});

test('端到端：tracker 失败时会回退 DHT，两者都失败才报错', async () => {
  await withTempDir(async (dir) => {
    const logs = [];
    await assert.rejects(
      download({
        infoHash: 'c'.repeat(40),
        trackers: ['http://127.0.0.1:1/announce'],
        useDefaultTrackers: false,
        useDht: true, // 显式打开 DHT：应能看到"改用 DHT 查找"的日志，最终仍失败
        dir,
        timeoutMs: 2000,
        maxPeers: 2,
        logger: (message) => logs.push(message),
      }),
      /DHT/,
    );

    const joined = logs.join('\n');
    assert.match(joined, /改用 DHT 查找/, 'tracker 失败后应尝试 DHT');
  });
});
