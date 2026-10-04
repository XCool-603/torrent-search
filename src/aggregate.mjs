/**
 * 聚合搜索：并发扇出 → 容错收集 → 跨站去重 → 评分排序 → 分页。
 *
 * 设计取舍：
 * - 单源失败绝不影响整体（Promise.allSettled + 每源独立超时），并把失败原因如实返回给调用方，
 *   因为"某个源挂了"本身就是用户需要知道的信息。
 * - 去重优先用 info hash：同一个种子在 TPB 和 BitSearch 上标题可能不同，但 hash 相同。
 * - 排序默认用相关度（标题命中 + 做种数 + 新鲜度），而不是单纯做种数，
 *   否则搜"进击的巨人"会被高做种数的无关资源挤掉。
 */

import { dedupeKey, normalizeTitle, tokenize } from './models.mjs';
import { getSource, resolveSources } from './sources/index.mjs';

export const SORT_MODES = ['relevance', 'seeders', 'leechers', 'size', 'date'];

/** 排序方向 */
export const SORT_ORDERS = ['desc', 'asc'];

/**
 * 执行聚合搜索。
 *
 * @param {{
 *   query: string,
 *   sources?: string|string[]|null,
 *   sort?: string,
 *   order?: 'desc'|'asc',             // 排序方向，默认 desc
 *   page?: number,
 *   pageSize?: number,
 *   timeoutMs?: number,
 *   limitPerSource?: number,
 *   minSeeders?: number|string,       // 只保留 seeders >= minSeeders（null 做种数会被过滤）
 *   exclude?: string|string[],        // 标题命中任一关键词即排除
 *   safe?: boolean,                   // 排除成人分类
 *   cacheTtlMs?: number,              // 结果缓存时长，0 = 关闭（默认关闭，服务端开启 60s）
 *   bypassCache?: boolean,            // 跳过读取缓存（但仍会写入）
 *   http: any,
 *   cache: any,
 *   logger?: (msg: string) => void,
 *   signal?: AbortSignal,
 * }} options
 */
