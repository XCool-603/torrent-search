import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { once } from 'node:events';

import {
  BOOTSTRAP_NODES,
  DHT_QUERY,
  dhtGetPeers,
  decodeNodeInfo,
  distance,
  encodeNodeInfo,
  generateNodeId,
  ipToBytes,
} from '../src/bt/dht.mjs';
import { decode } from '../src/bt/bencode.mjs';

/**
 * 起一个本地假 DHT 节点：
 * - 响应 ping / find_node；
 * - get_peers：对"已知"的 info hash 直接回 peers，否则回若干"更近"的节点（模拟迭代逼近）。
 */
async function startFakeDht({ knownHash = null, peersForKnown = [], closerNodes = [], dropQueries = 0 } = {}) {
  const socket = dgram.createSocket('udp4');
  const nodeId = generateNodeId();
  const received = { pings: 0, getPeers: 0, findNode: 0 };

  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));

  socket.on('message', (message, remote) => {
    let parsed;
    try {
      parsed = decode(message, 0).value;
    } catch {
      return;
    }
    if (!parsed || parsed.y !== 'q') return;

    if (received.pings + received.getPeers + received.findNode >= dropQueries && dropQueries > 0) return; // 模拟丢包

    const method = parsed.q;
    const args = parsed.a ?? {};
    const infoHash = typeof args.info_hash === 'string' ? Buffer.from(args.info_hash, 'latin1').toString('hex') : '';

    const reply = { t: parsed.t, y: 'r', r: { id: nodeId.toString('latin1') } };

    if (method === DHT_QUERY.PING) {
      received.pings += 1;
    } else if (method === DHT_QUERY.FIND_NODE) {
      received.findNode += 1;
      reply.r.nodes = encodeCompactNodes(closerNodes);
    } else if (method === DHT_QUERY.GET_PEERS) {
      received.getPeers += 1;
      if (knownHash && infoHash === knownHash && peersForKnown.length > 0) {
        reply.r.values = peersForKnown.map((peer) => {
          const ip = ipToBytes(peer.host);
          const out = Buffer.alloc(6);
          ip.copy(out, 0);
          out.writeUInt16BE(peer.port, 4);
          return out.toString('latin1');
        });
        reply.r.token = 'tok';
      } else {
        reply.r.nodes = encodeCompactNodes(closerNodes);
        reply.r.token = 'tok';
      }
    } else {
      return;
    }

    socket.send(Buffer.from(encodeReply(reply), 'latin1'), remote.port, remote.address);
  });

  return {
    port: socket.address().port,
    host: '127.0.0.1',
    nodeId,
    received,
    close: async () => {
      try {
        socket.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 把若干节点编码成紧凑节点信息串。
 * 注意：必须逐个用 latin1 转字符串再拼接——直接对 Buffer 数组 join('') 会走 UTF-8，
 * 而节点 id 是任意二进制，会被损坏（本项目在测试里踩过两次同类坑）。
 */
function encodeCompactNodes(nodes) {
  return nodes.map((node) => encodeNodeInfo({ id: node.id ?? generateNodeId(), host: node.host, port: node.port }).toString('latin1')).join('');
}

/** 用产品的 bencode 编码器构造回复（测试只需要和真实字节流一致） */
function encodeReply(dict) {
  return bencodeModule.encode(dict).toString('latin1');
}

const bencodeModule = await import('../src/bt/bencode.mjs');

test('DHT：节点 ID 是 20 字节且随机', () => {
  const first = generateNodeId();
  assert.equal(first.length, 20);
  assert.notEqual(generateNodeId().toString('hex'), first.toString('hex'));
});

test('DHT：ipToBytes 正确解析与拒绝非法 IP', () => {
  assert.deepEqual([...ipToBytes('127.0.0.1')], [127, 0, 0, 1]);
  assert.deepEqual([...ipToBytes('192.168.31.17')], [192, 168, 31, 17]);
  assert.equal(ipToBytes('999.1.1.1'), null);
  assert.equal(ipToBytes('localhost'), null);
  assert.equal(ipToBytes('::1'), null);
});

test('DHT：紧凑节点信息编码/解码往返', () => {
  const node = { id: generateNodeId(), host: '10.20.30.40', port: 51413 };
  const encoded = encodeNodeInfo(node);
  assert.equal(encoded.length, 26);

  const decoded = decodeNodeInfo(encoded.toString('latin1'));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].host, '10.20.30.40');
  assert.equal(decoded[0].port, 51413);
  assert.equal(decoded[0].id.equals(node.id), true);
});

test('DHT：多组节点信息可解析，残缺数据被忽略', () => {
  const a = encodeNodeInfo({ id: generateNodeId(), host: '1.1.1.1', port: 1111 });
  const b = encodeNodeInfo({ id: generateNodeId(), host: '2.2.2.2', port: 2222 });
  const joined = Buffer.concat([a, b]).toString('latin1');

  const decoded = decodeNodeInfo(joined);
  assert.equal(decoded.length, 2);
  assert.deepEqual(decoded.map((node) => node.host), ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(decodeNodeInfo('short'), []);
  assert.deepEqual(decodeNodeInfo(undefined), []);
});

test('DHT：XOR 距离可比较远近', () => {
  const target = generateNodeId();
  const near = Buffer.from(target);
  near[19] ^= 0x01; // 只差最后一位
  const far = generateNodeId();

  const dNear = distance(near, target);
  const dFar = distance(far, target);
  assert.equal(Buffer.compare(dNear, dFar) < 0, true, '更近的节点距离应更小');
  assert.equal(distance(target, target).equals(Buffer.alloc(20)), true, '与自身距离为 0');
});

test('DHT：本地假节点能直接返回 peer', async () => {
  const infoHash = crypto.randomBytes(20).toString('hex');
  const wanted = { host: '203.0.113.7', port: 6881 };

  const fake = await startFakeDht({ knownHash: infoHash, peersForKnown: [wanted] });
  try {
    const peers = await dhtGetPeers(infoHash, {
      bootstrap: [{ host: fake.host, port: fake.port }],
      timeoutMs: 4000,
      perQueryTimeoutMs: 1500,
    });

    assert.deepEqual(peers, [wanted]);
    assert.equal(fake.received.getPeers >= 1, true, '应至少发过一次 get_peers');
  } finally {
    await fake.close();
  }
});

test('DHT：需要迭代逼近时会继续查更近的节点', async () => {
  const infoHash = crypto.randomBytes(20).toString('hex');
  const target = { host: '198.51.100.9', port: 6882 };

  // 第一个节点不知道 peer，只回一个"更近"的节点（就是它自己端口+1 的另一个假节点）
  const second = await startFakeDht({ knownHash: infoHash, peersForKnown: [target] });
  const first = await startFakeDht({
    closerNodes: [{ id: generateNodeId(), host: second.host, port: second.port }],
  });

  try {
    const peers = await dhtGetPeers(infoHash, {
      bootstrap: [{ host: first.host, port: first.port }],
      timeoutMs: 6000,
      perQueryTimeoutMs: 1500,
      maxRounds: 4,
    });

    assert.deepEqual(peers, [target], '应通过第二轮找到 peer');
    assert.equal(second.received.getPeers >= 1, true, '第二个节点应被查询到');
  } finally {
    await first.close();
    await second.close();
  }
});

test('DHT：所有节点都无响应时返回空列表（不抛异常）', async () => {
  const infoHash = crypto.randomBytes(20).toString('hex');

  const peers = await dhtGetPeers(infoHash, {
    bootstrap: [{ host: '127.0.0.1', port: 1 }], // 没人监听
    timeoutMs: 2000,
    perQueryTimeoutMs: 600,
    maxRounds: 2,
  });

  assert.deepEqual(peers, []);
});

test('DHT：传入非法 info hash 立即报错', async () => {
  await assert.rejects(dhtGetPeers('not-a-hash'), /40 位 hex/);
  await assert.rejects(dhtGetPeers('abcd'), /40 位 hex/);
});

test('DHT：bootstrap 节点列表是公开且非空的默认值', () => {
  assert.ok(BOOTSTRAP_NODES.length >= 3);
  for (const node of BOOTSTRAP_NODES) {
    assert.equal(typeof node.host, 'string');
    assert.ok(node.port > 0 && node.port < 65536);
  }
});
