#!/usr/bin/env node
/**
 * 前端性能测量（零依赖：CDP + 内置 WebSocket）。
 *
 *   node tools/perf.mjs                       # 默认测 http://127.0.0.1:8787/?q=ubuntu
 *   node tools/perf.mjs --url "http://127.0.0.1:8787/?q=进击的巨人" --page-size 100
 *
 * 量的是**渲染成本**，不是网络耗时：
 *   - Script / RecalcStyle / Layout / Task 时长（CDP Performance.getMetrics 的差值）
 *   - DOM 节点数
 *   - 关键交互的墙钟时间（点击排序、输入关键词、切换过滤器）
 *   - 长任务（>50ms）的数量与最长一次
 *
 * 做性能优化前后各跑一次，数字才说明问题。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

/** 在页面里最先执行：记录长任务与关键时间点 */
const INSTRUMENTATION = `
window.__perf = { longTasks: [], marks: {} };
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__perf.longTasks.push(Math.round(entry.duration));
    }
  }).observe({ entryTypes: ['longtask'] });
} catch (error) { /* 浏览器不支持 longtask */ }
`;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:8787/?q=ubuntu', 'page-size': 100, width: 1400, height: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    options[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 下一个 */
    }
  }
  throw new Error('找不到 Chrome/Edge，无法测量');
}

/** 极简 CDP 客户端（与 tools/screenshot.mjs 同源思路） */
class Cdp {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面脚本出错');
    return result.result?.value;
  }

  /** 取一组性能指标（返回普通对象） */
  async metrics() {
    const { metrics } = await this.send('Performance.getMetrics');
    const out = {};
    for (const metric of metrics) out[metric.name] = metric.value;
    return out;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 指标差值（毫秒；CDP 的时长单位是秒） */
function diff(before, after, keys) {
  const out = {};
  for (const key of keys) out[key] = Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000);
  return out;
}

function formatRow(label, values) {
  return `  ${label.padEnd(22)} ${values}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browserPath = await findBrowser();
  const port = 9700 + Math.floor(Math.random() * 200);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-perf-'));

  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${options.width},${options.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  try {
    // 等调试端口
    let target = null;
    for (let index = 0; index < 60 && !target; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
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
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Number(options.width),
      height: Number(options.height),
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 注入：长任务观察器 + 预设偏好（每页条数）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('torrent-search:pageSize', '${Number(options['page-size']) || 100}'); } catch (error) {}`,
    });

    process.stdout.write(`▸ 打开 ${options.url}（每页 ${options['page-size']} 条）\n`);

    const wallStart = Date.now();
    await cdp.send('Page.navigate', { url: options.url });

    // 等结果渲染出来
    let rows = 0;
    for (let index = 0; index < 100; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      rows = await cdp.evaluate(`document.querySelectorAll('#results-body tr').length`);
      if (rows > 0) break;
    }
    const firstRenderMs = Date.now() - wallStart;

    // 等图片/布局稳定
    await new Promise((resolve) => setTimeout(resolve, 800));
    const afterRender = await cdp.metrics();

    process.stdout.write(`\n【首屏】\n`);
    process.stdout.write(formatRow('结果行数', rows) + '\n');
    process.stdout.write(formatRow('DOM 节点数', afterRender.Nodes) + '\n');
    process.stdout.write(formatRow('JS 堆（MB）', (afterRender.JSHeapUsedSize / 1024 / 1024).toFixed(1)) + '\n');
    process.stdout.write(formatRow('到首屏结果的墙钟(ms)', firstRenderMs) + '\n');
    process.stdout.write(
      formatRow(
        '累计脚本/样式/布局(ms)',
        `${Math.round(afterRender.ScriptDuration * 1000)} / ${Math.round(afterRender.RecalcStyleDuration * 1000)} / ${Math.round(afterRender.LayoutDuration * 1000)}`,
      ) + '\n',
    );

    /** 量一次交互：点一下、等 DOM 变化，返回 { wall, metrics 差值 } */
    const measure = async (label, action, selectorToWatch) => {
      const before = await cdp.metrics();
      const wall = await cdp.evaluate(`(async () => {
        const t0 = performance.now();
        ${action}
        const node = document.querySelector(${JSON.stringify(selectorToWatch)});
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          const observer = new MutationObserver(finish);
          if (node) observer.observe(node, { childList: true, subtree: true, characterData: true });
          setTimeout(finish, 3000);
        });
        return Math.round(performance.now() - t0);
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = await cdp.metrics();
      const delta = diff(before, after, ['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration']);
      process.stdout.write(
        formatRow(label, `墙钟 ${wall}ms ｜ 脚本 ${delta.ScriptDuration}ms ｜ 样式 ${delta.RecalcStyleDuration}ms ｜ 布局 ${delta.LayoutDuration}ms ｜ 任务 ${delta.TaskDuration}ms`) + '\n',
      );
      return { wall, delta };
    };

    process.stdout.write(`\n【交互】\n`);
    await measure('点击排序（做种数）', `document.querySelector('#th-sort-seeders').click();`, '#results-body');
    await measure('切换安全过滤', `document.querySelector('#safe').click();`, '#results-body');
    await measure(
      '输入 8 个字符',
      `(() => { const input = document.querySelector('#q'); input.focus(); for (const ch of 'ubuntuxy') { input.value += ch; input.dispatchEvent(new Event('input', { bubbles: true })); } })();`,
      '#search-input',
    );

    const longTasks = await cdp.evaluate('window.__perf.longTasks');
    process.stdout.write(`\n【长任务】（>50ms 会明显掉帧）\n`);
    process.stdout.write(formatRow('数量', longTasks.length) + '\n');
    process.stdout.write(formatRow('最长(ms)', longTasks.length > 0 ? Math.max(...longTasks) : 0) + '\n');
    if (longTasks.length > 0) process.stdout.write(formatRow('明细(ms)', longTasks.slice(0, 12).join(', ')) + '\n');

    // 滚动帧率：卡顿最直接的体现。逐帧记录间隔，统计平均/p95/掉帧数。
    process.stdout.write(`\n【滚动帧率】（60fps ≈ 16.7ms/帧）\n`);
    const scroll = await cdp.evaluate(`(async () => {
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = (now) => {
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      for (let index = 0; index < 40; index += 1) {
        window.scrollBy(0, 500);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      running = false;
      const sorted = frames.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      return {
        frames: frames.length,
        avg: Math.round(frames.reduce((sum, value) => sum + value, 0) / Math.max(1, frames.length) * 10) / 10,
        p95: Math.round(p95 * 10) / 10,
        worst: Math.round(Math.max(...frames, 0) * 10) / 10,
        janky: frames.filter((value) => value > 50).length,
      };
    })()`);
    process.stdout.write(formatRow('帧数', scroll.frames) + '\n');
    process.stdout.write(formatRow('平均/帧(ms)', scroll.avg) + '\n');
    process.stdout.write(formatRow('p95(ms)', scroll.p95) + '\n');
    process.stdout.write(formatRow('最差(ms)', scroll.worst) + '\n');
    process.stdout.write(formatRow('掉帧(>50ms)', scroll.janky) + '\n');

    const final = await cdp.metrics();
    process.stdout.write(
      `\n【全程】脚本 ${Math.round(final.ScriptDuration * 1000)}ms ｜ 样式 ${Math.round(final.RecalcStyleDuration * 1000)}ms ｜ 布局 ${Math.round(final.LayoutDuration * 1000)}ms ｜ 节点 ${final.Nodes}\n`,
    );

    return 0;
  } finally {
    cdp?.close();
    browser.kill();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`测量失败：${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
