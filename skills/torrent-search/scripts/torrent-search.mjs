#!/usr/bin/env node
/**
 * 种子搜索 skill 的包装脚本。
 *
 * 为什么直接 import 项目模块，而不是 spawn CLI：
 *   1. 沙箱环境下 Node 的 piped stdio 可能失败（不能开命名管道），import 完全绕开这个问题；
 *   2. 更快，不用起进程、不用解析给人看的表格；
 *   3. 输出可控：搜索结果是紧凑 JSON，模型不必从对齐后的表格里反推字段。
 *
 * 唯一的例外是 doctor：它要打印一整套给人看的诊断，直接以 inherit 方式复用 CLI，
 * 不捕获输出，因此也不会碰到管道问题。
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* 定位项目本体                                                        */
/* ------------------------------------------------------------------ */

/**
 * 找到 torrent-search 项目的根目录。
 *
 * 依次尝试：--home → 环境变量 → 从脚本自身位置推导（skill 以目录联结安装时，
 * import.meta.url 是真实路径，也就是仓库内）→ 从当前目录向上找 → 安装时写的记录文件。
 *
 * @param {string|undefined} explicit
 * @returns {string}
 */
function resolveToolHome(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.TORRENT_SEARCH_HOME) candidates.push(process.env.TORRENT_SEARCH_HOME);

  // skills/torrent-search/scripts/ → 上溯三级就是仓库根
  candidates.push(path.resolve(SCRIPT_DIR, '..', '..', '..'));

  // 从当前目录向上找
  let cursor = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  // 安装脚本留下的记录
  const record = path.join(os.homedir(), '.dsh', 'torrent-search-home.txt');
  try {
    const recorded = fs.readFileSync(record, 'utf8').trim();
    if (recorded) candidates.push(recorded);
  } catch {
    /* 没有记录文件是正常的 */
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fs.existsSync(path.join(candidate, 'bin', 'magnet-search.mjs'))) return path.resolve(candidate);
  }

  throw new Error(
    '找不到 torrent-search 项目根目录。请设置环境变量 TORRENT_SEARCH_HOME 指向项目路径，或用 --home <路径> 指定。',
  );
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

/** 明确取布尔值的标志。`--no-` 前缀的也一律按布尔处理（见下）。 */
const BOOLEAN_FLAGS = new Set(['text', 'magnet-only', 'safe', 'no-cache', 'verbose', 'json', 'help', 'dump-options']);

/**
 * 解析参数。
 *
 * 两个必须防住的坑（都踩过）：
 *   1. 布尔标志漏登记会被当成"带值选项"，于是吞掉后面的参数，造成**参数错位**
 *      （`--no-extra-trackers --no-dht` 曾让引擎仍去等 6 个公共 tracker 超时）；
 *   2. 带值选项后面紧跟另一个标志时，不能把标志当值吃掉。
 *
 * @param {string[]} argv
 * @returns {{options: Record<string, any>, positional: string[]}}
 */
function parseArgs(argv) {
  const options = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split('=');

    // `--no-xxx` 一律是开关；其余布尔标志按白名单
    if (inlineValue === undefined && (key.startsWith('no-') || BOOLEAN_FLAGS.has(key))) {
      options[key] = true;
      continue;
    }

    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      // 缺值：交给各自的默认值处理，绝不吞掉下一个标志
      options[key] = undefined;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { options, positional };
}

