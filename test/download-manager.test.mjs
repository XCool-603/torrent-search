import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DownloadManager, defaultDownloadDir } from '../src/download/manager.mjs';

/**
 * 造一个可控的假引擎：按剧本推进进度、可响应取消。
 *
 * @param {{steps?: number, failAt?: string, delayMs?: number}} [script]
 */
function fakeEngine(script = {}) {
  const calls = [];
  const engine = async (options) => {
    calls.push(options.infoHash);
    const steps = script.steps ?? 2;

    for (let index = 0; index < steps; index += 1) {
      if (options.signal?.aborted) throw new Error('已取消');
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      options.onProgress?.({
        phase: index === 0 ? 'metadata' : 'downloading',
        name: `file-${options.infoHash.slice(0, 4)}.bin`,
        totalBytes: 1000,
        bytesDone: ((index + 1) * 500),
        piecesDone: index + 1,
        pieceCount: steps,
        speed: 1024,
        peersConnected: 3,
        peersAvailable: 5,
      });
    }

    if (script.failAt === 'end') throw new Error('boom');
    return {
      infoHash: options.infoHash,
      name: `file-${options.infoHash.slice(0, 4)}.bin`,
      totalBytes: 1000,
      downloadedBytes: 1000,
      pieceCount: steps,
      files: [{ path: `file-${options.infoHash.slice(0, 4)}.bin`, length: 1000 }],
      completed: true,
      stoppedByLimit: false,
      tookMs: 5,
    };
  };
  engine.calls = calls;
  return engine;
}

async function withTempManager(run, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-manager-'));
  const persistFile = path.join(dir, 'downloads.json');
  const manager = new DownloadManager({
    dir,
    persistFile,
    maxConcurrent: options.maxConcurrent ?? 1,
    engine: options.engine ?? fakeEngine(),
    logger: () => {},
  });
  try {
    await run(manager, dir, persistFile);
  } finally {
    for (const task of manager.tasks.values()) task.controller?.abort();
  }
}

