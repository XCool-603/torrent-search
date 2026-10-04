#!/usr/bin/env node
/**
 * 边下边播演示 / 手动验收脚本。
 *
 * 用法：
 *   node tools/stream-demo.mjs                     本地假种子群 + 生成的 WAV，不需要真实 P2P
 *   node tools/stream-demo.mjs --magnet "<磁力>"    用真实种子（需要 P2P 可用，见 doctor）
 *   node tools/stream-demo.mjs --port 8899         换端口
 *
 * 为什么要这个脚本：自动化测试验的是"字节对不对"，但"能不能真的播起来"只有人能看到。
 * 这里用本地假种子群当 peer（因为受限网络下真实 P2P 常被拦），把一个真实可播的音频文件
 * 按种子分片供出去，再限速下载 —— 于是浏览器打开播放地址时，是**边下边播**。
 *
 * 音高随时间上升，所以能直接听出"播到哪了"；文件没下完就能听，就说明流式生效了。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startServer } from '../src/server.mjs';
import { DownloadManager } from '../src/download/manager.mjs';
import { createContext } from '../src/index.mjs';
import { startFakeSwarm, buildInfoDict } from '../test/helpers/fake-swarm.mjs';

/**
 * 生成一个合法的 WAV（PCM，无需任何编码器，浏览器原生可播）。
 *
 * 频率随时间线性上升：听感上就是"一直往上爬"，方便确认播放进度在推进。
 *
 * @param {{seconds: number, sampleRate?: number, baseFreq?: number}} options
 * @returns {Buffer}
 */
function buildWav({ seconds, sampleRate = 16_000, baseFreq = 300 }) {
  const sampleCount = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(sampleCount * 2);

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const freq = baseFreq + 400 * (t / seconds); // 300Hz → 700Hz
    const value = Math.sin(2 * Math.PI * freq * t) * 0.35 * 32_767;
    data.writeInt16LE(Math.round(value), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // 字节率
  header.writeUInt16LE(2, 32); // 块对齐
  header.writeUInt16LE(16, 34); // 位深
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { port: 8787, seconds: 40, speed: 48_000, magnet: null, pieceLength: 65_536 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--seconds') options.seconds = Number(argv[++i]);
    else if (arg === '--speed') options.speed = Number(argv[++i]);
    else if (arg === '--piece-length') options.pieceLength = Number(argv[++i]);
    else if (arg === '--magnet') options.magnet = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node tools/stream-demo.mjs [--port 8787] [--seconds 40] [--speed 48000] [--magnet "<磁力>"]');
      process.exit(0);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-demo-'));

let swarm = null;
let infoHash;
let magnet;
let expectedBytes = null;

if (options.magnet) {
  magnet = options.magnet;
  infoHash = /xt=urn:btih:([0-9a-fA-F]{40})/.exec(magnet)?.[1]?.toLowerCase();
  if (!infoHash) {
    console.error('磁力链接里没找到 40 位 info hash');
    process.exit(1);
  }
} else {
  // 默认：本地假种子群。内容是一个真实可播的 WAV，所以浏览器打开就能听。
  const content = buildWav({ seconds: options.seconds });
  swarm = await startFakeSwarm({ content, name: 'demo-tone.wav', pieceLength: options.pieceLength });
  infoHash = swarm.infoHash;
  magnet = swarm.magnet;
  expectedBytes = content.length;
}

// 搜索上下文必须用 createContext()：它组装了带 getJson/getText/request 的 HTTP 客户端
// 与磁盘缓存。随手传个 { proxy: null } 的话，搜索接口会全源报
// "ctx.http.getJson is not a function" —— 这个坑我踩过。
const ctx = await createContext({ proxy: null });

const manager = new DownloadManager({
  dir,
  persistFile: null,
  logger: (message) => console.log(`  [引擎] ${message}`),
  useDefaultTrackers: Boolean(options.magnet), // 假 swarm 模式下不需要公共 tracker
  useDht: Boolean(options.magnet),
  // 限速是为了让"下载中"这个窗口足够长，你才来得及打开浏览器听
  limitSpeed: options.speed,
});

const instance = await startServer({
  port: options.port,
  host: '127.0.0.1',
  http: ctx.http,
  cache: ctx.cache,
  version: 'demo',
  logger: () => {},
  downloadManager: manager,
});

manager.add({ input: magnet, backend: 'builtin' });

console.log('');
console.log('  边下边播演示');
console.log('  ─────────────────────────────────────────────');
console.log(`  下载目录   ${dir}`);
console.log(`  info hash  ${infoHash}`);
console.log(`  限速       ${Math.round(options.speed / 1024)} KB/s${expectedBytes ? `（约 ${(expectedBytes / options.speed).toFixed(0)} 秒下完）` : ''}`);
if (expectedBytes) console.log(`  内容       ${(expectedBytes / 1024 / 1024).toFixed(2)} MB WAV（音高持续上升，能听出播到哪了）`);
console.log('');
console.log('  等几秒让引擎拿到元数据，然后打开这个地址：');
console.log('');
console.log(`    http://127.0.0.1:${instance.port}/api/stream/${infoHash}/0`);
console.log('');
console.log(`  文件清单：http://127.0.0.1:${instance.port}/api/stream/${infoHash}`);
console.log('');
console.log('  文件没下完就能播放 = 流式生效。Ctrl+C 结束并清理。');
console.log('');

// 等元数据就绪再把清单打出来，让人能立刻看到文件表
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const current = manager.internalByInfoHash(infoHash);
  if (current?.session) {
    const files = current.session.torrent.files;
    console.log('  元数据就绪，文件表：');
    files.forEach((file, index) => {
      console.log(`    [${index}] ${file.path}  ${(file.length / 1024).toFixed(0)} KB`);
    });
    console.log('');
    break;
  }
  if (['failed', 'cancelled'].includes(current?.status)) {
    console.error(`  下载失败：${current.error}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** 收尾：关服务、关假种子群、删临时目录 */
async function shutdown() {
  console.log('\n  收尾中…');
  await instance.close().catch(() => {});
  await swarm?.close().catch(() => {});
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log('  已清理');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 定期打印进度，便于观察"边下边播"确实在推进
const timer = setInterval(() => {
  const snapshot = manager.list()[0];
  if (!snapshot) return;
  const percent = snapshot.totalBytes > 0 ? ((snapshot.bytesDone / snapshot.totalBytes) * 100).toFixed(1) : '0.0';
  console.log(`  [进度] ${snapshot.status}  ${percent}%  ${(snapshot.bytesDone / 1024).toFixed(0)} KB  ${(snapshot.speed / 1024).toFixed(0)} KB/s`);
}, 3_000);
timer.unref?.();
