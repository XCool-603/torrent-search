import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectContainer,
  envBool,
  envInt,
  envString,
  resolveBackendDefault,
  resolveDownloadDirOverride,
  resolveHostDefault,
  resolvePortDefault,
  resolveQbitDefault,
} from '../src/env.mjs';

/**
 * 临时设置环境变量并保证还原。
 *
 * @param {Record<string, string|undefined>} vars
 * @param {() => void|Promise<void>} run
 */
async function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];

  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 容器检测                                                            */
/* ------------------------------------------------------------------ */

test('detectContainer：显式环境变量优先（用于测试与用户强制指定）', async () => {
  await withEnv({ TORRENT_SEARCH_CONTAINER: '1' }, () => {
    assert.equal(detectContainer(), true);
  });

  await withEnv({ TORRENT_SEARCH_CONTAINER: '0' }, () => {
    // 显式说"不在容器里"时，即使真的在容器里也按 false 处理
    assert.equal(detectContainer({ fileExists: () => true }), false);
  });
});

test('detectContainer：/.dockerenv 存在即判定为容器', async () => {
  await withEnv({ TORRENT_SEARCH_CONTAINER: undefined }, () => {
    const result = detectContainer({
      fileExists: (path) => path === '/.dockerenv',
      readCgroup: () => null,
    });
    assert.equal(result, true);
  });
});

test('detectContainer：从 /proc/1/cgroup 关键字识别', async () => {
  await withEnv({ TORRENT_SEARCH_CONTAINER: undefined }, () => {
    const cgroups = [
      '12:pids:/docker/abc123',
      '0::/kubepods/besteffort/pod123',
      '1:name=systemd:/containerd/xyz',
      '0::/libpod-abc',
    ];
    for (const cgroup of cgroups) {
      assert.equal(
        detectContainer({ fileExists: () => false, readCgroup: () => cgroup }),
        true,
        `应识别：${cgroup}`,
      );
    }
  });
});

test('detectContainer：本机（无标记）判定为非容器', async () => {
  await withEnv({ TORRENT_SEARCH_CONTAINER: undefined }, () => {
    assert.equal(detectContainer({ fileExists: () => false, readCgroup: () => '0::/init.scope' }), false);
    assert.equal(detectContainer({ fileExists: () => false, readCgroup: () => null }), false);
  });
});

/* ------------------------------------------------------------------ */
/* 环境变量读取                                                        */
/* ------------------------------------------------------------------ */

test('envString：空串视为未设置', async () => {
  await withEnv({ TS_TEST_A: '  value  ', TS_TEST_B: '   ', TS_TEST_C: undefined }, () => {
    assert.equal(envString('TS_TEST_A', 'fallback'), 'value');
    assert.equal(envString('TS_TEST_B', 'fallback'), 'fallback');
    assert.equal(envString('TS_TEST_C', 'fallback'), 'fallback');
  });
});

test('envInt：只接受正整数，非法值回退', async () => {
  await withEnv({ TS_TEST_N: '9090', TS_TEST_BAD: 'abc', TS_TEST_ZERO: '0', TS_TEST_NEG: '-5' }, () => {
    assert.equal(envInt('TS_TEST_N', 1), 9090);
    assert.equal(envInt('TS_TEST_BAD', 1), 1);
    assert.equal(envInt('TS_TEST_ZERO', 1), 1);
    assert.equal(envInt('TS_TEST_NEG', 1), 1);
    assert.equal(envInt('TS_TEST_MISSING', 7), 7);
  });
});

test('envBool：识别常见真值/假值写法', async () => {
  await withEnv({ TS_TEST_T: 'true', TS_TEST_Y: 'YES', TS_TEST_F: 'false', TS_TEST_O: 'off', TS_TEST_X: 'maybe' }, () => {
    assert.equal(envBool('TS_TEST_T', false), true);
    assert.equal(envBool('TS_TEST_Y', false), true);
    assert.equal(envBool('TS_TEST_F', true), false);
    assert.equal(envBool('TS_TEST_O', true), false);
    assert.equal(envBool('TS_TEST_X', true), true, '无法识别时用回退值');
    assert.equal(envBool('TS_TEST_MISSING', false), false);
  });
});

/* ------------------------------------------------------------------ */
/* 默认值解析：容器 vs 本机                                             */
/* ------------------------------------------------------------------ */

test('resolveHostDefault：容器里绑 0.0.0.0，本机绑回环', () => {
  assert.equal(resolveHostDefault({ inContainer: true }), '0.0.0.0');
  assert.equal(resolveHostDefault({ inContainer: false }), '127.0.0.1');
});

test('resolveQbitDefault：容器里指向宿主机，本机指向回环', () => {
  assert.equal(resolveQbitDefault({ inContainer: true }), 'http://host.docker.internal:8080');
  assert.equal(resolveQbitDefault({ inContainer: false }), 'http://127.0.0.1:8080');
});

test('环境变量能覆盖所有默认值', async () => {
  await withEnv(
    {
      TORRENT_SEARCH_HOST: '192.168.1.10',
      TORRENT_SEARCH_PORT: '9000',
      TORRENT_SEARCH_QBITTORRENT: 'http://10.0.0.5:8080|admin|pw',
      TORRENT_SEARCH_BACKEND: 'builtin',
      TORRENT_SEARCH_DOWNLOAD_DIR: '/mnt/dl',
      TORRENT_SEARCH_CONTAINER: undefined,
    },
    () => {
      // 显式指定时不再看容器与否
      assert.equal(resolveHostDefault({ inContainer: true }), '192.168.1.10');
      assert.equal(resolvePortDefault(), 9000);
      assert.equal(resolveQbitDefault({ inContainer: true }), 'http://10.0.0.5:8080|admin|pw');
      assert.equal(resolveBackendDefault(), 'builtin');
      assert.equal(resolveDownloadDirOverride(), '/mnt/dl');
    },
  );
});

test('resolvePortDefault / resolveBackendDefault 的兜底值', async () => {
  await withEnv({ TORRENT_SEARCH_PORT: undefined, TORRENT_SEARCH_BACKEND: undefined }, () => {
    assert.equal(resolvePortDefault(), 8787);
    assert.equal(resolveBackendDefault(), 'auto');
    assert.equal(resolveDownloadDirOverride(), null);
  });
});
