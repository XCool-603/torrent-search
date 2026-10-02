#!/usr/bin/env node
/**
 * 用无头浏览器给 Web UI 截图（零依赖：Node 内置 WebSocket + CDP）。
 *
 * 为什么自己写：项目坚持零运行时依赖，不想为了截图引入 Playwright/Puppeteer。
 * Chromium 系浏览器（Chrome/Edge）自带 DevTools Protocol，Node ≥ 22 有内置 WebSocket，
 * 两者一拼就能做"导航 → 等待渲染 → 点击 → 截图"。
 *
 * 用法：
 *   node tools/screenshot.mjs --url "http://127.0.0.1:8787/?q=ubuntu" \
 *     --out docs/screenshot-search.png --wait-for "#results-body tr" --width 1400 --height 950
 *
 *   node tools/screenshot.mjs --url "http://127.0.0.1:8787/?q=ubuntu" \
 *     --out docs/screenshot-downloads.png --click "#downloads-toggle" --wait-for ".dl-task"
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { width: 1400, height: 950, timeoutMs: 40_000, scale: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (key === 'width' || key === 'height' || key === 'timeout' || key === 'scale') {
      options[key === 'timeout' ? 'timeoutMs' : key] = Number(value);
    } else {
      options[key] = value;
    }
    index += 1;
  }
  return options;
}

/**
 * 找一个可用的 Chromium 系浏览器。
 *
 * @returns {Promise<string>}
 */
async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 下一个 */
    }
  }
  throw new Error('找不到 Chrome/Edge，无法截图');
}

/**
 * 极简 CDP 客户端。
 */
class Cdp {
  /**
   * @param {string} webSocketUrl
   */
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', (event) => reject(new Error(`CDP 连接失败：${event.message ?? 'unknown'}`)));
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  /**
   * 发一条 CDP 命令。
   *
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 在页面里求值。
   *
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本出错：${result.exceptionDetails.text ?? ''} ${result.exceptionDetails.exception?.description ?? ''}`);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 极简 PNG 解码（只支持 8 位 RGB/RGBA、非隔行——Chromium 截图就是这个格式）。
 *
 * 为什么需要：截图是否"其实是空白页"这种失败，靠文件大小看不出来。
 * 这里解出像素算一下亮度统计，就能自动判断。
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, channels: number, pixels: Buffer}|null}
 */
function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];

      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);

      out[x] = value & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 统计截图内容（判断是否空白/单色）。
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, meanLuma: number, stdLuma: number, distinctColors: number}|null}
 */
function analyzePng(buffer) {
  const decoded = decodePng(buffer);
  if (!decoded) return null;

  const { width, height, channels, pixels } = decoded;
  const colors = new Set();
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  // 每 7 个像素采样一个，够用且快
  for (let y = 0; y < height; y += 7) {
    for (let x = 0; x < width; x += 7) {
      const index = (y * width + x) * channels;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      sum += luma;
      sumSquares += luma * luma;
      count += 1;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }

  const mean = sum / count;
  const variance = Math.max(0, sumSquares / count - mean * mean);

  return {
    width,
    height,
    meanLuma: Math.round(mean * 10) / 10,
    stdLuma: Math.round(Math.sqrt(variance) * 10) / 10,
    distinctColors: colors.size,
  };
}

/**
 * 轮询等待某个选择器出现。
 *
 * @param {Cdp} cdp
 * @param {string} selector
 * @param {number} timeoutMs
 */
async function waitForSelector(cdp, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length > 0`);
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待元素超时：${selector}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.url || !options.out) {
    throw new Error('必须提供 --url 与 --out');
  }

  const browserPath = await findBrowser();
  const port = 9222 + Math.floor(Math.random() * 500);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-shot-'));

  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${options.width},${options.height}`,
      options.url,
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  try {
    // 等调试端口就绪，并找到目标页面
    const deadline = Date.now() + options.timeoutMs;
    let target = null;
    while (Date.now() < deadline && !target) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        const list = await response.json();
        target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      } catch {
        /* 还没起来 */
      }
    }
    if (!target) throw new Error('浏览器调试端口没有就绪');

    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 固定视口，保证截图尺寸稳定（与 --window-size 双保险）
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      mobile: false,
    });

    // 等页面加载完成
    await cdp.evaluate('document.readyState');
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 等待渲染条件（点击前）
    if (options['wait-for']) {
      await waitForSelector(cdp, options['wait-for'], options.timeoutMs);
    }

    // 点击（可多次，逗号分隔）
    // 点击会重试：页面的 init() 是异步的，点击可能落在"监听器还没绑定"的空档上
    // （实测踩过：点下载面板开关没反应，等到超时）
    if (options.click) {
      const selectors = String(options.click).split(',').map((item) => item.trim());
      const attempts = options['wait-after'] ? 3 : 1;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        for (const selector of selectors) {
          const clicked = await cdp.evaluate(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
          );
          if (!clicked) throw new Error(`找不到要点击的元素：${selector}`);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }

        if (!options['wait-after']) break;

        // 点击后等目标元素；等不到就再点一次
        try {
          await waitForSelector(cdp, options['wait-after'], Math.min(options.timeoutMs, 8000));
          break;
        } catch (error) {
          if (attempt === attempts - 1) throw error;
          process.stdout.write(`  （第 ${attempt + 1} 次点击后没等到 ${options['wait-after']}，重试）\n`);
        }
      }
    }

    // 额外等待（异步渲染）
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, Number(options.delay)));

    // 在页面里求值并打印（排查"为什么没渲染出预期元素"时很有用）
    if (options.eval) {
      const value = await cdp.evaluate(String(options.eval));
      process.stdout.write(`  页面求值结果：${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: options['full-page'] === 'true',
    });

    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    const buffer = Buffer.from(shot.data, 'base64');
    await fs.writeFile(options.out, buffer);

    const stat = await fs.stat(options.out);
    process.stdout.write(`✓ 已保存 ${options.out}（${Math.round(stat.size / 1024)} KB，${options.width}×${options.height}）\n`);

    // 内容自检：空白页/单色页在这里会被抓出来（截图"看起来对不对"没法靠文件大小判断）
    const stats = analyzePng(buffer);
    if (stats) {
      process.stdout.write(
        `  像素统计：均值亮度 ${stats.meanLuma}，标准差 ${stats.stdLuma}，颜色数 ${stats.distinctColors}\n`,
      );
      if (stats.stdLuma < 3 || stats.distinctColors < 4) {
        process.stderr.write('  ⚠ 画面几乎是单色，截图可能是空白页，请检查页面是否正常渲染\n');
        process.exitCode = 1;
      }
    } else {
      process.stdout.write('  （PNG 格式不在简易解码器支持范围内，跳过像素自检）\n');
    }
  } finally {
    cdp?.close();
    browser.kill();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`截图失败：${error?.message ?? error}\n`);
  process.exitCode = 1;
});
