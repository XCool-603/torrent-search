/**
 * 聚合搜索：并发扇出 → 容错收集 → 跨站去重 → 评分排序 → 分页。
 *
 * 设计取舍：
 * - 单源失败绝不影响整体（Promise.allSettled + 每源独立超时），并把失败原因如实返回给调用方，
 *   因为"某个源挂了"本身就是用户需要知道的信息。
 * - 去重优先用 info hash：同一个种子在 TPB 和 BitSearch 上标题可能不同，但 hash 相同。
 * - 排序默认用相关度（标题命中 + 做种数 + 新鲜度），而不是单纯做种数，
 *   否则搜"进击的巨人"会被高做种数的无关资源挤掉。
 * - 上游站点要求关键词之间有分隔且拼写敏感（`ubuntu2404` 连写直接 0 条），
 *   所以结果太少时会自动放宽查询再试（见 relaxQueryVariants），
 *   并在响应里用 relaxedFrom / relaxedTo 如实说明"这次不是按你原话搜的"。
 */

import { dedupeKey, normalizeTitle, tokenize } from './models.mjs';
import { getSource, resolveSources } from './sources/index.mjs';

export const SORT_MODES = ['relevance', 'seeders', 'leechers', 'size', 'date'];

/** 排序方向 */
export const SORT_ORDERS = ['desc', 'asc'];

/**
 * 自动放宽的触发阈值：过滤后条数低于它，才值得再花几次请求去试别的写法。
 *
 * 为什么不设成 0：搜索 0 条固然要放宽，但"只有 2 条"往往同样是关键词没被站点接受，
 * 而不是这个资源真的只有 2 个；反过来阈值也不能太高，否则常见关键词会白白多打请求。
 */
export const RELAX_THRESHOLD = 5;

/** 放宽最多重试几次：每次重试都要把所有源再扇出一次，必须封顶。 */
const MAX_RELAX_ATTEMPTS = 3;

/** 变体总数上限（真正会试的只有前 3 个，这里留余量给调试与测试）。 */
const MAX_RELAX_VARIANTS = 8;

/**
 * 中文虚词，按"改动从轻到重"分成两组。
 *
 * 先只去掉语法虚词（的/了/之），这类词几乎不承载语义，去掉最安全；
 * 「版/篇/集/季/第/全」会改变语义（"最终季" → "最终"），只能作为更靠后的兜底。
 */
const CJK_PARTICLES_SOFT = ['的', '了', '之'];
const CJK_PARTICLES_EDITION = ['版', '篇', '集', '季', '第', '全'];

/** 英文停用词：站点对这类词很敏感，带着它们经常直接 0 条。 */
const EN_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'on', 'in', 'for', 'and', 'with']);

/**
 * 全角字符转半角。
 *
 * 为什么单独做：中文输入法下打出来的 `ｕｂｕｎｔｕ２４０４` 在上游站点里就是另一串字符，
 * 而用户完全看不出区别——这是"明明有资源却搜不到"的典型原因之一。
 *
 * @param {string} text
 * @returns {string}
 */
function toHalfWidth(text) {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += char;
  }
  return out;
}

/**
 * 关键词归一化：全角→半角、英文小写、标点与空格收敛。
 *
 * 取舍：逗号/分号/冒号/顿号这类"真分隔符"变成空格；连字符、点号、下划线**保留**——
 * `cache-off`、`24.04`、`s01e05` 都是有意义的整体，拆开反而会搜出更多无关结果。
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeQuery(text) {
  let out = toHalfWidth(String(text ?? '')).toLowerCase();
  out = out.replace(/[,;，、；：:]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  // 首尾标点：`【进击的巨人】`、`ubuntu!!!` 这类包裹/拖尾的符号对站点没有意义
  out = out.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  // 中间连续重复的标点压成一个（`a!!!b` → `a!b`），再收一次空格
  out = out.replace(/([^\p{L}\p{N}\s])\1+/gu, '$1');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 去掉中文虚词。
 *
 * @param {string} text
 * @param {string[]} particles
 * @returns {string}
 */