export async function searchAll(options) {
  const query = String(options.query ?? '').trim();
  const sort = SORT_MODES.includes(options.sort) ? options.sort : 'relevance';
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Math.floor(options.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20) || 20));
  const timeoutMs = Math.min(60_000, Math.max(1_000, Math.floor(options.timeoutMs ?? 8_000) || 8_000));
  // 每源抓取条数。
  //
  // 关键：**不能取决于"每页显示多少条"**。早期下限是 50，于是每页 20 条时每源只抓 50，
  // 用户看到的总数（约 100）比每页 100 条时（约 190）少一大截——同一个关键词，
  // 只是改了显示条数，结果池就变了，看起来像"结果变少了"。
  // 现在下限提到 100（apibay / bitsearch 本来就一次返回最多 100 条，请求数不变），
  // 这样总数与分页设置无关；翻到更深页时再按需增加。
  const limitPerSource =
    options.limitPerSource ?? Math.min(300, Math.max(100, pageSize * page));
  const logger = options.logger ?? (() => {});

  const filters = normalizeFilters(options);
  const cacheTtlMs = Math.max(0, Math.floor(Number(options.cacheTtlMs) || 0));
  const bypassCache = options.bypassCache === true;

  const { sources, unknown } = selectSources(options.sources ?? 'default');
  const startedAt = Date.now();

  // 缓存键必须包含 limitPerSource 与 sort：
  // - 翻页时每源抓取条数会变，缓存内容不能混用；
  // - 有些站点（如 BitSearch）的排序参数会改变**返回的结果集合**而不只是顺序，
  //   漏掉 sort 会让不同排序的请求互相复用对方那批候选。
  const cacheKey = `${query}|${sources.map((source) => source.id).join(',')}|${limitPerSource}|${sort}`;

  let collected = null;
  let statuses = null;
  let fromCache = false;

  if (cacheTtlMs > 0 && !bypassCache) {
    const hit = readSearchCache(cacheKey, cacheTtlMs);
    if (hit) {
      collected = hit.results;
      statuses = hit.statuses.map((status) => ({ ...status, cached: true }));
      fromCache = true;
      logger(`命中搜索缓存：${query}（${hit.results.length} 条，${Math.round((Date.now() - hit.at) / 1000)} 秒前）`);
    }
  }

  if (!collected) {
    const fetched = await fetchAllSources({
      sources,
      query,
      sort,
      limitPerSource,
      timeoutMs,
      http: options.http,
      cache: options.cache,
      logger,
      signal: options.signal,
    });
    collected = fetched.collected;
    statuses = fetched.statuses;
    if (cacheTtlMs > 0) writeSearchCache(cacheKey, collected, statuses);
  }

  for (const id of unknown) {
    statuses.push({ id, name: id, ok: false, count: 0, tookMs: 0, error: '未知数据源', cached: false });
  }

  const merged = mergeResults(collected);
  const totalBeforeFilter = merged.length;
  const filtered = filterResults(merged, filters);

  const tokens = tokenize(query);
  const now = Date.now();
  for (const result of filtered) {
    result.sourceName = getSource(result.source)?.name ?? result.source;
    result.score = scoreResult(result, tokens, now);
  }

  const sorted = sortResults(filtered, sort, order);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;

  return {
    query,
    sort,
    order,
    tookMs: Date.now() - startedAt,
    page,
    pageSize,
    total,
    totalBeforeFilter,
    totalPages,
    filters,
    cached: fromCache,
    results: sorted.slice(start, start + pageSize),
    sources: statuses.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * 并发查询所有源，并把每个源的成败/耗时记录下来。
 *
 * @param {{sources: any[], query: string, sort: string, limitPerSource: number, timeoutMs: number, http: any, cache: any, logger: Function, signal?: AbortSignal}} params
 * @returns {Promise<{collected: any[], statuses: any[]}>}
 */
async function fetchAllSources(params) {
  const { sources, query, sort, limitPerSource, timeoutMs, http, cache, logger, signal: parentSignal } = params;
  const collected = [];
  const statuses = [];

  await withKeepAlive(async () => {
    await Promise.all(
      sources.map(async (source) => {
        const sourceStarted = Date.now();
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;

        try {
          const results = await source.search(query, {
            http,
            cache,
            limit: limitPerSource,
            timeoutMs,
            sort,
            signal,
            logger: (message) => logger(`[${source.id}] ${message}`),
          });

          const list = Array.isArray(results) ? results : [];
          collected.push(...list);
          statuses.push({
            id: source.id,
            name: source.name,
            ok: true,
            count: list.length,
            tookMs: Date.now() - sourceStarted,
            error: null,
            cached: false,
          });
          logger(`[${source.id}] ${list.length} 条 (${Date.now() - sourceStarted}ms)`);
        } catch (error) {
          const message = describeError(error, timeoutMs);
          statuses.push({
            id: source.id,
            name: source.name,
            ok: false,
            count: 0,
            tookMs: Date.now() - sourceStarted,
            error: message,
            cached: false,
          });
          logger(`[${source.id}] 失败：${message}`);
        }
      }),
    );
  });

  return { collected, statuses };
}

/**
 * 选择要查询的源。
 *
 * 除了 id 字符串/数组，还允许直接传入「源对象数组」（带 search 方法），
 * 这样测试可以注入假源，而不必去改全局注册表。
 *
 * @param {string|string[]|any[]|null|undefined} selector
 * @returns {{sources: any[], unknown: string[]}}
 */
export function selectSources(selector) {
  if (Array.isArray(selector) && selector.length > 0 && typeof selector[0]?.search === 'function') {
    return { sources: selector, unknown: [] };
  }
  return resolveSources(selector);
}

/**
 * 归一化过滤条件。
 *
 * @param {{minSeeders?: number|string, exclude?: string|string[], safe?: boolean}} [options]
 * @returns {{minSeeders: number, exclude: string[], safe: boolean}}
 */
export function normalizeFilters(options = {}) {
  const rawMinSeeders = Number(options.minSeeders);
  const minSeeders = Number.isFinite(rawMinSeeders) && rawMinSeeders > 0 ? Math.floor(rawMinSeeders) : 0;

  const exclude = (Array.isArray(options.exclude) ? options.exclude : String(options.exclude ?? '').split(','))
    .map((item) => String(item).trim())
    .filter(Boolean);

  return { minSeeders, exclude, safe: options.safe === true };
}

/**
 * 把「排除关键词」编译成匹配函数。
 *
 * 细节：中文按子串匹配；纯 ASCII 关键词按「词首边界」匹配，
 * 这样 `ts` 不会误伤 `shorts`，而 `cam` 仍能命中 `camrip`。
 *
 * @param {string[]} exclude
 * @returns {Array<(normalizedTitle: string) => boolean>}
 */
export function compileExcludeMatchers(exclude) {
  return exclude.map((keyword) => {
    const normalized = normalizeTitle(keyword);
    if (normalized === '') return () => false;

    if (/^[a-z0-9]+$/.test(normalized)) {
      const pattern = new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      return (title) => pattern.test(title);
    }
    return (title) => title.includes(normalized);
  });
}

/**
 * 结果过滤：安全过滤 → 最少做种数 → 排除关键词。
 *
 * @param {Array<import('./models.mjs').TorrentResult>} results
 * @param {{minSeeders?: number, exclude?: string[], safe?: boolean}} [filters]
 * @returns {Array<import('./models.mjs').TorrentResult>}
 */
export function filterResults(results, filters = {}) {
  const { minSeeders = 0, exclude = [], safe = false } = filters;
  if (!safe && minSeeders <= 0 && exclude.length === 0) return results;

  const matchers = compileExcludeMatchers(exclude);

  return results.filter((result) => {
    if (safe && result.adult === true) return false;

    if (minSeeders > 0) {
      // 做种数未知（null）时不能假定它有做种，直接过滤掉
      if (result.seeders === null || result.seeders === undefined || result.seeders < minSeeders) return false;
    }

    if (matchers.length > 0) {
      const normalized = normalizeTitle(result.title);
      for (const matches of matchers) if (matches(normalized)) return false;
    }

    return true;
  });
}

/** 搜索结果缓存（进程内，仅服务端使用；CLI 是一次性进程，开启没有意义） */
const SEARCH_CACHE_MAX_ENTRIES = 64;
const searchCache = new Map();

/**
 * 读取缓存（同时做 LRU 提权）。
 *
 * @param {string} key
 * @param {number} ttlMs
 * @returns {{at: number, results: any[], statuses: any[]}|null}
 */
function readSearchCache(key, ttlMs) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) {
    searchCache.delete(key);
    return null;
  }
  searchCache.delete(key);
  searchCache.set(key, entry);
  return entry;
}