function intOption(options, key, fallback) {
  const raw = options[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

/**
 * 聚合搜索，输出紧凑 JSON。
 *
 * @param {string} home
 * @param {Record<string, any>} options
 * @param {string[]} positional
 */
async function commandSearch(home, options, positional) {
  const query = positional.join(' ').trim();
  if (!query) throw new Error('search 需要关键词，例如：search "ubuntu 24.04"');

  const { createContext, searchAll } = await import(pathToFileURL(path.join(home, 'src', 'index.mjs')).href);

  const limit = Math.max(1, Math.min(100, intOption(options, 'limit', 10)));
  const ctx = await createContext({
    proxy: options.proxy ?? 'auto',
    verbose: options.verbose === true,
    logger: options.verbose === true ? (message) => process.stderr.write(`[debug] ${message}\n`) : undefined,
  });

  const response = await searchAll({
    query,
    sources: options.sources ?? 'default',
    sort: options.sort ?? 'relevance',
    order: options.order ?? 'desc',
    pageSize: limit,
    page: 1,
    minSeeders: intOption(options, 'min-seeders', 0),
    exclude: options.exclude ?? '',
    safe: options.safe === true,
    bypassCache: options['no-cache'] === true,
    cacheTtlMs: 60_000,
    timeoutMs: intOption(options, 'timeout-ms', 8000),
    ...ctx,
  });

  const results = response.results.map((item) => ({
    title: item.title,
    size: item.sizeText,
    sizeBytes: item.size,
    seeders: item.seeders,
    leechers: item.leechers,
    infoHash: item.infoHash,
    magnet: item.magnet,
    sources: item.sources,
    publishedAt: item.publishedAt,
    category: item.category,
  }));

  if (options['magnet-only'] === true) {
    out(results.map((item) => item.magnet).join('\n'));
    return 0;
  }

  if (options.text === true) {
    out(`搜索「${query}」：命中 ${response.total} 条（过滤前 ${response.totalBeforeFilter}），耗时 ${response.tookMs}ms`);
    out(
      `源：${response.sources
        .map((source) => `${source.id}${source.ok ? `✓${source.count}` : `✗${source.error ?? '失败'}`}`)
        .join('  ')}`,
    );
    results.forEach((item, index) => {
      out(`#${index + 1}  ${item.size ?? '未知体积'}  做种 ${item.seeders ?? '?'}  ${item.title}`);
      out(`     ${item.magnet}`);
    });
    return 0;
  }

  out(
    JSON.stringify(
      {
        ok: true,
        query,
        total: response.total,
        totalBeforeFilter: response.totalBeforeFilter,
        tookMs: response.tookMs,
        cached: response.cached,
        sources: response.sources.map((source) => ({
          id: source.id,
          ok: source.ok,
          count: source.count,
          tookMs: source.tookMs,
          error: source.error,
        })),
        results,
      },
      null,
      2,
    ),
  );
  return 0;
}

/**
 * 列出数据源。
 *
 * @param {string} home
 */
async function commandSources(home) {
  const { listSources } = await import(pathToFileURL(path.join(home, 'src', 'sources', 'index.mjs')).href);
  const sources = listSources().map((source) => ({
    id: source.id,
    name: source.name,
    description: source.description,
    homepage: source.homepage,
    kinds: source.kinds,
    defaultEnabled: source.defaultEnabled,
    offline: source.offline,
  }));
  out(JSON.stringify({ ok: true, sources }, null, 2));
  return 0;
}

/**
 * 逐源连通性自检。
 *
 * searchOne 返回的是状态对象（含 sample），不是结果数组——这一点与直觉不同，
 * 所以这里直接用它的状态，不要自己再包一层 try/catch。
 *
 * @param {string} home
 * @param {Record<string, any>} options
 * @param {string[]} positional
 */
async function commandCheck(home, options, positional) {
  const query = positional.join(' ').trim() || 'ubuntu';
  const { createContext } = await import(pathToFileURL(path.join(home, 'src', 'index.mjs')).href);
  const { searchOne } = await import(pathToFileURL(path.join(home, 'src', 'aggregate.mjs')).href);
  const { resolveSources } = await import(pathToFileURL(path.join(home, 'src', 'sources', 'index.mjs')).href);

  const timeoutMs = intOption(options, 'timeout-ms', 15_000);
  const { sources, unknown } = resolveSources(options.sources ?? 'default');
  const ctx = await createContext({ proxy: options.proxy ?? 'auto', timeoutMs });

  const statuses = await Promise.all(
    sources.map((source) => searchOne(source, query, { ...ctx, limit: 5, timeoutMs })),
  );

  const report = statuses.map((status) => ({
    id: status.id,
    ok: status.ok,
    count: status.count,
    tookMs: status.tookMs,
    error: status.error ?? null,
    sample: status.sample?.[0]?.title ?? null,
  }));
  for (const id of unknown) report.push({ id, ok: false, count: 0, tookMs: 0, error: '未知数据源', sample: null });

  const okCount = report.filter((item) => item.ok).length;
  out(JSON.stringify({ ok: okCount > 0, query, okCount, total: report.length, sources: report }, null, 2));
  return okCount > 0 ? 0 : 1;
}

/**
 * 复用 CLI 的 doctor（不捕获输出，避免管道问题）。
 *
 * @param {string} home
 */
function commandDoctor(home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(home, 'bin', 'magnet-search.mjs'), 'doctor'], {
      stdio: 'inherit',
      cwd: home,
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (error) => {
      process.stderr.write(`doctor 启动失败：${error.message}\n`);
      resolve(1);
    });
  });
}