function stripCjkParticles(text, particles) {
  let out = text;
  for (const particle of particles) out = out.split(particle).join('');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 去掉英文停用词。
 *
 * 只有一个词时原样返回：`a` 去掉就什么都不剩了，那不是"放宽"而是"清空"。
 *
 * @param {string} text
 * @returns {string}
 */
function stripEnglishStopwords(text) {
  const words = text.split(' ').filter(Boolean);
  if (words.length < 2) return text;
  const kept = words.filter((word) => !EN_STOPWORDS.has(word));
  return kept.length === 0 ? '' : kept.join(' ');
}

/**
 * 在「字母串紧跟数字串」的边界插空格：`ubuntu2404` → `ubuntu 2404`。
 *
 * 只处理 ASCII 字母后接数字这一个方向：反方向会把 `1080p` 拆成 `1080 p`，
 * 而 `1080p` 恰恰是站点上最常见的写法，拆了只会更搜不到。
 *
 * @param {string} text
 * @returns {string}
 */
function splitLettersAndDigits(text) {
  return text.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

/**
 * 把「字母串后紧跟的 4 位 / 6 位数字」拆成带点的版本号：`ubuntu2404` → `ubuntu 24.04`。
 *
 * 为什么值得单独一类：站点是短语匹配的，实测 bitsearch 对 `ubuntu 2404` 返回 0 条、
 * 对 `ubuntu 24.04` 返回 5 条——带点才是资源标题里的真实写法，而用户几乎不会自己打点。
 *
 * 刻意不处理的边界：
 * - 数字串在开头或后面紧跟字母：`1080p` 是分辨率，拆成 `10.80p` 只会更搜不到；
 * - 位数不是 4 / 6：`s01e05`、`x264` 这类拆开没有意义，年份 `2003` 也不该变成 `20.03`。
 *
 * @param {string} text
 * @returns {string}
 */
function dottedVersionNumbers(text) {
  return text
    .replace(/([A-Za-z])(\d{6})(?![A-Za-z0-9])/g, (_, letter, digits) => `${letter} ${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`)
    .replace(/([A-Za-z])(\d{4})(?![A-Za-z0-9])/g, (_, letter, digits) => `${letter} ${digits.slice(0, 2)}.${digits.slice(2)}`);
}

/**
 * 只保留前 N 个词。
 *
 * @param {string} text
 * @param {number} count
 * @returns {string}
 */
function truncateWords(text, count) {
  const words = text.split(' ').filter(Boolean);
  return words.length <= count ? text : words.slice(0, count).join(' ');
}

/**
 * 生成"放宽后的查询变体"，按「改动最小、最可能命中」排序。
 *
 * 顺序：标点/空格/全角归一 → 中文去虚词、英文去停用词 → 4/6 位数字拆成带点的版本号
 * → 字母数字之间插空格 → 长查询截断。
 *
 * 返回的数组**不含原查询本身**（含大小写等价的写法），这样调用方可以放心逐个重试，
 * 不必自己再去重；纯函数，不读全局状态，便于测试。
 *
 * @param {string} query 用户原始查询
 * @returns {string[]} 去重后的放宽变体（可能为空数组 = 没有可放宽的余地）
 */
export function relaxQueryVariants(query) {
  const original = String(query ?? '').trim();
  if (original === '') return [];

  const base = normalizeQuery(original);
  if (base === '') return [];

  // 大小写等价不算放宽：站点本来就不区分大小写，重试只会白打一轮请求。
  // 但全角→半角、去包裹标点算——那些在站点眼里是不同的字符串。
  const seen = new Set([original.toLowerCase()]);
  const variants = [];

  /**
   * @param {string} candidate
   */
  const push = (candidate) => {
    if (variants.length >= MAX_RELAX_VARIANTS) return;
    const text = String(candidate ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') return;
    const key = normalizeQuery(text);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    variants.push(text);
  };

  // ① 标点/空格/全角归一
  push(base);

  // ② 去虚词与停用词
  const soft = stripCjkParticles(base, CJK_PARTICLES_SOFT);
  const hard = stripCjkParticles(base, [...CJK_PARTICLES_SOFT, ...CJK_PARTICLES_EDITION]);
  const noStop = stripEnglishStopwords(base);
  push(soft);
  push(hard);
  push(noStop);

  // ③ 字母串后的 4/6 位数字拆成带点的版本号（ubuntu2404 → ubuntu 24.04）。
  //    必须排在「字母数字间插空格」**之前**：站点是短语匹配，带点的写法命中率明显更高，
  //    排在后面就会被 `ubuntu 2404` 先占掉重试名额（那样等于没修）。
  const dotted = [];
  for (const text of dotted) push(text);

  // ④ 字母串与数字串之间插空格（ubuntu2404 → ubuntu 2404）
  const spaced = [base, soft, hard, noStop].map((text) => splitLettersAndDigits(text));
  for (const text of spaced) push(text);

  // ⑤ 长查询截断。先去虚词/停用词的结果优先：
  //    「the lord of」这种前缀几乎没有搜索价值，而「lord rings 2003」才是用户真正想要的。
  for (const text of [noStop, hard, soft, base, ...spaced]) {
    push(truncateWords(text, 3));
    push(truncateWords(text, 2));
  }

  return variants;
}

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
 * @returns {Promise<{query: string, relaxedFrom: string|null, relaxedTo: string|null, sort: string, order: string,
 *   tookMs: number, page: number, pageSize: number, total: number, totalBeforeFilter: number, totalPages: number,
 *   filters: any, cached: boolean, results: any[], sources: any[]}>}
 *
 * 返回值的两个放宽标记：
 * - 没放宽：relaxedFrom / relaxedTo 都是 null；
 * - 放宽了：relaxedFrom = 用户原查询，relaxedTo = 实际生效的查询（query 始终是原查询）。
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
  const sourceIds = sources.map((source) => source.id).join(',');

  /**
   * 用某个关键词完整跑一轮（读缓存 → 扇出 → 写缓存 → 合并 → 过滤）。
   *
   * 抽成函数是为了让"放宽重试"走完全相同的路径：缓存键由**实际使用的关键词**拼出来，
   * 所以放宽查询的结果只会落在放宽后的键上，绝不会被当成原查询的缓存。
   *
   * @param {string} keyword 这一轮真正发给各数据源的关键词
   * @returns {Promise<{keyword: string, statuses: any[], fromCache: boolean, filtered: any[], total: number, totalBeforeFilter: number}>}
   */
  const runAttempt = async (keyword) => {
    // 缓存键必须包含 limitPerSource 与 sort：
    // - 翻页时每源抓取条数会变，缓存内容不能混用；
    // - 有些站点（如 BitSearch）的排序参数会改变**返回的结果集合**而不只是顺序，
    //   漏掉 sort 会让不同排序的请求互相复用对方那批候选。
    const cacheKey = `${keyword}|${sourceIds}|${limitPerSource}|${sort}`;

    let collected = null;
    let statuses = null;
    let fromCache = false;

    if (cacheTtlMs > 0 && !bypassCache) {
      const hit = readSearchCache(cacheKey, cacheTtlMs);
      if (hit) {
        collected = hit.results;
        statuses = hit.statuses.map((status) => ({ ...status, cached: true }));
        fromCache = true;
        logger(`命中搜索缓存：${keyword}（${hit.results.length} 条，${Math.round((Date.now() - hit.at) / 1000)} 秒前）`);
      }
    }

    if (!collected) {
      const fetched = await fetchAllSources({
        sources,
        query: keyword,
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

    const merged = mergeResults(collected);
    const filtered = filterResults(merged, filters);

    return { keyword, statuses, fromCache, filtered, total: filtered.length, totalBeforeFilter: merged.length };
  };

  let adopted = await runAttempt(query);
  let relaxedFrom = null;
  let relaxedTo = null;

  // 自动放宽：只在"结果明显不够"时才试别的写法。
  // 结果充足时一个多余的请求都不会发（阈值判断在扇出之前）。
  if (adopted.total < RELAX_THRESHOLD) {
    let attempts = 0;
    for (const variant of relaxQueryVariants(query)) {
      if (attempts >= MAX_RELAX_ATTEMPTS) break;
      attempts += 1;

      const attempt = await runAttempt(variant);
      logger(`放宽重试 ${attempts}/${MAX_RELAX_ATTEMPTS}：「${variant}」→ ${attempt.total} 条`);

      // 只有真的变多了才采用：放宽是为了"找到更多"，不是为了"换一个关键词"。
      // 采用后 sources 报的仍是这一轮各源的真实状态，不因为重试而改写含义。
      if (attempt.total > adopted.total) {
        adopted = attempt;
        relaxedFrom = query;
        relaxedTo = variant;
      }

      if (adopted.total >= RELAX_THRESHOLD) break;
    }
  }

  const statuses = adopted.statuses;
  for (const id of unknown) {
    statuses.push({ id, name: id, ok: false, count: 0, tookMs: 0, error: '未知数据源', cached: false });
  }

  // 相关度按"实际使用的关键词"算：放宽后如果还拿原查询去打分，
  // 所有结果都会因为命中不了 `ubuntu2404` 而被判成 0 相关，排序等于失效。
  const tokens = tokenize(adopted.keyword);
  const now = Date.now();
  for (const result of adopted.filtered) {
    result.sourceName = getSource(result.source)?.name ?? result.source;
    result.score = scoreResult(result, tokens, now);
  }

  const sorted = sortResults(adopted.filtered, sort, order);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;

  return {
    query,
    // 没放宽时两个字段都是 null（不省略，保持响应形状稳定）
    relaxedFrom,
    relaxedTo,
    sort,
    order,
    tookMs: Date.now() - startedAt,
    page,
    pageSize,
    total,
    totalBeforeFilter: adopted.totalBeforeFilter,
    totalPages,
    filters,
    cached: adopted.fromCache,
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
  // 必须存副本：调用方随后会往 statuses 里 push「未知数据源」，
  // 存同一个引用等于把这份追加也写进缓存，命中时就会重复出现同一条未知源。
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
