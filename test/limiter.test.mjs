import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SpeedLimiter, parseSpeedLimit } from '../src/bt/limiter.mjs';
import { startFakeSwarm } from './helpers/fake-swarm.mjs';
import { download } from '../src/bt/engine.mjs';

test('parseSpeedLimit：支持人类可写的写法', () => {
  assert.equal(parseSpeedLimit('2M'), 2 * 1024 * 1024);
  assert.equal(parseSpeedLimit('500K'), 500 * 1024);
  assert.equal(parseSpeedLimit('1.5M'), Math.floor(1.5 * 1024 * 1024));
  assert.equal(parseSpeedLimit('2MiB'), 2 * 1024 * 1024);
  assert.equal(parseSpeedLimit('100'), 100);
  assert.equal(parseSpeedLimit(1024), 1024);
});

test('parseSpeedLimit：0 / 空值 / 非法输入都返回 null（不限速）', () => {
  for (const value of ['0', '', 'off', 'none', null, undefined, 0, -5, 'abc', '1Z']) {
    assert.equal(parseSpeedLimit(value), null, `${JSON.stringify(value)} 应该不限速`);
  }
});

test('SpeedLimiter：不限速时 acquire 立即通过', async () => {
  const limiter = new SpeedLimiter({ bytesPerSecond: 1024 * 1024 });
  // 等一拍让令牌积累（初始为 0，这正是限速语义的一部分）
  await new Promise((resolve) => setTimeout(resolve, 150));
  const started = Date.now();
  await limiter.acquire(1024);
  assert.ok(Date.now() - started < 50, '令牌充足时应当立即通过');
  limiter.stop();
});

test('SpeedLimiter：严格限速时实际耗时符合预期', async () => {
  // 100 KiB/s 取 200 KiB：初始 0 令牌，需要等约 2 秒（第一个 100ms 补 10 KiB，逐步积累）
  const limiter = new SpeedLimiter({ bytesPerSecond: 100 * 1024 });
  const started = Date.now();

  await limiter.acquire(200 * 1024);

  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1500, `按 100KiB/s 下 200KiB 至少约 2 秒（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 6000, `不应等太久（实际 ${elapsed}ms）`);
  limiter.stop();
});

test('SpeedLimiter：stop() 后挂起的等待立即放行', async () => {
  const limiter = new SpeedLimiter({ bytesPerSecond: 1024 });

  // 先把桶吃空
  await limiter.acquire(1024);
  const pending = limiter.acquire(1024); // 需要等补充

  // 稍等一拍再 stop，等待者应立即被放行
  await new Promise((resolve) => setTimeout(resolve, 30));
  limiter.stop();

  await pending; // 不应挂起
  assert.ok(true);
});

test('SpeedLimiter：等待令牌期间会 ref 住定时器（否则进程可能提前退出）', async () => {
  const limiter = new SpeedLimiter({ bytesPerSecond: 50 * 1024 });

  // 空闲时不应拖住进程
  assert.equal(limiter.timer.hasRef(), false, '空闲时应 unref');

  // 开始等令牌（一次要的量远超桶容量，必然进入等待）
  const pending = limiter.acquire(200 * 1024);
  assert.equal(limiter.timer.hasRef(), true, '等待期间必须 ref，否则事件循环空了进程会退出');

  limiter.stop();
  await pending; // stop() 会放行等待者
  assert.equal(limiter.timer, null, 'stop() 后不应残留定时器');
});

test('SpeedLimiter：非法速率在构造时报错', () => {
  assert.throws(() => new SpeedLimiter({ bytesPerSecond: 0 }), /非法/);
  assert.throws(() => new SpeedLimiter({ bytesPerSecond: -100 }), /非法/);
  assert.throws(() => new SpeedLimiter({ bytesPerSecond: Number.NaN }), /非法/);
});

test('端到端：limitSpeed 会实际拉长下载耗时', async () => {
  await withTempDir(async (dir) => {
    const content = crypto.randomBytes(120_000);
    const swarm = await startFakeSwarm({ content, name: 'limited.bin' });

    try {
      const started = Date.now();
      const result = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
        limitSpeed: 120 * 1024, // 120 KiB/s，下载 120 KiB 应约 1 秒
      });

      assert.equal(result.completed, true);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 800, `限速应拉长耗时（实际 ${elapsed}ms）`);
      assert.ok(elapsed < 15_000, `不应过久（实际 ${elapsed}ms）`);

      const written = await fs.readFile(path.join(dir, 'limited.bin'));
      assert.equal(written.equals(content), true);
    } finally {
      await swarm.close();
    }
  });
});

test('端到端：不限速时下载明显更快（对照）', async () => {
  await withTempDir(async (dir) => {
    const content = crypto.randomBytes(120_000);
    const swarm = await startFakeSwarm({ content, name: 'unlimited.bin' });

    try {
      const started = Date.now();
      const result = await download({
        infoHash: swarm.infoHash,
        trackers: swarm.trackers,
        useDefaultTrackers: false,
        dir,
        timeoutMs: 8000,
      });

      assert.equal(result.completed, true);
      // 基线：数据传输本身只要几 ms，加上握手/announce 约 100~300ms
      // （这里只断言"明显快于限速版"，避免对慢环境过脆）
      assert.ok(Date.now() - started < 2000, `不限速应明显更快（实际 ${Date.now() - started}ms）`);
    } finally {
      await swarm.close();
    }
  });
}, { timeout: 30_000 });

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-limiter-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
