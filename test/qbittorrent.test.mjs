import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startFakeQbit } from './helpers/fake-qbit.mjs';
import { QbitClient, parseQbitConfig, mapQbitState, mapQbitTorrent } from '../src/download/qbit.mjs';
import { DownloadManager } from '../src/download/manager.mjs';

const HASH = 'a'.repeat(40);

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-qbit-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * 起假 qBittorrent，并保证无论如何都关掉它。
 * 否则断言失败时服务器常驻，测试进程会挂住不退出（踩过一次）。
 *
 * @param {any} options
 * @param {(fake: any) => Promise<void>} run
 */
async function withFakeQbit(options, run) {
  const fake = await startFakeQbit(options);
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数：配置解析与状态映射                                            */
/* ------------------------------------------------------------------ */

test('parseQbitConfig：解析 url[|user|pass] 三种形态', () => {
  assert.deepEqual(parseQbitConfig('http://127.0.0.1:8080|admin|secret'), {
    baseUrl: 'http://127.0.0.1:8080',
    username: 'admin',
    password: 'secret',
  });

  assert.deepEqual(parseQbitConfig('127.0.0.1:9090'), {
    baseUrl: 'http://127.0.0.1:9090',
    username: 'admin',
    password: '',
  });

  assert.equal(parseQbitConfig('').baseUrl, 'http://127.0.0.1:8080');
  assert.equal(parseQbitConfig(null).username, 'admin');
  assert.equal(parseQbitConfig('http://127.0.0.1:8080/').baseUrl, 'http://127.0.0.1:8080');
});

test('mapQbitState：qB 状态映射到本项目状态', () => {
  assert.equal(mapQbitState('downloading'), 'downloading');
  assert.equal(mapQbitState('metaDL'), 'metadata');
  assert.equal(mapQbitState('stalledDL'), 'downloading');
  assert.equal(mapQbitState('uploading'), 'done');
  assert.equal(mapQbitState('stalledUP'), 'done');
  assert.equal(mapQbitState('pausedDL'), 'paused');
  assert.equal(mapQbitState('error'), 'failed');
  assert.equal(mapQbitState('missingFiles'), 'failed');
  // 未知状态按"下载中"处理（保守：不误判成完成或失败）
  assert.equal(mapQbitState('someFutureState'), 'downloading');
});

test('mapQbitTorrent：字段对应关系正确', () => {
  const mapped = mapQbitTorrent({
    name: 'movie.mkv',
    size: 1000,
    progress: 0.25,
    dlspeed: 2048,
    num_seeds: 3,
    num_leechs: 2,
    num_complete: 10,
    num_incomplete: 4,
    pieces_num: 8,
    pieces_have: 2,
    state: 'downloading',
    save_path: 'C:/dl',
  });

  assert.equal(mapped.status, 'downloading');
  assert.equal(mapped.phase, 'downloading');
  assert.equal(mapped.name, 'movie.mkv');
  assert.equal(mapped.totalBytes, 1000);
  assert.equal(mapped.bytesDone, 250);
  assert.equal(mapped.speed, 2048);
  assert.equal(mapped.peersConnected, 5);
  assert.equal(mapped.peersAvailable, 14);
  assert.equal(mapped.piecesDone, 2);
  assert.equal(mapped.savePath, 'C:/dl');
});

test('mapQbitTorrent：缺字段时不产生 NaN', () => {
  const mapped = mapQbitTorrent({});
  assert.equal(mapped.totalBytes, 0);
  assert.equal(mapped.bytesDone, 0);
  assert.equal(mapped.speed, 0);
  assert.equal(mapped.peersConnected, 0);
  assert.equal(Number.isNaN(mapped.bytesDone), false);
});

/* ------------------------------------------------------------------ */
/* QbitClient 与假 qBittorrent 服务                                     */
/* ------------------------------------------------------------------ */

test('QbitClient：登录 + ping + 添加磁力 + 列任务 + 文件 + 删除', async () => {
  await withFakeQbit({ progressSteps: 2 }, async (fake) => {
    const client = new QbitClient(parseQbitConfig(`${fake.baseUrl}|admin|secret`));

    const ping = await client.ping();
    assert.equal(ping.ok, true);
    assert.match(ping.version, /5\.2\.4/);

    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=test`;
    const added = await client.addMagnet({ magnet, savePath: 'C:/dl', category: 'torrent-search' });
    assert.equal(added.ok, true);
    assert.equal(fake.requests.add.length, 1);
    assert.equal(fake.requests.add[0].savepath, 'C:/dl');
    assert.equal(fake.requests.add[0].category, 'torrent-search');

    const list = await client.listTorrents({ hash: HASH });
    assert.equal(list.length, 1);
    assert.equal(list[0].hash, HASH);

    const files = await client.files(HASH);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'movie.mkv');

    await client.deleteTorrent(HASH, { deleteFiles: true });
    assert.deepEqual(fake.requests.delete[0], { hashes: HASH, deleteFiles: 'true' });
  });
});

test('QbitClient：add 返回 Fails. 时报错', async () => {
  await withFakeQbit({ failAdd: true }, async (fake) => {
    const client = new QbitClient(parseQbitConfig(`${fake.baseUrl}|admin|secret`));
    const result = await client.addMagnet({ magnet: `magnet:?xt=urn:btih:${HASH}` });
    assert.equal(result.ok, false);
    assert.match(result.error, /拒绝/);
  });
});

test('QbitClient：Cookie 失效（403）会自动重新登录', async () => {
  await withFakeQbit({ requireAuth: true }, async (fake) => {
    const client = new QbitClient(parseQbitConfig(`${fake.baseUrl}|admin|secret`));

    await client.login();
    assert.equal(fake.stats.login, 1);

    // 人为破坏 Cookie，下一次请求应 403 → 自动重登 → 成功
    client.cookie = 'SID=wrong';
    const version = await client.request('/api/v2/app/version').then((response) => response.text());

    assert.match(version, /5\.2\.4/);
    assert.equal(fake.stats.unauthorized >= 1, true, '应发生过一次 403');
    assert.equal(fake.stats.login >= 2, true, '应自动重新登录');
  });
});

test('QbitClient：服务不可达时 ping 返回 ok:false 而不是抛异常', async () => {
  const client = new QbitClient(parseQbitConfig('http://127.0.0.1:1|admin|secret'));
  const ping = await client.ping();
  assert.equal(ping.ok, false);
  assert.ok(ping.error);
});

/* ------------------------------------------------------------------ */
/* 管理器集成：把任务交给 qBittorrent                                    */
/* ------------------------------------------------------------------ */

test('管理器：backend=qbittorrent 时任务交给 qB 并跟踪进度直到完成', async () => {
  await withFakeQbit(
    { progressSteps: 2, files: [{ name: 'a.mkv', size: 600 }, { name: 'b.srt', size: 400 }] },
    async (fake) => {
      await withTempDir(async (dir) => {
        const manager = new DownloadManager({
          dir,
          persistFile: null,
          backend: 'qbittorrent',
          qbit: `${fake.baseUrl}|admin|secret`,
          logger: () => {},
        });

        const task = manager.add({ input: `magnet:?xt=urn:btih:${HASH}&dn=qb-task` });
        assert.equal(task.backend, 'qbittorrent');

        await manager.waitForIdle();
        const final = manager.get(task.id);

        assert.equal(final.status, 'done');
        assert.equal(final.bytesDone, 1000);
        assert.equal(final.progress, 1);
        assert.equal(final.files.length, 2);
        assert.equal(fake.requests.add.length, 1, '应真的调用了 qB 的添加接口');
        assert.match(fake.requests.add[0].urls, new RegExp(HASH));
        assert.equal(fake.requests.add[0].savepath, dir, '保存路径应传给 qB');
      });
    },
  );
});

test('管理器：backend=auto 在 qB 可用时选 qB，不可用时回退内置引擎', async () => {
  await withFakeQbit({ progressSteps: 1 }, async (fake) => {
    await withTempDir(async (dir) => {
      // ① qB 可用 → 选 qbittorrent
      let qbitEngineCalled = false;
      const withQbit = new DownloadManager({
        dir,
        persistFile: null,
        backend: 'auto',
        qbit: `${fake.baseUrl}|admin|secret`,
        engine: async () => {
          qbitEngineCalled = true;
          throw new Error('不应该走到内置引擎');
        },
        logger: () => {},
      });

      const t1 = withQbit.add({ input: `magnet:?xt=urn:btih:${HASH}` });
      await withQbit.waitForIdle();
      assert.equal(qbitEngineCalled, false, 'qB 可用时不应使用内置引擎');
      assert.equal(withQbit.get(t1.id).backend, 'qbittorrent');
      assert.equal(withQbit.get(t1.id).status, 'done');

      // ② qB 不可用 → 回退 builtin
      let engineCalled = false;
      const withoutQbit = new DownloadManager({
        dir,
        persistFile: null,
        backend: 'auto',
        qbit: 'http://127.0.0.1:1|admin|secret',
        engine: async (options) => {
          engineCalled = true;
          options.onProgress?.({ phase: 'downloading', name: 'x', totalBytes: 10, bytesDone: 10, piecesDone: 1, pieceCount: 1 });
          return { completed: true, files: [{ path: 'x', length: 10 }], totalBytes: 10, downloadedBytes: 10, pieceCount: 1 };
        },
        logger: () => {},
      });

      const t2 = withoutQbit.add({ input: `magnet:?xt=urn:btih:${'b'.repeat(40)}` });
      await withoutQbit.waitForIdle();

      assert.equal(engineCalled, true, 'qB 不可用时应回退内置引擎');
      assert.equal(withoutQbit.get(t2.id).backend, 'builtin');
      assert.equal(withoutQbit.get(t2.id).status, 'done');
    });
  });
});

test('管理器：qB 任务取消会从 qB 移除（保留文件）', async () => {
  await withFakeQbit({ progressSteps: 1000 }, async (fake) => {
    await withTempDir(async (dir) => {
      const manager = new DownloadManager({
        dir,
        persistFile: null,
        backend: 'qbittorrent',
        qbit: `${fake.baseUrl}|admin|secret`,
        logger: () => {},
      });

      const task = manager.add({ input: `magnet:?xt=urn:btih:${HASH}` });

      // 等它真的开始（qB 收到 add）
      for (let index = 0; index < 60 && fake.requests.add.length === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(fake.requests.add.length, 1, 'qB 应已收到添加请求');

      manager.cancel(task.id);
      await manager.waitForIdle();

      const final = manager.get(task.id);
      assert.equal(final.status, 'cancelled');
      assert.equal(fake.requests.delete.length >= 1, true, '取消应通知 qB 移除任务');
      assert.equal(fake.requests.delete[0].deleteFiles, 'false', '取消不应删文件');
    });
  });
});

test('管理器：删除 qB 任务时 deleteFiles 会传给 qB', async () => {
  await withFakeQbit({ progressSteps: 1 }, async (fake) => {
    await withTempDir(async (dir) => {
      const manager = new DownloadManager({
        dir,
        persistFile: null,
        backend: 'qbittorrent',
        qbit: `${fake.baseUrl}|admin|secret`,
        logger: () => {},
      });

      const task = manager.add({ input: `magnet:?xt=urn:btih:${HASH}` });
      await manager.waitForIdle();

      await manager.remove(task.id, { deleteFiles: true });
      assert.equal(fake.requests.delete.length, 1);
      assert.equal(fake.requests.delete[0].deleteFiles, 'true');
    });
  });
});

test('管理器：qB 报告失败状态时任务标记 failed', async () => {
  await withFakeQbit({ progressSteps: 1, state: 'error' }, async (fake) => {
    await withTempDir(async (dir) => {
      const manager = new DownloadManager({
        dir,
        persistFile: null,
        backend: 'qbittorrent',
        qbit: `${fake.baseUrl}|admin|secret`,
        logger: () => {},
      });

      const task = manager.add({ input: `magnet:?xt=urn:btih:${HASH}` });
      await manager.waitForIdle();

      const final = manager.get(task.id);
      assert.equal(final.status, 'failed');
      assert.match(final.error, /失败/);
    });
  });
});

test('管理器：autoResume 会把中断的任务重新入队', async () => {
  await withTempDir(async (dir) => {
    const persistFile = path.join(dir, 'tasks.json');
    const engine = async () => ({
      completed: true,
      files: [{ path: 'x', length: 1 }],
      totalBytes: 1,
      downloadedBytes: 1,
      pieceCount: 1,
    });

    // 造一个"上次进程被杀时正在下载"的记录
    await fs.writeFile(
      persistFile,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'stalled-1',
            infoHash: 'c'.repeat(40),
            magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
            trackers: [],
            name: 'stalled',
            dir,
            backend: 'builtin',
            status: 'downloading',
            totalBytes: 100,
            bytesDone: 50,
            files: [],
            createdAt: Date.now(),
          },
        ],
      }),
      'utf8',
    );

    // 不自动续传：保持 interrupted
    const idle = new DownloadManager({ dir, persistFile, engine, logger: () => {} });
    await idle.load();
    assert.equal(idle.list()[0].status, 'interrupted');

    // 自动续传：变成 queued 并跑完
    const auto = new DownloadManager({ dir, persistFile, engine, logger: () => {} });
    await auto.load({ autoResume: true });
    await auto.waitForIdle();
    assert.equal(auto.list()[0].status, 'done');
    assert.equal(auto.list()[0].bytesDone, 1);
  });
});
