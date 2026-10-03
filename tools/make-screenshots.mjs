/**
 * 为 README 生成 Web UI 截图（零依赖：CDP + 内置 WebSocket）。
 *
 * 刻意用**独立的临时服务实例**（独立端口 + 独立下载目录），原因：
 *   1. 不污染用户真实的下载任务列表；
 *   2. 用户的任务列表里有私人记录，绝不能出现在公开仓库的截图里。
 *
 * 下载任务用本地假种子群造（真实引擎跑完整流程），文件内容与名称都是合成的演示数据。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { startFakeSwarm } = await import('../test/helpers/fake-swarm.mjs');

const PORT = 8788;
const demoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-shot-dl-'));
const content = crypto.randomBytes(2 * 1024 * 1024);

console.log('① 启动假种子群（合成内容 2 MiB）…');
const swarm = await startFakeSwarm({ content, name: 'demo-sample.bin', pieceLength: 32_768 });
console.log('   infoHash =', swarm.infoHash);

console.log('② 启动临时服务实例（端口', PORT, '，独立下载目录）…');
const server = spawn(
  process.execPath,
  ['bin/magnet-search.mjs', 'serve', '--port', String(PORT), '--dir', demoDir, '--no-extra-trackers', '--backend', 'builtin'],
  { stdio: 'ignore', detached: false },
);

const waitForHealth = async () => {
  for (let index = 0; index < 40; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

try {
  if (!(await waitForHealth())) throw new Error('临时服务没起来');

  console.log('③ 通过 API 创建一个真实下载任务…');
  const created = await fetch(`http://127.0.0.1:${PORT}/api/downloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: swarm.magnet }),
  }).then((response) => response.json());
  console.log('   任务 id =', created.id, ' 名称 =', created.name);

  let final = null;
  for (let index = 0; index < 400; index += 1) {
    final = await fetch(`http://127.0.0.1:${PORT}/api/downloads/${created.id}`).then((response) => response.json());
    if (['done', 'failed', 'stopped'].includes(final.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log('   最终状态 =', final.status, ' 已下载 =', final.bytesDone, '/', final.totalBytes);
  if (final.status !== 'done') throw new Error(`演示任务没有完成：${final.status} ${final.error ?? ''}`);

  const shots = [
    {
      out: 'docs/screenshot-search.png',
      args: ['--wait-for', '#results-body tr'],
    },
    {
      out: 'docs/screenshot-downloads.png',
      // 必须先等搜索结果渲染出来：那说明应用的 init() 已完成（事件已绑定），
      // 否则点击可能落在"监听器还没绑定"的空档上
      args: ['--wait-for', '#results-body tr', '--click', '#downloads-toggle', '--wait-after', '.dl-task', '--delay', '600'],
    },
  ];

  for (const shot of shots) {
    console.log(`④ 截图 ${shot.out} …`);
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          'tools/screenshot.mjs',
          '--url',
          `http://127.0.0.1:${PORT}/?q=ubuntu`,
          '--out',
          shot.out,
          '--width',
          '1400',
          '--height',
          '1000',
          ...shot.args,
        ],
        { stdio: 'inherit' },
      );
      child.on('exit', (code) => resolve(code));
    });
    if (result !== 0) throw new Error(`截图失败：${shot.out}`);
  }

  console.log('⑤ 完成');
} finally {
  server.kill();
  await swarm.close();
  await fs.rm(demoDir, { recursive: true, force: true }).catch(() => {});
}
