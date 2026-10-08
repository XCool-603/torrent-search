#!/usr/bin/env node
/**
 * 种子搜索 CLI。
 *
 *   magnet-search <关键词> [选项]      搜索
 *   magnet-search serve [选项]         启动本地 Web UI + JSON API
 *   magnet-search sources              列出数据源
 *   magnet-search check [关键词]       逐源连通性自检
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { formatBytes } from '../src/size.mjs';
import { DownloadManager, defaultDownloadDir } from '../src/download/manager.mjs';
import { parseSpeedLimit } from '../src/bt/limiter.mjs';
import { generatePeerId } from '../src/bt/engine.mjs';
import { QbitClient, parseQbitConfig, findQbittorrentExe } from '../src/download/qbit.mjs';
import { detectTunAdapter, isInFakeIpRange } from '../src/netdiag.mjs';
import {
  detectContainer,
  resolveBackendDefault,
  resolveHostDefault,
  resolvePortDefault,
  loadEnvFile,
  resolveQbitDefault,
} from '../src/env.mjs';
import {
  VERSION,
  SORT_MODES,
  SORT_ORDERS,
  createContext,
  listSources,
  resolveSources,
  searchAll,
  searchOne,
} from '../src/index.mjs';
import { startServer } from '../src/server.mjs';
import { createCoverFinder } from '../src/covers.mjs';
import { COLORS, createColorizer, renderResultsTable, renderSourceStatus } from '../src/format.mjs';
// 本地直接跑时也读 .env（Docker 走 compose 本来就会读）——否则同一个 .env
// 在容器里生效、在本地被静默忽略，改端口/下载目录时行为不一致。
// 已有的环境变量优先，所以命令行上临时覆盖仍然有效。
loadEnvFile();


const COMMANDS = new Set(['search', 'serve', 'sources', 'check', 'download', 'downloads', 'doctor', 'help']);

const FLAG_SPECS = {
  sources: { name: 'sources', type: 'string', short: 's', desc: '数据源，逗号分隔；default=默认源，all=全部' },
  sort: { name: 'sort', type: 'string', desc: `排序方式：${SORT_MODES.join(' | ')}（默认 relevance）` },
  order: { name: 'order', type: 'string', desc: '排序方向：desc（默认）| asc' },
  page: { name: 'page', type: 'string', desc: '页码，从 1 开始（默认 1）' },
  'page-size': { name: 'pageSize', type: 'string', short: 'n', desc: '每页条数（默认 20，最大 100）' },
  limit: { name: 'pageSize', type: 'string', desc: '同 --page-size' },
  json: { name: 'json', type: 'boolean', desc: '输出原始 JSON（便于脚本处理）' },
  magnet: { name: 'magnet', type: 'boolean', desc: '只输出磁力链接，每行一条' },
  'min-seeders': { name: 'minSeeders', type: 'string', desc: '只保留做种数 ≥ 该值的结果（做种数未知的会被过滤）' },
  exclude: { name: 'exclude', type: 'string', desc: '排除关键词，逗号分隔；如 --exclude cam,枪版,TS' },
  safe: { name: 'safe', type: 'boolean', desc: '安全过滤：排除站点标注为成人分类的结果' },
  timeout: { name: 'timeoutMs', type: 'string', desc: '单个数据源超时毫秒数（默认 8000）' },
  proxy: { name: 'proxy', type: 'string', desc: 'HTTP 代理，例如 127.0.0.1:7897；auto=自动探测系统代理' },
  demo: { name: 'demo', type: 'boolean', desc: '只使用离线演示数据源（不需要联网）' },
  'no-color': { name: 'noColor', type: 'boolean', desc: '关闭彩色输出' },
  verbose: { name: 'verbose', type: 'boolean', short: 'v', desc: '打印调试日志到 stderr' },
  port: { name: 'port', type: 'string', desc: 'serve 端口（默认 8787）' },
  host: { name: 'host', type: 'string', desc: 'serve 监听地址（默认 127.0.0.1）' },
  open: { name: 'open', type: 'boolean', desc: 'serve 启动后自动打开浏览器' },
  'max-downloads': { name: 'maxDownloads', type: 'string', desc: 'serve 同时下载的任务数（默认 2）' },
  'limit-speed': { name: 'limitSpeed', type: 'string', desc: 'serve 全局下载限速，如 2M / 500K（默认不限）' },
  pick: { name: 'pick', type: 'string', desc: 'download：先搜索并取第 N 条结果的磁力（配合关键词）' },
  dir: { name: 'dir', type: 'string', desc: 'download：保存目录（默认 ~/Downloads/torrent-search）' },
  'max-size': { name: 'max-size', type: 'string', desc: 'download：大小上限（MiB），达到即停，防误下' },
  'limit-speed': { name: 'limitSpeed', type: 'string', desc: 'download：限速，如 2M / 500K（默认不限）' },
  'no-extra-trackers': { name: 'noExtraTrackers', type: 'boolean', desc: 'download：不补充公共 tracker（只信磁力自带的）' },
  'no-dht': { name: 'noDht', type: 'boolean', desc: 'download：不用 DHT 回退（tracker 失败就直接放弃，更快）' },
  backend: { name: 'backend', type: 'string', desc: '下载后端：auto（默认，有 qBittorrent 就用它）| builtin | qbittorrent' },
  'qb-url': { name: 'qbUrl', type: 'string', desc: 'qBittorrent WebUI 地址，如 http://127.0.0.1:8080|admin|密码' },
  'no-resume': { name: 'noResume', type: 'boolean', desc: 'serve：启动时不自动续传未完成的任务' },
  'no-covers': { name: 'noCovers', type: 'boolean', desc: 'serve：关闭封面查询（不向 Jikan / iTunes 发送任何标题）' },
  help: { name: 'help', type: 'boolean', short: 'h', desc: '显示帮助' },
  version: { name: 'version', type: 'boolean', short: 'V', desc: '显示版本' },
};

const SHORT_FLAGS = new Map(
  Object.entries(FLAG_SPECS)
    .filter(([, spec]) => spec.short)
    .map(([long, spec]) => [spec.short, { long, spec }]),
);

class UsageError extends Error {}

const HELP = `种子搜索 v${VERSION} —— 聚合多个公开磁力/BT 源

用法
  magnet-search <关键词> [选项]        聚合搜索
  magnet-search serve [选项]           启动本地 Web UI + JSON API
  magnet-search sources                列出所有数据源
  magnet-search check [关键词]         逐源连通性自检
  magnet-search doctor                诊断 P2P 下载环境（代理/TUN/tracker/DHT/握手）
  magnet-search download <目标> [选项] 下载磁力链接
  magnet-search downloads              查看下载任务记录

下载示例
  magnet-search download "magnet:?xt=urn:btih:...&dn=..."
  magnet-search download 2c6b6858d61da9543d4231a71db4b1c9264b0685
  magnet-search download "ubuntu 24.04" --pick 1
  magnet-search download "magnet:?..." --max-size 500 --dir D:\\dl

常用示例
  magnet-search "ubuntu 24.04"
  magnet-search "进击的巨人" --sources mikan,dmhy -n 30
  magnet-search blender --sort seeders --json > out.json
  magnet-search "the last of us" --magnet | head -5
  magnet-search ubuntu --min-seeders 20 --exclude cam,枪版
  magnet-search ubuntu --safe
  magnet-search ubuntu --proxy auto
  magnet-search serve --port 8787 --open

选项
${Object.entries(FLAG_SPECS)
  .map(([long, spec]) => {
    const short = spec.short ? `-${spec.short}, ` : '    ';
    return `  ${short}--${long}${spec.type === 'string' ? ' <值>' : ''}`.padEnd(30) + spec.desc;
  })
  .join('\n')}

说明
  · 默认使用「默认启用」的在线源；某个源失败不影响其它源，失败原因会在结果下方列出。
  · 下载依赖磁力自带的 tracker 找 peer（不实现 DHT）；tracker 全挂时会明确报错。
  · 退出码：0=成功（含无结果），1=运行出错或全部数据源失败，2=参数错误。
`;

async function main(argv) {
  const { command, positionals, options } = parseArgs(argv);

  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const color = createColorizer(
    options.noColor !== true && process.stdout.isTTY === true && !process.env.NO_COLOR,
  );

  switch (command) {
    case 'search':
      return await runSearch(positionals.join(' ').trim(), options, color);
    case 'serve':
      return await runServe(positionals, options, color);
    case 'sources':
      return runSources(color);
    case 'check':
      return await runCheck(positionals.join(' ').trim() || 'ubuntu', options, color);
    case 'download':
      return await runDownload(positionals.join(' ').trim(), options, color);
    case 'downloads':
      return await runDownloadsList(options, color);
    case 'doctor':
      return await runDoctor(options, color);
    default:
      throw new UsageError(`未知命令：${command}`);
  }
}

async function runSearch(query, options, color) {
  if (query === '') {
    throw new UsageError('请提供搜索关键词，例如：magnet-search "ubuntu 24.04"');
  }
  if (options.json && options.magnet) {
    throw new UsageError('--json 与 --magnet 不能同时使用');
  }
  if (options.sort && !SORT_MODES.includes(options.sort)) {
    throw new UsageError(`--sort 只能是 ${SORT_MODES.join(' / ')}`);
  }
  const order = (options.order ?? 'desc').toLowerCase();
  if (!SORT_ORDERS.includes(order)) {
    throw new UsageError(`--order 只能是 ${SORT_ORDERS.join(' / ')}`);
  }

  const timeoutMs = toInt(options.timeoutMs, 8_000, '--timeout');
  const page = toInt(options.page, 1, '--page');
  const pageSize = toInt(options.pageSize, 20, '--page-size');

  const ctx = await createContext({
    proxy: options.proxy ?? null,
    timeoutMs,
    verbose: options.verbose === true,
  });

  const filters = {
    minSeeders: options.minSeeders ?? 0,
    exclude: options.exclude ?? '',
    safe: options.safe === true,
  };

  const result = await searchAll({
    query,
    sources: options.demo ? 'demo' : (options.sources ?? 'default'),
    sort: options.sort ?? 'relevance',
    order,
    page,
    pageSize,
    timeoutMs,
    ...filters,
    ...ctx,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return allSourcesFailed(result) ? 1 : 0;
  }

  if (options.magnet) {
    const magnets = result.results.map((item) => item.magnet).filter(Boolean);
    if (magnets.length > 0) process.stdout.write(`${magnets.join('\n')}\n`);
    return allSourcesFailed(result) ? 1 : 0;
  }

  const filterSummary = describeFilters(result.filters);
  const filteredAway = Math.max(0, (result.totalBeforeFilter ?? result.total) - result.total);

  const okCount = result.sources.filter((status) => status.ok).length;
  process.stdout.write(
    `${color(COLORS.bold)('搜索')} ${color(COLORS.cyan)(`「${query}」`)}` +
      `  ${color(COLORS.gray)('第')} ${result.page}/${result.totalPages} ${color(COLORS.gray)('页')}` +
      `  ${color(COLORS.gray)('共')} ${color(COLORS.bold)(String(result.total))} ${color(COLORS.gray)('条（去重后）')}` +
      (filteredAway > 0 ? `  ${color(COLORS.yellow)(`已过滤 ${filteredAway} 条`)}` : '') +
      `  ${color(COLORS.gray)(`用时 ${result.tookMs}ms`)}\n`,
  );
  if (filterSummary) {
    process.stdout.write(`${color(COLORS.gray)('过滤条件：')}${filterSummary}\n`);
  }
  process.stdout.write('\n');

  if (result.results.length === 0) {
    process.stdout.write(`${color(COLORS.yellow)('没有找到结果。')}\n`);
    if (okCount === 0) {
      process.stdout.write(`${color(COLORS.red)('所有数据源都失败了，请检查网络或使用 --proxy auto。')}\n`);
    } else if (filteredAway > 0) {
      process.stdout.write(`${color(COLORS.gray)('原始结果不为空，但被过滤条件筛掉了，可以放宽 --min-seeders / --exclude / --safe。')}\n`);
    } else {
      process.stdout.write(`${color(COLORS.gray)('可以试试减少关键词、换用其它数据源（--sources all），或调整排序。')}\n`);
    }
  } else {
    process.stdout.write(`${renderResultsTable(result.results, { color })}\n`);
  }

  process.stdout.write(`\n${color(COLORS.gray)('数据源：')}${renderSourceStatus(result.sources, { color })}\n`);

  if (result.results.length > 0 && !options.magnet) {
    process.stdout.write(
      `${color(COLORS.gray)(`提示：--json 输出原始数据，--magnet 只输出磁力链接，--page ${result.page + 1} 看下一页。`)}\n`,
    );
  }

  return allSourcesFailed(result) ? 1 : 0;
}

/**
 * 把生效的过滤条件渲染成一行说明（没有过滤时返回空字符串）。
 *
 * @param {{minSeeders: number, exclude: string[], safe: boolean}} filters
 * @returns {string}
 */