test('add：接受磁力链接与裸 info hash，并生成任务快照', async () => {
  await withTempManager(async (manager) => {
    const fromMagnet = manager.add({
      input: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=test&tr=udp%3A%2F%2Ft%3A1`,
    });
    assert.equal(fromMagnet.infoHash, 'a'.repeat(40));
    // 任务名初始取磁力里的 dn；引擎拿到元数据后会被真实名称覆盖
    assert.equal(fromMagnet.name, 'test');
    assert.equal(fromMagnet.status, 'queued');
    assert.deepEqual(fromMagnet.trackers, ['udp://t:1']);

    const fromHash = manager.add({ input: 'B'.repeat(40) });
    assert.equal(fromHash.infoHash, 'b'.repeat(40));
    assert.equal(fromHash.name, 'bbbbbbbbbbbb');

    assert.throws(() => manager.add({ input: 'not-a-hash' }), /既不是磁力链接/);
    assert.throws(() => manager.add({ input: 'magnet:?dn=only-name' }), /没有合法的 info hash/);
    assert.throws(() => manager.add({ input: '' }), /请提供磁力链接/);
  });
});

test('add：同一 info hash 的进行中任务会去重', async () => {
  await withTempManager(async (manager) => {
    const first = manager.add({ input: 'c'.repeat(40) });
    const second = manager.add({ input: 'c'.repeat(40) });
    assert.equal(second.id, first.id);
    assert.equal(manager.list().length, 1);
  });
});

test('执行：queued → metadata → downloading → done，进度字段齐全', async () => {
  await withTempManager(async (manager) => {
    const updates = [];
    manager.on('update', (task) => updates.push(task.status));
    manager.on('progress', (task) => {
      assert.equal(typeof task.progress, 'number');
      assert.ok(task.progress >= 0 && task.progress <= 1);
    });

    const task = manager.add({ input: 'd'.repeat(40) });
    await manager.waitForIdle();

    const done = manager.get(task.id);
    assert.equal(done.status, 'done');
    assert.equal(done.totalBytes, 1000);
    assert.equal(done.bytesDone, 1000);
    assert.equal(done.files.length, 1);
    assert.ok(done.finishedAt >= done.startedAt);
    assert.ok(updates.includes('queued') && updates.includes('metadata') && updates.includes('downloading') && updates.includes('done'));
  });
});

test('执行：失败任务记录原因，不吞异常', async () => {
  await withTempManager(async (manager) => {
    manager.engine = fakeEngine({ failAt: 'end', steps: 2 });
    const task = manager.add({ input: 'e'.repeat(40) });
    await manager.waitForIdle();

    const failed = manager.get(task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /boom/);
  });
});

test('并发：maxConcurrent=1 时第二个任务排队等待', async () => {
  const slow = fakeEngine({ delayMs: 80 });
  await withTempManager(
    async (manager) => {
      const first = manager.add({ input: 'f'.repeat(40) });
      const second = manager.add({ input: '1'.repeat(40) });

      // 第一个还在跑时，第二个应该仍在排队
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(manager.get(second.id).status, 'queued');
      assert.equal(manager.get(first.id).status !== 'queued', true);

      await manager.waitForIdle();
      assert.equal(manager.get(first.id).status, 'done');
      assert.equal(manager.get(second.id).status, 'done');
      assert.deepEqual(slow.calls.length, 2);
    },
    { engine: slow },
  );
});

test('取消：运行中的任务中断并标记 cancelled', async () => {
  const neverEnding = async (options) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ completed: true, files: [] }), 30_000);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('已取消'));
      });
    });
  };

  await withTempManager(
    async (manager) => {
      const task = manager.add({ input: '9'.repeat(40) });
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(manager.cancel(task.id), true);
      await manager.waitForIdle();

      const cancelled = manager.get(task.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.error, '已取消');

      // 已结束的任务不能再取消
      assert.equal(manager.cancel(task.id), false);
    },
    { engine: neverEnding },
  );
});

test('删除：可删记录，也可连文件一起删（只限下载目录内）', async () => {
  await withTempManager(async (manager, dir) => {
    const task = manager.add({ input: '7'.repeat(40) });
    await manager.waitForIdle();

    const target = path.join(dir, `file-7777.bin`);
    await fs.writeFile(target, 'x');
    // 造一个目录外的文件，验证不会被误删
    const outside = path.join(path.dirname(dir), 'outside.txt');
    await fs.writeFile(outside, 'keep');

    assert.equal(await manager.remove(task.id, { deleteFiles: true }), true);
    assert.equal(manager.get(task.id), null);
    await assert.rejects(fs.readFile(target), /ENOENT/);
    assert.equal((await fs.readFile(outside, 'utf8')).toString(), 'keep');
    await fs.rm(outside, { force: true });
  });
});

test('持久化：save/load 往返，未完成任务恢复为 interrupted', async () => {
  const engine = fakeEngine();
  await withTempManager(
    async (manager, dir, persistFile) => {
      manager.add({ input: '5'.repeat(40) });
      await manager.waitForIdle();

      // 手动塞一个"进行中"的任务再保存，模拟进程被杀。
      // 直接改 tasks 表而绕过 add()：add 里的 run() 是异步启动的，这里要精确控制状态
      manager.tasks.set('stalled-1', {
        id: 'stalled-1',
        infoHash: '3'.repeat(40),
        magnet: `magnet:?xt=urn:btih:${'3'.repeat(40)}`,
        trackers: [],
        name: 'stalled',
        dir,
        status: 'downloading',
        phase: 'downloading',
        totalBytes: 1000,
        bytesDone: 500,
        piecesDone: 1,
        pieceCount: 2,
        speed: 0,
        peersConnected: 1,
        peersAvailable: 1,
        files: [],
        error: null,
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: null,
        controller: null,
      });
      await manager.save();

      const reloaded = new DownloadManager({ dir, persistFile, engine, logger: () => {} });
      const restored = await reloaded.load();
      assert.equal(restored, 2);

      const doneTask = reloaded.list().find((task) => task.infoHash === '5'.repeat(40));
      assert.equal(doneTask.status, 'done');

      const interrupted = reloaded.list().find((task) => task.infoHash === '3'.repeat(40));
      assert.equal(interrupted.status, 'interrupted');
      assert.match(interrupted.error, /中断/);
    },
    { engine },
  );
});

test('持久化：损坏的任务文件不会让加载崩溃', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-manager-'));
  const persistFile = path.join(dir, 'downloads.json');
  try {
    await fs.writeFile(persistFile, '{ this is not json');
    const manager = new DownloadManager({ dir, persistFile, engine: fakeEngine(), logger: () => {} });
    assert.equal(await manager.load(), 0);
    assert.deepEqual(manager.list(), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('defaultDownloadDir 支持环境变量覆盖', () => {
  const saved = process.env.TORRENT_SEARCH_DOWNLOAD_DIR;
  try {
    delete process.env.TORRENT_SEARCH_DOWNLOAD_DIR;
    assert.ok(defaultDownloadDir().endsWith(path.join('Downloads', 'torrent-search')));

    process.env.TORRENT_SEARCH_DOWNLOAD_DIR = 'D:\\tmp\\dl';
    assert.equal(defaultDownloadDir(), path.resolve('D:\\tmp\\dl'));
  } finally {
    if (saved === undefined) delete process.env.TORRENT_SEARCH_DOWNLOAD_DIR;
    else process.env.TORRENT_SEARCH_DOWNLOAD_DIR = saved;
  }
});