/**
 * 写入缓存（超出上限时淘汰最久未使用的条目）。
 *
 * @param {string} key
 * @param {any[]} results
 * @param {any[]} statuses
 */
function writeSearchCache(key, results, statuses) {
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { at: Date.now(), results, statuses });
}

/**
 * 清空搜索结果缓存（测试与调试用）。
 */
export function clearSearchCache() {
  searchCache.clear();
}

/**
 * 当前缓存条目数（测试与调试用）。
 *
 * @returns {number}
 */
export function searchCacheSize() {
  return searchCache.size;
}

/**
 * 只查询单个源（`check` 自检命令用）。
 *
 * @param {any} source
 * @param {string} query
 * @param {{http: any, cache: any, limit?: number, timeoutMs?: number, sort?: string, signal?: AbortSignal}} ctx
 */
export async function searchOne(source, query, ctx) {
  const startedAt = Date.now();
  const timeoutMs = ctx.timeoutMs ?? 8_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

  try {
    const results = await withKeepAlive(() =>
      source.search(query, {
        http: ctx.http,
        cache: ctx.cache,
        limit: ctx.limit ?? 20,
        timeoutMs,
        sort: ctx.sort,
        signal,
        logger: () => {},
      }),
    );
    const list = Array.isArray(results) ? results : [];
    return { id: source.id, name: source.name, ok: true, count: list.length, tookMs: Date.now() - startedAt, error: null, sample: list.slice(0, 3) };
  } catch (error) {
    return { id: source.id, name: source.name, ok: false, count: 0, tookMs: Date.now() - startedAt, error: describeError(error, timeoutMs), sample: [] };
  }
}

/**
 * 在等待期间保持事件循环存活。
 *
 * 为什么需要：Node 的 AbortSignal.timeout() 计时器和 undici 空闲连接池里的 socket 都是 unref 的。
 * 某些时序下（例如连续多次搜索、复用了空闲 keep-alive 连接）事件循环可能瞬间没有任何 ref 的 handle，
 * 进程会以 exit code 0「正常退出」，把正在等待的搜索悄悄吞掉——对一次性 CLI 进程来说这是致命的静默失败。
 * 这里显式挂一个 ref 的定时器兜底，代价可以忽略。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withKeepAlive(fn) {
  const timer = setInterval(() => {}, 1000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * 跨源合并去重。
 *
 * @param {import('./models.mjs').TorrentResult[]} results
 * @returns {Array<import('./models.mjs').TorrentResult & {sources: string[]}>}
 */