function describeFilters(filters) {
  if (!filters) return '';
  const parts = [];
  if (filters.minSeeders > 0) parts.push(`做种数 ≥ ${filters.minSeeders}`);
  if (filters.exclude.length > 0) parts.push(`排除「${filters.exclude.join('、')}」`);
  if (filters.safe) parts.push('安全过滤');
  return parts.join('，');
}

async function runServe(positionals, options, color) {
  if (positionals.length > 0) {
    throw new UsageError(`serve 不接受位置参数：${positionals.join(' ')}`);
  }

  const port = toInt(options.port, resolvePortDefault(), '--port');
  const host = options.host ?? resolveHostDefault();

  const ctx = await createContext({
    proxy: options.proxy ?? null,
    verbose: options.verbose === true,
  });

  // 下载任务管理器：整个服务进程共享一个，任务列表持久化到下载目录
  const downloadManager = new DownloadManager({
    dir: options.dir ?? defaultDownloadDir(),
    maxConcurrent: Number(options['max-downloads'] ?? 2) || 2,
    limitSpeed: parseSpeedLimit(options.limitSpeed) ?? 0,
    backend: resolveBackendChoice(options, color),
    qbit: resolveQbitConfig(options),
    // 这两个开关以前只对 download 命令生效，serve 下被静默忽略
    // （表现为：即使加了 --no-extra-trackers，仍会去等公共 tracker 超时）
    useDefaultTrackers: options.noExtraTrackers !== true,
    useDht: options.noDht !== true,
    persistFile: path.join(options.dir ?? defaultDownloadDir(), 'tasks.json'),
    logger: ctx.logger,
  });

  // 启动时自动续传未完成任务（默认开，--no-resume 关闭）
  const restored = await downloadManager.load({ autoResume: options.noResume !== true });

  const server = await startServer({
    port,
    host,
    http: ctx.http,
    cache: ctx.cache,
    coverFinder: createCoverFinder({
      http: ctx.http,
      cache: ctx.cache,
      enabled: options.noCovers !== true,
      logger: ctx.logger,
    }),
    version: VERSION,
    logger: ctx.logger,
    downloadManager,
  });

  process.stdout.write(
    `${color(COLORS.bold)('种子搜索服务已启动')}\n` +
      `  Web UI   ${color(COLORS.cyan)(`${server.url}/`)}\n` +
      (host === '0.0.0.0' || host === '::'
        ? `  ${color(COLORS.gray)('监听 0.0.0.0 —— 容器/局域网可通过宿主机 IP 访问（本机仍可用 127.0.0.1）')}\n`
        : '') +
      `  JSON API ${color(COLORS.cyan)(`${server.url}/api/search?q=ubuntu`)}\n` +
      `  下载目录 ${color(COLORS.cyan)(downloadManager.dir)}\n` +
      `  下载后端 ${downloadManager.backend === 'auto' ? '自动（有 qBittorrent 就用它）' : downloadManager.backend}\n` +
      (restored > 0 ? `  已恢复   ${restored} 个历史任务\n` : '') +
      `  代理     ${ctx.proxy ?? '直连'}\n` +
      `${color(COLORS.gray)('按 Ctrl+C 退出')}\n`,
  );

  if (options.open) {
    const opened = openInBrowser(`${server.url}/`);
    if (!opened) process.stdout.write(`${color(COLORS.yellow)('自动打开浏览器失败，请手动访问上面的地址。')}\n`);
  }

  const shutdown = async () => {
    process.stdout.write(`\n${color(COLORS.gray)('正在关闭服务…')}\n`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return await new Promise(() => {});
}

function runSources(color) {
  const sources = listSources();
  const rows = sources.map((source) => [
    source.id,
    source.name,
    source.defaultEnabled ? '是' : '否',
    source.kinds.join('/') || '-',
    source.description,
  ]);

  const widths = [12, 24, 4, 14, 60];
  const header = ['ID', '名称', '默认', '类型', '说明'];

  const lines = [
    color(COLORS.bold)(header.map((cell, i) => cell.padEnd(widths[i])).join('  ')),
    color(COLORS.gray)('─'.repeat(widths.reduce((a, b) => a + b + 2, 0))),
  ];

  for (const row of rows) {
    lines.push(
      row
        .map((cell, i) => {
          const text = String(cell);
          const clipped = text.length > widths[i] ? `${text.slice(0, widths[i] - 1)}…` : text;
          return clipped.padEnd(widths[i]);
        })
        .join('  ')
        .trimEnd(),
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  process.stdout.write(
    `\n${color(COLORS.gray)('用 --sources 指定数据源，例如：--sources apibay,nyaa；用 --sources all 全部启用。')}\n`,
  );
  return 0;
}

/**
 * `download <磁力|info hash|搜索关键词 --pick N>`：下载到本地。
 */
async function runDownload(input, options, color) {
  if (input === '') {
    throw new UsageError('请提供磁力链接、info hash，或用 `--pick N` 从搜索结果里选一条');
  }

  let target = input;

  // `download 关键词 --pick 2`：先搜索，再取第 N 条结果的磁力
  if (options.pick !== undefined) {
    const picked = await pickFromSearch(input, options, color);
    if (!picked.magnet) {
      throw new UsageError(`第 ${picked.index} 条结果没有磁力链接，无法下载`);
    }
    target = picked.magnet;
    process.stdout.write(`${color(COLORS.gray)('已选择：')}${picked.title}\n`);
  }

  const manager = new DownloadManager({
    dir: options.dir ?? defaultDownloadDir(),
    maxConcurrent: 1,
    maxBytes: options['max-size'] ? Math.round(Number(options['max-size']) * 1024 * 1024) : 0,
    limitSpeed: parseSpeedLimit(options.limitSpeed),
    useDefaultTrackers: options.noExtraTrackers !== true,
    useDht: options.noDht !== true,
    backend: resolveBackendChoice(options, color),
    qbit: resolveQbitConfig(options),
    persistFile: null, // CLI 一次性任务不持久化，避免下次启动时出现"中断"记录
    logger: (message) => {
      if (options.verbose === true) process.stderr.write(`[debug] ${message}\n`);
    },
  });

  let task;
  try {
    task = manager.add({
      input: target,
      dir: options.dir ?? defaultDownloadDir(),
      maxBytes: options['max-size'] ? Math.round(Number(options['max-size']) * 1024 * 1024) : 0,
    });
  } catch (error) {
    // 磁力/hash 解析失败属于用户输入问题，报成参数错误而不是堆栈
    throw new UsageError(error?.message ?? String(error));
  }

  const speedLimit = parseSpeedLimit(options.limitSpeed);

  process.stdout.write(
    `${color(COLORS.bold)('开始下载')}\n` +
      `  任务   ${color(COLORS.cyan)(task.id)}\n` +
      `  目标   ${task.name}\n` +
      `  后端   ${task.backend === 'auto' ? '自动选择' : task.backend}\n` +
      `  保存到 ${task.dir}\n` +
      (options['max-size'] ? `  上限   ${options['max-size']} MiB\n` : '') +
      (speedLimit ? `  限速   ${formatBytes(speedLimit)}/s\n` : '') +
      `${color(COLORS.gray)('提示：找 peer 顺序为 磁力 tracker → 公共 tracker → DHT；Ctrl+C 取消。')}\n\n`,
  );

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let lastLine = '';

  manager.on('progress', (snapshot) => {
    if (!process.stdout.isTTY) return;
    const percent = Math.round((snapshot.progress || 0) * 100);
    const speed = snapshot.speed ? `${formatBytes(snapshot.speed)}/s` : '-';
    const peers = `${snapshot.peersConnected}/${snapshot.peersAvailable}`;
    const line = `  ${spinnerFrames[frame++ % spinnerFrames.length]} ${snapshot.phase.padEnd(11)} ${String(percent).padStart(3)}%  ${formatBytes(snapshot.bytesDone)} / ${formatBytes(snapshot.totalBytes)}  ${speed.padEnd(12)} peer ${peers}`;
    process.stdout.write(`\r${' '.repeat(Math.max(0, lastLine.length - line.length))}\r`);
    process.stdout.write(line);
    lastLine = line;
  });

  await manager.waitForIdle();
  if (process.stdout.isTTY) process.stdout.write('\n');

  const final = manager.get(task.id);
  switch (final.status) {
    case 'done':
      process.stdout.write(
        `${color(COLORS.green)('✓ 下载完成')}  ${final.name}\n` +
          `  ${color(COLORS.gray)(final.files.map((file) => `${file.path} (${formatBytes(file.length)})`).join('\n  '))}\n` +
          `  ${color(COLORS.gray)('保存在：')}${final.dir}\n`,
      );
      return 0;
    case 'stopped':
      process.stdout.write(`${color(COLORS.yellow)(`○ 达到大小上限后停止（已下载 ${formatBytes(final.bytesDone)}）`)}\n`);
      return 0;
    case 'cancelled':
      process.stdout.write(`${color(COLORS.yellow)('已取消')}\n`);
      return 1;
    default:
      process.stdout.write(`${color(COLORS.red)(`✗ 下载失败：${final.error ?? final.status}`)}\n`);
      return 1;
  }
}

/**
 * 搜索并取第 N 条结果（1 开始）。
 *
 * @param {string} query
 * @param {Record<string, any>} options
 * @param {Function} color
 */
async function pickFromSearch(query, options, color) {
  const ctx = await createContext({ proxy: options.proxy ?? null, timeoutMs: 8_000, verbose: options.verbose === true });
  const result = await searchAll({
    query,
    sources: options.sources ?? 'default',
    sort: options.sort ?? 'relevance',
    pageSize: Math.max(Number(options.pick) || 1, 20),
    timeoutMs: 8_000,
    ...ctx,
  });

  const index = Number(options.pick);
  const picked = result.results[index - 1];
  if (!picked) {
    throw new UsageError(`搜索结果只有 ${result.total} 条，取不到第 ${index} 条`);
  }

  process.stdout.write(
    `${color(COLORS.gray)('搜索')} ${color(COLORS.cyan)(`「${query}」`)} 共 ${result.total} 条，取第 ${index} 条\n\n`,
  );
  return picked;
}

/**
 * `downloads`：列出任务记录。
 */
async function runDownloadsList(options, color) {
  const manager = new DownloadManager({
    dir: options.dir ?? defaultDownloadDir(),
    persistFile: path.join(defaultDownloadDir(), 'tasks.json'),
    logger: () => {},
  });
  await manager.load();

  const tasks = manager.list();
  if (tasks.length === 0) {
    process.stdout.write(`${color(COLORS.gray)('还没有下载任务记录。')}\n`);
    return 0;
  }

  const statusColor = { done: COLORS.green, failed: COLORS.red, cancelled: COLORS.yellow, interrupted: COLORS.yellow, stopped: COLORS.yellow, paused: COLORS.yellow };
  for (const task of tasks) {
    const mark = color(statusColor[task.status] ?? COLORS.gray)(`[${task.status}]`);
    const percent = Math.round((task.progress || 0) * 100);
    const backend = task.backend && task.backend !== 'builtin' ? ` ${task.backend}` : '';
    process.stdout.write(
      `  ${mark} ${task.name}${color(COLORS.gray)(backend)}\n` +
        `    ${color(COLORS.gray)(`${task.infoHash}  ${formatBytes(task.bytesDone)}/${formatBytes(task.totalBytes)} (${percent}%)  ${task.error ?? ''}`)}\n`,
    );
  }

  process.stdout.write(`\n${color(COLORS.gray)(`下载目录：${defaultDownloadDir()}`)}\n`);
  return 0;
}

/**
 * `doctor`：诊断本机的 P2P 下载环境。
 *
 * 逐项检查并给出结论：
 *   1. 代理 TUN 虚拟网卡（P2P 被拦截的头号原因）
 *   2. tracker 通告（HTTP(S)，可走代理）
 *   3. DHT 探测（UDP，无法走代理）
 *   4. 真实 peer 握手（用 Ubuntu 官方种子的 info hash，全程限时）
 *
 * 每一项都给出「通过/失败 + 对下载意味着什么」。
 */
async function runDoctor(options, color) {
  const results = [];
  const timeoutMs = toInt(options.timeout, 6000, '--timeout');
  const ctx = await createContext({ proxy: options.proxy ?? null, timeoutMs, verbose: options.verbose === true });

  process.stdout.write(`${color(COLORS.bold)('P2P 下载环境诊断')}\n\n`);

  // ① 代理 TUN 网卡
  const tun = detectTunAdapter();
  const inContainer = detectContainer();
  if (tun.detected) {
    process.stdout.write(`  ${color(COLORS.yellow)('⚠')} 代理 TUN 虚拟网卡  ${color(COLORS.gray)(tun.reason ?? tun.name)}\n`);
    results.push({ name: 'tun', ok: false });
  } else if (inContainer) {
    // 容器里看不到宿主机的网络设备：这里必须说清楚，否则会误报"没问题"
    process.stdout.write(
      `  ${color(COLORS.gray)('－')} 代理 TUN 虚拟网卡  ${color(COLORS.gray)('容器内无法检测宿主机的 TUN/代理，请在宿主机上排查')}\n`,
    );
    results.push({ name: 'tun', ok: true, unknown: true });
  } else {
    process.stdout.write(`  ${color(COLORS.green)('✓')} 未检测到代理 TUN 虚拟网卡\n`);
    results.push({ name: 'tun', ok: true });
  }

  // ①b qBittorrent 桥接可用性（受限网络下推荐用它）
  const qbitConfig = resolveQbitConfig(options);
  const qbitClient = new QbitClient(parseQbitConfig(qbitConfig));
  const qbitStatus = await qbitClient.ping();
  if (qbitStatus.ok) {
    process.stdout.write(
      `  ${color(COLORS.green)('✓')} qBittorrent 桥接   ${color(COLORS.gray)(`${qbitConfig.split('|')[0]}（版本 ${qbitStatus.version}）—— 可用 --backend qbittorrent`)}\n`,
    );
    results.push({ name: 'qbit', ok: true });
  } else {
    // 装了但 WebUI 没开：给出可执行的开启步骤（这是最常见的"桥接不可用"原因）
    const exePath = await findQbittorrentExe();
    if (exePath) {
      process.stdout.write(
        `  ${color(COLORS.yellow)('⚠')} qBittorrent 桥接   ${color(COLORS.gray)('已安装但 WebUI 不可用')}\n` +
          `      ${color(COLORS.gray)('开启方法：打开 qBittorrent → 工具 → 选项 → Web UI → 勾选「Web 用户界面」')}\n` +
          `      ${color(COLORS.gray)('并设置用户名/密码（端口默认 8080），然后重跑本命令')}\n`,
      );
      results.push({ name: 'qbit', ok: false, installed: true });
    } else {
      process.stdout.write(
        `  ${color(COLORS.gray)('－')} qBittorrent 桥接   ${color(COLORS.gray)('未安装（winget install qBittorrent.qBittorrent）')}\n`,
      );
      results.push({ name: 'qbit', ok: false, installed: false });
    }
  }

  // ② tracker 通告（用 Sintel 的 info hash：CC 授权的公开测试种，公共 tracker 对它有大量 peer）
  const infoHash = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const peerId = generatePeerId();

  let trackerPeers = [];
  try {
    const { announceAll } = await import('../src/bt/tracker.mjs');
    const { peers, results: trackerResults } = await announceAll({
      trackerUrls: ['udp://tracker.opentrackr.org:1337/announce', 'https://tracker.torrent.eu.org/announce'],
      infoHash,
      peerId,
      port: 6881,
      left: 16_384,
      event: 'started',
      timeoutMs,
      proxy: ctx.http.proxy,
    });
    trackerPeers = peers;
    if (peers.length > 0) {
      process.stdout.write(`  ${color(COLORS.green)('✓')} tracker 通告        ${color(COLORS.gray)(`拿到 ${peers.length} 个 peer（此步走 HTTP，可经代理）`)}\n`);
      results.push({ name: 'tracker', ok: true });
    } else {
      const firstError = trackerResults[0]?.error ?? '无响应';
      // 「tracker 返回了语义化错误」说明 HTTP 通路是好的，只是这个 tracker 拒绝了本次请求
      const rejected = /authorized|not authorized|invalid|未注册/i.test(firstError);
      const mark = rejected ? color(COLORS.yellow)('⚠') : color(COLORS.red)('✗');
      process.stdout.write(
        `  ${mark} tracker 通告        ${color(COLORS.gray)(rejected ? `HTTP 通路正常，tracker 拒绝了本次请求（${firstError}）——可换其它种子验证` : firstError)}\n`,
      );
      results.push({ name: 'tracker', ok: rejected ? true : false, rejected });
    }
  } catch (error) {
    process.stdout.write(`  ${color(COLORS.red)('✗')} tracker 通告        ${color(COLORS.gray)(error.message)}\n`);
    results.push({ name: 'tracker', ok: false });
  }

  // ③ DHT 探测（UDP）
  try {
    const { dhtGetPeers } = await import('../src/bt/dht.mjs');
    const dhtPeers = await dhtGetPeers(infoHash, {
      timeoutMs: Math.min(timeoutMs, 5000),
      maxRounds: 2,
      logger: () => {},
    });
    if (dhtPeers.length > 0) {
      process.stdout.write(`  ${color(COLORS.green)('✓')} DHT（UDP）          ${color(COLORS.gray)(`拿到 ${dhtPeers.length} 个 peer`)}\n`);
      results.push({ name: 'dht', ok: true });
    } else {
      process.stdout.write(`  ${color(COLORS.yellow)('⚠')} DHT（UDP）          ${color(COLORS.gray)('网络可达但没有查到 peer（UDP 可能被拦截）')}\n`);
      results.push({ name: 'dht', ok: false });
    }
  } catch (error) {
    process.stdout.write(`  ${color(COLORS.red)('✗')} DHT（UDP）          ${color(COLORS.gray)(error.message)}\n`);
    results.push({ name: 'dht', ok: false });
  }

  // ④ 真实 peer 握手（最关键的一步：上面都通也可能在这里被拦）
  if (trackerPeers.length > 0) {
    const { Peer } = await import('../src/bt/peer.mjs');
    let handshaked = 0;
    let closedAtHandshake = 0;
    let timeouts = 0;

    const probe = async (candidate) => {
      const peer = new Peer({ host: candidate.host, port: candidate.port, infoHash, peerId, connectTimeoutMs: 4000 });
      try {
        await peer.connect();
        handshaked += 1;
        peer.destroy();
      } catch (error) {
        if (/握手期间连接被关闭|ECONNRESET/i.test(error.message)) closedAtHandshake += 1;
        else if (/超时|ETIMEDOUT/i.test(error.message)) timeouts += 1;
        peer.destroy();
      }
    };

    await Promise.all(shuffle(trackerPeers).slice(0, 5).map(probe));

    if (handshaked > 0) {
      process.stdout.write(`  ${color(COLORS.green)('✓')} peer BT 握手        ${color(COLORS.gray)(`${handshaked}/${Math.min(trackerPeers.length, 5)} 个 peer 完成握手`)}\n`);
      results.push({ name: 'peer', ok: true });
    } else if (closedAtHandshake > 0 || timeouts > 0) {
      const detail = [
        closedAtHandshake > 0 ? `${closedAtHandshake} 个被对端关闭` : null,
        timeouts > 0 ? `${timeouts} 个无响应` : null,
      ].filter(Boolean).join('，');
      process.stdout.write(`  ${color(COLORS.red)('✗')} peer BT 握手        ${color(COLORS.gray)(`0 个成功（${detail}）`)}\n`);
      results.push({ name: 'peer', ok: false });
    }
  } else {
    process.stdout.write(`  ${color(COLORS.gray)('－')} peer BT 握手        ${color(COLORS.gray)('（tracker 未拿到 peer，跳过）')}\n`);
  }

  // 结论
  const peerCheck = results.find((result) => result.name === 'peer');
  const tunCheck = results.find((result) => result.name === 'tun');
  const dhtCheck = results.find((result) => result.name === 'dht');

  process.stdout.write(`\n${color(COLORS.bold)('结论')}\n`);

  if (peerCheck?.ok) {
    process.stdout.write(`  ${color(COLORS.green)('本机可以正常进行 BT 下载。')}\n`);
    return 0;
  }

  if (tunCheck && !tunCheck.ok && (peerCheck && !peerCheck.ok)) {
    process.stdout.write(
      `  ${color(COLORS.yellow)('P2P 流量正在被代理拦截（TUN 模式接管了全局路由）。')}\n` +
        `  ${color(COLORS.gray)('修复：在 Clash 中把模式从 TUN 切换为「系统代理」，或暂时关闭 TUN/系统代理后重试；')}\n` +
        `  ${color(COLORS.gray)('也可以在代理规则里把 BT 流量（TCP 高位端口与 UDP）设为 DIRECT。')}\n`,
    );
    return 1;
  }

  // 容器里看不到宿主机网卡：结论必须指向"去宿主机排查"，不能含糊过去
  if (tunCheck?.unknown && peerCheck && !peerCheck.ok) {
    process.stdout.write(
      `  ${color(COLORS.yellow)('BT 数据通道不通，但容器内无法判断宿主机的代理/TUN 情况。')}\n` +
        `  ${color(COLORS.gray)('请在宿主机上排查：Clash 等代理的 TUN 模式是否接管了全局路由（含 WSL/Docker 流量）；')}\n` +
        `  ${color(COLORS.gray)('必要时把 BT 流量设为 DIRECT，或让容器走 VPN 出口（见 docker-compose.yml 的注释示例）。')}\n`,
    );
    return 1;
  }

  if (dhtCheck && !dhtCheck.ok && (peerCheck && !peerCheck.ok)) {
    process.stdout.write(
      `  ${color(COLORS.yellow)('tracker 可达但 BT 数据通道不通（TCP/UDP 均被拦截或对端不可达）。')}\n` +
        `  ${color(COLORS.gray)('修复：检查本机防火墙对 node.exe 的出站限制；或换一个网络环境重试。')}\n`,
    );
    return 1;
  }

  process.stdout.write(`  ${color(COLORS.gray)('部分检查未通过，请结合上面各项的说明判断。')}\n`);
  return 1;
}

async function runCheck(keyword, options, color) {
  const { sources, unknown } = resolveSources(options.demo ? 'demo' : (options.sources ?? 'default'));
  const timeoutMs = toInt(options.timeoutMs, 15_000, '--timeout');

  const ctx = await createContext({
    proxy: options.proxy ?? null,
    timeoutMs,
    verbose: options.verbose === true,
  });

  process.stdout.write(`${color(COLORS.bold)(`连通性自检：关键词「${keyword}」`)}${color(COLORS.gray)(`  超时 ${timeoutMs}ms`)}\n\n`);

  const started = Date.now();
  const statuses = await Promise.all(
    sources.map((source) => searchOne(source, keyword, { ...ctx, limit: 5, timeoutMs })),
  );

  const idWidth = Math.max(8, ...statuses.map((s) => s.id.length));
  for (const status of statuses) {
    const mark = status.ok ? color(COLORS.green)('✓') : color(COLORS.red)('✗');
    const detail = status.ok
      ? `${status.count} 条  ${status.tookMs}ms  ${color(COLORS.gray)(status.sample[0]?.title?.slice(0, 48) ?? '')}`
      : color(COLORS.red)(status.error ?? '失败');
    process.stdout.write(`  ${mark} ${status.id.padEnd(idWidth)}  ${detail}\n`);
  }

  for (const id of unknown) {
    process.stdout.write(`  ${color(COLORS.red)('✗')} ${id.padEnd(idWidth)}  ${color(COLORS.red)('未知数据源')}\n`);
  }

  const okCount = statuses.filter((status) => status.ok).length;
  process.stdout.write(
    `\n${color(COLORS.gray)(`${okCount}/${statuses.length} 个源可用，总耗时 ${Date.now() - started}ms`)}\n`,
  );

  if (okCount === 0) {
    process.stdout.write(`${color(COLORS.red)('全部数据源不可用：请检查网络，或尝试 --proxy auto。')}\n`);
    return 1;
  }
  return 0;
}

function allSourcesFailed(result) {
  return result.sources.length > 0 && result.sources.every((status) => !status.ok);
}

/**
 * 解析下载后端选择（CLI 参数 → manager 接受的取值）。
 *
 * @param {Record<string, any>} options
 * @param {Function} color
 * @returns {'builtin'|'qbittorrent'|'auto'}
 */
function resolveBackendChoice(options, color) {
  const raw = String(options.backend ?? resolveBackendDefault()).trim().toLowerCase();
  if (['builtin', 'qbittorrent', 'auto'].includes(raw)) return raw;
  throw new UsageError(`--backend 只能是 auto / builtin / qbittorrent，收到：${options.backend}`);
}

/**
 * 解析 qBittorrent 连接配置：CLI 参数 > 环境变量 > 按环境取默认值。
 *
 * @param {Record<string, any>} options
 * @returns {string|null}
 */
function resolveQbitConfig(options) {
  const fromCli = options.qbUrl ?? options['qb-url'];
  if (fromCli) return String(fromCli);
  // resolveQbitDefault 内部已优先读 TORRENT_SEARCH_QBITTORRENT；
  // 容器里默认指向宿主机（host.docker.internal），本机默认 127.0.0.1
  return resolveQbitDefault();
}

/**
 * 用系统默认浏览器打开 URL。
 *
 * 刻意用 stdio: 'ignore' + detached：一是不阻塞当前进程，
 * 二是在受限环境下「捕获子进程输出」可能被拒绝，这里根本不需要捕获。
 *
 * @param {string} url
 * @returns {boolean} 是否成功发起
 */
function openInBrowser(url) {
  try {
    const [command, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 原地打乱（doctor 挑 peer 探测时用，避免每次都测同样几个）。
 *
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
function shuffle(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv
 * @returns {{command: string, positionals: string[], options: Record<string, any>}}
 */
function parseArgs(argv) {
  const options = {};
  const raw = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      raw.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const spec = FLAG_SPECS[key];
      if (!spec) throw new UsageError(`未知选项 --${key}`);

      if (spec.type === 'boolean') {
        options[spec.name] = inline === undefined ? true : inline !== 'false';
      } else {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`--${key} 需要一个值`);
        options[spec.name] = value;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1);
      const entry = SHORT_FLAGS.get(short);
      if (!entry) throw new UsageError(`未知选项 -${short}`);
      const { long, spec } = entry;

      if (spec.type === 'boolean') {
        options[spec.name] = true;
      } else {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`-${short} (--${long}) 需要一个值`);
        options[spec.name] = value;
      }
      continue;
    }

    raw.push(arg);
  }

  const first = raw[0];
  const command = first && COMMANDS.has(first) ? first : 'search';
  const positionals = command === 'search' && !(first && COMMANDS.has(first)) ? raw : raw.slice(1);

  return { command, positionals, options };
}

function toInt(value, fallback, flagName) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flagName} 需要一个正整数，收到：${value}`);
  return Math.floor(n);
}

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`参数错误：${error.message}\n用 --help 查看用法。\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`出错了：${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
