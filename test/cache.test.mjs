import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DiskCache, defaultCacheDir } from '../src/cache.mjs';

/**
 * 每个用例一个独立临时目录，避免相互干扰。
 */
async function withTempCache(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-search-cache-'));
  try {
    await run(new DiskCache({ dir }), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('DiskCache：写入后可读回，并带 mtime/age 信息', async () => {
  await withTempCache(async (cache) => {
    await cache.set('hello', 'world');

    const hit = await cache.get('hello');
    assert.ok(hit);
    assert.equal(hit.body.toString('utf8'), 'world');
    assert.ok(Number.isFinite(hit.mtimeMs));
    assert.ok(hit.ageMs >= 0 && hit.ageMs < 5000);
  });
});

test('DiskCache：mtime 略微超前时 ageMs 钳为 0（Windows 时间戳取整）', async () => {
  await withTempCache(async (cache) => {
    await cache.set('future', 'data');

    // 模拟 NTFS 时间戳取整：让 mtime 比当前时间晚几毫秒
    const future = new Date(Date.now() + 5);
    await fs.utimes(cache.filePath('future'), future, future);

    const hit = await cache.get('future');
    assert.ok(hit);
    assert.equal(hit.ageMs, 0, '负数年龄没有意义，应钳为 0');
    assert.ok(hit.mtimeMs > Date.now(), 'mtime 本身仍如实返回');
  });
});

test('DiskCache：未命中返回 null 而不是抛异常', async () => {
  await withTempCache(async (cache) => {
    assert.equal(await cache.get('missing'), null);
  });
});

test('DiskCache：maxAgeMs 过期后视为未命中，并且不删除文件', async () => {
  await withTempCache(async (cache, dir) => {
    await cache.set('ttl', 'data');
    assert.equal((await cache.get('ttl', { maxAgeMs: 60_000 })).body.toString(), 'data');

    // 把 mtime 往前调 2 小时，模拟过期
    const file = cache.filePath('ttl');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    await fs.utimes(file, old, old);

    assert.equal(await cache.get('ttl', { maxAgeMs: 3600 * 1000 }), null);
    assert.equal(await cache.get('ttl', { maxAgeMs: 24 * 3600 * 1000 }) !== null, true);
    assert.ok((await fs.readdir(dir)).length >= 1);
  });
});

test('DiskCache：key 会被清洗，恶意 key 无法穿越目录', async () => {
  await withTempCache(async (cache, dir) => {
    const evil = await cache.set('../../evil', 'x');
    const deeper = await cache.set('..\\..\\evil2', 'y');
    const absolute = await cache.set('/etc/passwd', 'z');

    // 真正的安全属性：文件一定落在缓存目录的**直接子级**，且文件名里没有路径分隔符
    for (const file of [evil, deeper, absolute]) {
      assert.equal(path.dirname(file), dir, `${file} 应该直接位于缓存目录下`);
      assert.equal(/[\\/]/.test(path.basename(file)), false, `${path.basename(file)} 不应含路径分隔符`);
      assert.equal(file.startsWith(dir + path.sep), true);
    }

    // 不同的 key 不会互相覆盖
    assert.equal((await cache.get('../../evil')).body.toString(), 'x');
    assert.equal((await cache.get('..\\..\\evil2')).body.toString(), 'y');
    assert.equal((await cache.get('/etc/passwd')).body.toString(), 'z');
  });
});

test('DiskCache：写入使用临时文件 + rename（不会读到半个文件）', async () => {
  await withTempCache(async (cache, dir) => {
    await cache.set('atomic', Buffer.from('12345'));

    const files = await fs.readdir(dir);
    assert.equal(files.filter((name) => name.endsWith('.tmp')).length, 0, '不应残留临时文件');
    assert.equal(files.length, 1);
  });
});

test('DiskCache：getOrFetch 首次下载、二次命中缓存', async () => {
  await withTempCache(async (cache) => {
    let fetches = 0;
    const options = {
      maxAgeMs: 60_000,
      fetch: async () => {
        fetches += 1;
        return Buffer.from('远程内容');
      },
      transform: (body) => body.toString('utf8'),
    };

    const first = await cache.getOrFetch('remote', options);
    assert.equal(first.cached, false);
    assert.equal(first.value, '远程内容');
    assert.equal(fetches, 1);

    const second = await cache.getOrFetch('remote', options);
    assert.equal(second.cached, true);
    assert.equal(second.value, '远程内容');
    assert.equal(fetches, 1, '第二次不应再发起下载');
  });
});

test('DiskCache：getOrFetch 在写入失败时仍然返回数据', async () => {
  // 用一个不可能创建成功的目录（文件占位）来制造写入失败
  const blocker = path.join(os.tmpdir(), `torrent-search-blocker-${process.pid}`);
  await fs.writeFile(blocker, 'not a directory');

  try {
    const cache = new DiskCache({ dir: path.join(blocker, 'nested') });
    const result = await cache.getOrFetch('key', {
      fetch: async () => '仍然可用',
      transform: (body) => body.toString('utf8'),
      logger: () => {},
    });

    assert.equal(result.cached, false);
    assert.equal(result.value, '仍然可用');
  } finally {
    await fs.rm(blocker, { force: true });
  }
});

test('DiskCache：logger 会收到命中/未命中信息', async () => {
  await withTempCache(async (cache) => {
    const messages = [];
    const logger = (message) => messages.push(message);

    await cache.getOrFetch('logged', { maxAgeMs: 60_000, fetch: async () => 'a', logger });
    await cache.getOrFetch('logged', { maxAgeMs: 60_000, fetch: async () => 'a', logger });

    assert.ok(messages.some((message) => message.includes('缓存未命中')));
    assert.ok(messages.some((message) => message.includes('命中缓存')));
  });
});

test('defaultCacheDir 支持环境变量覆盖，且默认落在用户缓存目录', () => {
  const saved = process.env.TORRENT_SEARCH_CACHE;
  try {
    delete process.env.TORRENT_SEARCH_CACHE;
    const fallback = defaultCacheDir();
    assert.ok(path.isAbsolute(fallback));
    assert.match(fallback, /torrent-search/);

    process.env.TORRENT_SEARCH_CACHE = path.join(os.tmpdir(), 'custom-cache');
    assert.equal(defaultCacheDir(), path.join(os.tmpdir(), 'custom-cache'));
  } finally {
    if (saved === undefined) delete process.env.TORRENT_SEARCH_CACHE;
    else process.env.TORRENT_SEARCH_CACHE = saved;
  }
});