/**
 * 下载：磁力链接 / info hash / 关键词（--pick）。
 *
 * 直接使用项目的下载管理器（不 spawn CLI），进度打到 stderr，
 * 最终把结果以 JSON 打到 stdout，方便调用方解析。
 *
 * @param {string} home
 * @param {Record<string, any>} options
 * @param {string[]} positional
 */
async function commandDownload(home, options, positional) {
  const target = positional.join(' ').trim();
  if (!target) throw new Error('download 需要目标：磁力链接、info hash，或配合 --pick 的关键词');

  const { DownloadManager, defaultDownloadDir } = await import(
    pathToFileURL(path.join(home, 'src', 'download', 'manager.mjs')).href
  );

  let input = target;
  let pickName = null;

  // --pick：先搜索，取第 N 条结果的磁力
  if (options.pick !== undefined) {
    const index = Math.max(1, intOption(options, 'pick', 1));
    const { createContext, searchAll } = await import(pathToFileURL(path.join(home, 'src', 'index.mjs')).href);
    const ctx = await createContext({ proxy: options.proxy ?? 'auto' });
    const response = await searchAll({
      query: target,
      sources: options.sources ?? 'default',
      sort: options.sort ?? 'seeders',
      order: 'desc',
      pageSize: Math.max(index, 10),
      minSeeders: intOption(options, 'min-seeders', 0),
      safe: options.safe === true,
      exclude: options.exclude ?? '',
      ...ctx,
    });
    const chosen = response.results[index - 1];
    if (!chosen) throw new Error(`搜索「${target}」没有第 ${index} 条结果（共 ${response.total} 条）`);
    input = chosen.magnet;
    pickName = chosen.title;
    process.stderr.write(`已选第 ${index} 条：${chosen.title}（做种 ${chosen.seeders ?? '?'}，${chosen.sizeText ?? '体积未知'}）\n`);
  }

  const dir = options.dir ? path.resolve(String(options.dir)) : defaultDownloadDir();
  const maxBytes = options['max-size'] ? Math.round(Number(options['max-size']) * 1024 * 1024) : 0;
  const timeoutSeconds = intOption(options, 'timeout-seconds', 1800);

  const manager = new DownloadManager({
    dir,
    maxConcurrent: 1,
    maxBytes,
    limitSpeed: 0,
    backend: options.backend ?? process.env.TORRENT_SEARCH_BACKEND ?? 'auto',
    qbit: process.env.TORRENT_SEARCH_QBITTORRENT ?? null,
    useDefaultTrackers: options['no-extra-trackers'] !== true,
    useDht: options['no-dht'] !== true,
    persistFile: null, // 一次性任务：不写任务文件，避免污染服务端的任务列表
    logger: (message) => {
      if (options.verbose === true) process.stderr.write(`[debug] ${message}\n`);
    },
  });

  const task = manager.add({ input, dir, backend: options.backend ?? undefined });
  process.stderr.write(`任务 ${task.id} 已创建（后端 ${task.backend}），保存到 ${dir}\n`);

  // 周期性把进度打到 stderr：作为后台任务运行时，日志里能看出它活着
  let lastLine = '';
  const progressTimer = setInterval(() => {
    const current = manager.get(task.id);
    if (!current) return;
    const percent = Math.round((current.progress || 0) * 100);
    const line = `${current.status} ${percent}% ${Math.round((current.speed || 0) / 1024)}KiB/s peers=${current.peersConnected}`;
    if (line !== lastLine) {
      lastLine = line;
      process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
    }
  }, 3000);
  progressTimer.unref?.();

  const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
  let timedOut = false;
  const guard = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        manager.cancel(task.id);
      }, timeoutMs)
    : null;
  guard?.unref?.();

  try {
    await manager.waitForIdle();
  } finally {
    clearInterval(progressTimer);
    if (guard) clearTimeout(guard);
  }

  const final = manager.get(task.id);
  const ok = final?.status === 'done';
  out(
    JSON.stringify(
      {
        ok,
        status: final?.status ?? 'unknown',
        name: pickName ?? final?.name ?? null,
        dir,
        backend: final?.backend ?? null,
        bytesDone: final?.bytesDone ?? 0,
        totalBytes: final?.totalBytes ?? 0,
        files: (final?.files ?? []).map((file) => ({ path: file.path, length: file.length })),
        error: timedOut ? `超过 ${timeoutSeconds} 秒未完成，已取消（可用 --timeout-seconds 0 取消限制）` : (final?.error ?? null),
      },
      null,
      2,
    ),
  );
  return ok ? 0 : 1;
}