export function mergeResults(results) {
  const map = new Map();

  for (const result of results) {
    if (!result || !result.title) continue;
    const key = dedupeKey(result);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { ...result, sources: [result.source] });
      continue;
    }

    if (!existing.sources.includes(result.source)) existing.sources.push(result.source);

    // 同一 info hash 的多个来源：取最"有用"的字段
    existing.seeders = maxNullable(existing.seeders, result.seeders);
    existing.leechers = maxNullable(existing.leechers, result.leechers);
    if (!existing.infoHash && result.infoHash) existing.infoHash = result.infoHash;
    if (!existing.magnet && result.magnet) existing.magnet = result.magnet;
    if (existing.size === null && result.size !== null) {
      existing.size = result.size;
      existing.sizeText = result.sizeText;
    }
    if (!existing.publishedAt && result.publishedAt) existing.publishedAt = result.publishedAt;
    if (!existing.detailsUrl && result.detailsUrl) existing.detailsUrl = result.detailsUrl;
    if (!existing.torrentUrl && result.torrentUrl) existing.torrentUrl = result.torrentUrl;
    if (!existing.category && result.category) existing.category = result.category;
    // 标题取更长的那个（通常信息更全，例如带上了字幕组/分辨率）
    if ((result.title?.length ?? 0) > (existing.title?.length ?? 0)) existing.title = result.title;
  }

  return [...map.values()];
}

/**
 * 相关度评分（0~100）。
 *
 * @param {import('./models.mjs').TorrentResult} result
 * @param {string[]} tokens
 * @param {number} now
 * @returns {number}
 */
export function scoreResult(result, tokens, now = Date.now()) {
  const normTitle = normalizeTitle(result.title);

  let relevance = 0.5;
  if (tokens.length > 0) {
    let hits = 0;
    for (const token of tokens) if (normTitle.includes(token)) hits += 1;
    relevance = hits / tokens.length;
    if (relevance === 1) relevance = Math.min(1, relevance + 0.15); // 全词命中加成
  }

  const popularity = Math.min(1, Math.log10((result.seeders ?? 0) + 1) / 3); // 1000 做种 ≈ 1

  let freshness = 0.4;
  if (result.publishedAt) {
    const ageDays = (now - Date.parse(result.publishedAt)) / 86_400_000;
    freshness = Math.max(0, Math.min(1, 1 - ageDays / 365));
  }

  const multiSourceBonus = (result.sources?.length ?? 1) > 1 ? 0.05 : 0;
  const score = 0.55 * relevance + 0.3 * popularity + 0.15 * freshness + multiSourceBonus;

  return Math.round(score * 10_000) / 100;
}

/**
 * 排序。
 *
 * @param {Array<import('./models.mjs').TorrentResult>} results
 * @param {string} sort  SORT_MODES 之一
 * @param {'desc'|'asc'} [order] 默认 desc（做种/大小/时间都是「越大越新越靠前」更符合直觉）
 */
export function sortResults(results, sort, order = 'desc') {
  const list = [...results];

  const comparators = {
    seeders: (a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || (b.score ?? 0) - (a.score ?? 0),
    leechers: (a, b) => (b.leechers ?? -1) - (a.leechers ?? -1) || (b.seeders ?? -1) - (a.seeders ?? -1),
    size: (a, b) => (b.size ?? -1) - (a.size ?? -1),
    // 时间缺失的结果按「最旧」处理，保证顺序确定（NaN 参与比较会让排序结果不可预测）
    date: (a, b) => timeOf(b) - timeOf(a),
    relevance: (a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.seeders ?? -1) - (a.seeders ?? -1),
  };

  const compare = comparators[sort] ?? comparators.relevance;
  list.sort(order === 'asc' ? (a, b) => -compare(a, b) : compare);

  return list;
}

/**
 * 取发布时间的时间戳，缺失或非法按 0（最旧）处理。
 *
 * @param {import('./models.mjs').TorrentResult} result
 * @returns {number}
 */
function timeOf(result) {
  if (!result.publishedAt) return 0;
  const parsed = Date.parse(result.publishedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maxNullable(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

/**
 * 把异常转成给用户看的一句话。
 *
 * @param {any} error
 * @param {number} timeoutMs
 * @returns {string}
 */
export function describeError(error, timeoutMs) {
  if (!error) return '未知错误';
  const code = error.code ?? '';
  if (code === 'timeout') return `超时 (${timeoutMs}ms)`;
  if (code === 'too_large') return '响应过大，已放弃';
  if (code === 'parse') return `响应解析失败：${error.message}`;
  if (code === 'bad_proxy') return error.message;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return `超时 (${timeoutMs}ms)`;
  return error.message || String(error);
}