/**
 * 查看服务端任务列表（需要 serve 在跑）。
 *
 * @param {Record<string, any>} options
 */
async function commandTasks(options) {
  const port = intOption(options, 'port', Number(process.env.TORRENT_SEARCH_PORT) || 8787);
  const url = `http://127.0.0.1:${port}/api/downloads`;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  } catch {
    throw new Error(
      `连不上本地服务 ${url}。查看任务列表需要先启动服务：在项目目录运行 node bin/magnet-search.mjs serve（建议作为后台任务）。`,
    );
  }

  const data = await response.json();
  out(
    JSON.stringify(
      {
        ok: true,
        dir: data.dir,
        backend: data.backend,
        qbit: data.qbit,
        tasks: (data.tasks ?? []).map((task) => ({
          id: task.id,
          name: task.name,
          status: task.status,
          progress: Math.round((task.progress || 0) * 100) / 100,
          bytesDone: task.bytesDone,
          totalBytes: task.totalBytes,
          speed: task.speed,
          peersConnected: task.peersConnected,
          backend: task.backend,
          error: task.error,
        })),
      },
      null,
      2,
    ),
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

const USAGE = `种子搜索 skill 包装脚本

用法：
  torrent-search.mjs search <关键词> [选项]     聚合搜索，输出紧凑 JSON
  torrent-search.mjs sources                    列出数据源
  torrent-search.mjs check [关键词]             逐源连通性自检
  torrent-search.mjs doctor                     P2P 下载环境诊断（下载失败先跑这个）
  torrent-search.mjs download <目标> [选项]     下载磁力 / info hash / 关键词
  torrent-search.mjs tasks [--port 8787]        查看服务端任务列表（需要 serve 在跑）

通用选项：
  --home <路径>       指定项目根目录（默认自动探测，或读 TORRENT_SEARCH_HOME）
  --proxy <地址|auto> HTTP 代理，默认 auto（自动探测系统代理）
  --verbose           打印调试日志到 stderr

search 选项：
  --limit <N>         返回条数，默认 10（上限 100）
  --sources <列表>    数据源，如 apibay,nyaa；default=默认源，all=全部
  --sort <方式>       relevance(默认) / seeders / leechers / size / date
  --order <方向>      desc(默认) / asc
  --min-seeders <N>   只保留做种数 ≥ N 的结果
  --exclude <词>      排除关键词，逗号分隔，如 cam,TS
  --safe              安全过滤（排除站点标注的成人分类）
  --no-cache          跳过服务端 60 秒缓存
  --timeout-ms <N>    单源超时，默认 8000
  --text              输出人类可读表格而不是 JSON
  --magnet-only       只输出磁力链接，每行一条

download 选项：
  --pick <N>          先用关键词搜索，取第 N 条结果下载（1 开始）
  --dir <目录>        保存目录，默认 ~/Downloads/torrent-search
  --max-size <MiB>    大小上限，达到即停
  --backend <名称>    auto(默认) / builtin / qbittorrent
  --no-extra-trackers 只信磁力自带的 tracker
  --no-dht            不做 DHT 回退
  --timeout-seconds <N>  超时保护，默认 1800（0 = 不限）

调试：
  --dump-options      只打印参数解析结果（排查标志是否被正确识别）
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { options, positional } = parseArgs(argv.slice(1));

  if (!command || command === 'help' || options.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  // 调试用：把解析结果原样打出来，便于确认标志有没有被正确识别
  if (options['dump-options'] === true) {
    out(JSON.stringify({ command, options, positional }, null, 2));
    return 0;
  }

  const home = resolveToolHome(options.home);

  switch (command) {
    case 'search':
      return await commandSearch(home, options, positional);
    case 'sources':
      return await commandSources(home);
    case 'check':
      return await commandCheck(home, options, positional);
    case 'doctor':
      return await commandDoctor(home);
    case 'download':
      return await commandDownload(home, options, positional);
    case 'tasks':
      return await commandTasks(options);
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
