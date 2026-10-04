/**
 * 封面查找：把搜索结果标题解析成一张封面图。
 *
 * 为什么放在服务端，而不是让前端直连第三方：
 *   1. **隐私**：前端直连会把用户的搜索内容（标题、Referer）送给第三方；走服务端只发清洗后的片名，
 *      而且可以整体关掉（`serve --no-covers`）；
 *   2. **缓存**：第三方都有速率限制，同一片名在多次搜索里会反复出现，必须缓存；
 *   3. **不热链**：图片字节由我们代取，浏览器只访问同源地址（前端本身也不允许引用外部资源）。
 *
 * 数据源（都无需 API key、都只用 GET，因此能复用项目自带的 HTTP 客户端与代理设置）：
 *   - Kitsu          动漫（需要 `Accept: application/vnd.api+json`）
 *   - TVmaze         剧集
 *   - Wikipedia REST 通用兜底（电影 / 书 / 游戏 / 漫画；中文标题走 zh 站）
 *
 * 实测排除的源：Jikan 在部分网络下不可达；iTunes Search 在这里恒返回 0 条；
 * AniList 更好但要求 POST GraphQL，而本项目的 HTTP 客户端只发 GET。
 *
 * 命中不到就返回 null——软件发行版、学术数据集本来就没有封面，前端显示纯名称即可。
 */

import crypto from 'node:crypto';

/** 结果缓存有效期：封面基本不变，缓存久一点省掉重复请求。 */
const META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 未命中的缓存短一些：站点以后可能补上条目。 */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 标题清洗                                                            */
/* ------------------------------------------------------------------ */

/** 明确是"标签"而不是片名的方括号内容 */
const TAG_ONLY = /^(?:\d{1,4}(?:\.\d+)?|[a-z]{2,4}\d?|\d{3,4}p|[48]k|uhd|hdr|dv|x26[45]|h\.?26[45]|hevc|avc|av1|aac|ac3|eac3|dts(?:-hd)?|flac|opus|mp3|truehd|atmos|web-?dl|web-?rip|bd(?:rip|remux)?|bluray|hdtv|dvdrip|remux|repack|proper|v[23]|jp(?:tc|sc|bd)?|sc|tc|chs|cht|gb|big5|utf-?8|内嵌|外挂|简繁|繁简|中字|合集|无修|招募|发布组)$/i;

/** 常见发布标签（出现在自由文本里） */
const NOISE_PATTERNS = [
  /\b(?:2160p|1080p|720p|480p|4k|8k|uhd|fhd|hd|sd)\b/gi,
  /\b(?:x264|x265|h\.?264|h\.?265|hevc|avc|av1|10bit|8bit|hi10p)\b/gi,
  // 音频标签常带声道数（AAC2.0 / AC3 5.1 / DTS-HD），所以要允许尾随数字
  /\b(?:aac|ac3|eac3|dts(?:-hd)?|flac|opus|mp3|truehd|atmos)[\d.]*\b/gi,
  /\b(?:bluray|blu-ray|bdrip|bdremux|web-?dl|web-?rip|hdtv|dvdrip|remux|hdr|dolby\s?vision)\b/gi,
  /\b(?:repack|proper|internal|complete|batch|multi|dual[\s-]?audio|简繁|繁简|简日|繁日|内嵌|外挂|中字|合集)\b/gi,
  /\b(?:v2|v3|rev)\b/gi,
  /\b\d+(?:\.\d+)?\s?(?:kbps|khz|fps)\b/gi,
];

/** 文件名后缀与剧集编号 */
const EPISODE_PATTERNS = [
  /\.(?:mkv|mp4|avi|rmvb|mov|wmv|flv|ts|m2ts|iso|zip|rar|7z|torrent)$/i,
  /\bs\d{1,2}\s?e\d{1,3}\b/gi,
  /\b(?:e|ep|episode)\s?\d{1,4}\b/gi,
  /第\s?\d{1,4}\s?[集话話季]/g,
  /-\s?\d{1,4}(?:v\d)?\s*(?:end|完)?$/i,
  /\[\s?\d{1,4}(?:\.\d+)?\s?\]/g,
];

/**
 * 把种子标题清洗成适合查询的片名。
 *
 * 关键取舍：**方括号里既可能是发布组，也可能是片名本身**
 * （`[Nekomoe kissaten][Sousou no Frieren][01][1080p]` 的片名就在括号里）。
 * 所以策略是：先用括号外的自由文本；自由文本为空时，回头从括号里挑一个最像片名的。
 *
 * @param {string} raw
 * @returns {string} 清洗后的片名；无法得到有效片名时返回空串
 */
export function cleanTitle(raw) {
  const source = String(raw ?? '');

  // 收集方括号内容，并从自由文本里去掉它们
  const brackets = [];
  for (const match of source.matchAll(/\[([^\]]*)\]|【([^】]*)】/g)) {
    brackets.push(match[1] ?? match[2] ?? '');
  }
  let free = source.replace(/\[[^\]]*\]/g, ' ').replace(/【[^】]*】/g, ' ');

  // 圆括号内容：保留年份（片名的一部分），其余当作标签丢掉
  free = free.replace(/\((?![12]\d{3}\))[^)]*\)/g, ' ');

  const candidates = [];
  const cleanedFree = finalizeTitle(free);
  if (cleanedFree) candidates.push(cleanedFree);

  if (candidates.length === 0) {
    // 自由文本没东西可用（例如整条标题都在方括号里）：挑最像片名的一段
    const usable = brackets
      .map((text) => text.trim())
      .filter((text) => text !== '' && !TAG_ONLY.test(text))
      .map((text) => finalizeTitle(text))
      .filter((text) => text !== '');
    if (usable.length > 0) {
      // 取最长的一段：发布组名通常比片名短
      usable.sort((a, b) => b.length - a.length);
      candidates.push(usable[0]);
    }
  }

  const title = candidates[0] ?? '';
  return title.slice(0, 120);
}

/**
 * 季/篇标记：从这里截断，只保留主标题。
 *
 * 实测必要性：`进击的巨人 最终季 完结篇 后篇 Attack on Titan S04 Part3 2023`
 * 拿去查任何封面库都查不到；截成 `进击的巨人` 就命中了。
 */
const SEASON_MARKERS = [
  /(?:最终季|最終季|完结篇|完結編|剧场版|劇場版|总集篇|總集篇|特别篇|特別篇|第[一二三四五六七八九十\d]+季)/,
  /\s(?:season\s?\d+|s\d{1,2}(?:\s?e\d{1,3})?|part\s?\d+|the\s+final\s+season|movie\s?\d*)\b/i,
];

/**
 * 单段文本的收尾清洗（去噪、去剧集号、截断到主标题、去发布组后缀）。
 *
 * @param {string} text
 * @returns {string}
 */
function finalizeTitle(text) {
  let value = String(text);

  for (const pattern of EPISODE_PATTERNS) value = value.replace(pattern, ' ');
  for (const pattern of NOISE_PATTERNS) value = value.replace(pattern, ' ');

  // 文件名式的点分隔（The.Matrix.1999）→ 空格；但版本号里的点要保留（Ubuntu 24.04）。
  // 判据：两侧都是数字才当作版本号，其余的点都拆成空格。
  value = value.replace(/\.(?![0-9])|(?<![0-9])\./g, ' ');
  value = value.replace(/_+/g, ' ');

  // 多语言标题（`进击的巨人 / Shingeki no Kyojin / Attack on Titan`）取第一段
  const slash = value.split(/\s*[/／]\s*/).find((part) => part.trim() !== '');
  if (slash) value = slash;

  // 在季/篇标记处截断，只留主标题
  for (const marker of SEASON_MARKERS) {
    const match = marker.exec(value);
    if (match && match.index > 0) value = value.slice(0, match.index);
  }

  // 去掉行尾的发布组后缀（`The Matrix -FGT`）：仅在已经有两个以上词时才敢删
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3 && /^-[A-Za-z0-9]{2,8}$/.test(words[words.length - 1])) words.pop();
  value = words.join(' ');

  value = value.replace(/[\s\-–—~|/\\]+$/g, '').replace(/^[\s\-–—~|/\\]+/g, '');
  value = value.replace(/\s{2,}/g, ' ').trim();

  // 太短的基本是噪音。要求至少两个字母（CJK 也算字母）——纯数字（"12345"）不算片名
  if (value.replace(/[^\p{L}]/gu, '').length < 2) return '';
  return value;
}

/**
 * 判断第三方返回的片名是否真的匹配我们的查询。
 *
 * 为什么需要：模糊搜索会给出离谱结果——实测 `The Matrix 1999` 在 Kitsu 上匹配到了
 * 《The Animatrix》。**错封面比没有封面更糟**，所以宁可判不匹配。
 *
 * 判据：ASCII 词按词边界比对，CJK 按字符重合度；命中比例达到阈值才算匹配。
 *
 * @param {string} query 我们查询的片名
 * @param {string} matched 第三方返回的片名
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function titleMatches(query, matched, threshold = 0.6) {
  const normalizedQuery = normalizeForMatch(query);
  const normalizedMatched = normalizeForMatch(matched);
  if (normalizedQuery === '' || normalizedMatched === '') return false;
  if (normalizedQuery === normalizedMatched) return true;

  // ASCII 词：必须在对方里以整词出现（`matrix` 不该匹配 `animatrix`）。
  // 纯数字 token（年份、集数）不算身份特征，否则 `Interstellar 2014` 会因年份被误判为不匹配。
  const queryWords = normalizedQuery
    .split(' ')
    .filter((word) => /[a-z]/.test(word) && !/^\d+$/.test(word));
  const matchedWords = new Set(normalizedMatched.split(' '));
  const cjkChars = [...normalizedQuery].filter((char) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char));

  let hit = 0;
  let total = 0;
  for (const word of queryWords) {
    total += 1;
    if (matchedWords.has(word)) hit += 1;
  }
  for (const char of cjkChars) {
    total += 1;
    if (normalizedMatched.includes(char)) hit += 1;
  }

  if (total === 0) return false;
  return hit / total >= threshold;
}

/**
 * 归一化：小写、去掉标点、压缩空白。
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 数据源                                                              */
/* ------------------------------------------------------------------ */

/** 含 CJK 的标题优先查中文维基 */
function isCjk(text) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

const PROVIDERS = [
  {
    id: 'kitsu',
    label: 'Kitsu',
    /** Kitsu 没有公开的严格限额，取 2.5/s：既要快，也别把人家的接口打爆 */
    intervalMs: 400,
    /** 动漫：带集数标记（`- 01`、`[01]`、`第01集`、`E01`）、或片名本身是中日文 */
    matches: (title, raw) =>
      /第\s?\d{1,4}\s?[集话話]|-\s?\d{1,4}\b|\[\s?\d{1,4}(?:\.\d+)?\s?\]|\b(?:e|ep)\s?\d{1,3}\b/i.test(raw) ||
      isCjk(title),
    buildUrl: (title) => `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`,
    headers: { accept: 'application/vnd.api+json' },
    parse: parseKitsu,
  },
  {
    id: 'tvmaze',
    label: 'TVmaze',
    intervalMs: 600,
    /** 剧集：S01E02 / Season 之类的标记 */
    matches: (title, raw) => /\bs\d{1,2}\s?e\d{1,3}\b|\bseason\b|\bs\d{1,2}\b/i.test(raw),
    buildUrl: (title) => `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`,
    headers: { accept: 'application/json' },
    parse: parseTvmaze,
  },
  {
    id: 'wikipedia',
    label: 'Wikipedia',
    intervalMs: 300,
    /** 通用兜底：电影、书、游戏、漫画…… */
    matches: () => true,
    buildUrl: (title) => {
      const host = isCjk(title) ? 'zh.wikipedia.org' : 'en.wikipedia.org';
      return `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
    },
    headers: { accept: 'application/json', 'user-agent': 'torrent-search/1.0 (local search tool)' },
    parse: parseWikipedia,
  },
];

/**
 * Kitsu 响应 → 封面。
 *
 * @param {any} payload
 * @returns {{imageUrl: string, pageUrl: string|null, matchedTitle: string}|null}
 */
export function parseKitsu(payload) {
  const entry = Array.isArray(payload?.data) ? payload.data[0] : null;
  const attributes = entry?.attributes;
  if (!attributes) return null;

  const imageUrl =
    attributes.posterImage?.medium ??
    attributes.posterImage?.large ??
    attributes.posterImage?.small ??
    attributes.coverImage?.large ??
    null;
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('https://')) return null;

  return {
    imageUrl,
    pageUrl: typeof attributes.slug === 'string' ? `https://kitsu.io/anime/${attributes.slug}` : null,
    matchedTitle: attributes.canonicalTitle ?? attributes.titles?.en ?? '',
  };
}

/**
 * TVmaze 响应 → 封面。
 *
 * @param {any} payload
 * @returns {{imageUrl: string, pageUrl: string|null, matchedTitle: string}|null}
 */
export function parseTvmaze(payload) {
  const entry = Array.isArray(payload) ? payload[0]?.show : null;
  if (!entry) return null;

  const imageUrl = entry.image?.medium ?? entry.image?.original ?? null;
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('https://')) return null;

  return {
    imageUrl,
    pageUrl: typeof entry.url === 'string' ? entry.url : null,
    matchedTitle: typeof entry.name === 'string' ? entry.name : '',
  };
}

/**
 * Wikipedia REST summary → 封面。
 *
 * @param {any} payload
 * @returns {{imageUrl: string, pageUrl: string|null, matchedTitle: string}|null}
 */
export function parseWikipedia(payload) {
  if (!payload || payload.type === 'disambiguation') return null;
  const source = payload.thumbnail?.source;
  if (typeof source !== 'string' || !source.startsWith('https://')) return null;

  // 去掉维基加的跟踪参数
  const imageUrl = source.split('?')[0];
  const pageUrl =
    typeof payload.content_urls?.desktop?.page === 'string' ? payload.content_urls.desktop.page : null;
  return { imageUrl, pageUrl, matchedTitle: typeof payload.title === 'string' ? payload.title : '' };
}

/* ------------------------------------------------------------------ */
/* 速率限制                                                            */
/* ------------------------------------------------------------------ */

/**
 * 串行 + 最小间隔的限流器（每个数据源一个，避免触发对方的速率限制）。
 *
 * @param {number} intervalMs
 */
export function createLimiter(intervalMs) {
  let chain = Promise.resolve();
  let lastAt = 0;

  return (task) => {
    const run = chain.then(async () => {
      const wait = lastAt + intervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastAt = Date.now();
      return await task();
    });
    // 失败也要让后续任务继续排队，所以链上挂一个吞掉异常的分支
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 片名 → 缓存键。
 *
 * @param {string} title
 * @returns {string}
 */
export function coverKey(title) {
  return crypto.createHash('sha1').update(String(title)).digest('hex').slice(0, 20);
}

/**
 * 按标题特征排出要查的数据源（最可能的排前面）。
 *
 * 一次只查一个源、失败才降级，是为了不打爆第三方的速率限制：
 * 24 个标题若每个都查 3 个源就是 72 次请求。
 *
 * @param {string} title 清洗后的片名
 * @param {string} rawTitle 原始标题（判断集数标记更准）
 * @returns {any[]}
 */
export function providersFor(title, rawTitle) {
  const matched = PROVIDERS.filter((provider) => provider.matches(title, rawTitle));
  const rest = PROVIDERS.filter((provider) => !matched.includes(provider));
  return [...matched, ...rest];
}

/**
 * 建一个封面查找器。
 *
 * @param {{http: any, cache: any, logger?: (message: string) => void, enabled?: boolean, timeoutMs?: number}} options
 */
export function createCoverFinder(options) {
  const { http, cache } = options;
  const logger = options.logger ?? (() => {});
  const enabled = options.enabled !== false;
  const timeoutMs = options.timeoutMs ?? 8000;
  const limiters = new Map(PROVIDERS.map((provider) => [provider.id, createLimiter(provider.intervalMs)]));

  /**
   * 查一个标题的封面（带缓存）。
   *
   * @param {string} rawTitle
   * @returns {Promise<{key: string, provider: string|null, imageUrl: string|null, pageUrl: string|null, matchedTitle: string|null, title: string}|null>}
   */
  async function lookup(rawTitle) {
    if (!enabled) return null;

    const title = cleanTitle(rawTitle);
    if (title === '') return null;

    const key = coverKey(title);
    const cached = await readMeta(cache, key);
    if (cached !== null) {
      return cached.imageUrl ? { key, title, ...cached } : null;
    }

    let hit = null;
    for (const provider of providersFor(title, String(rawTitle))) {
      const candidate = await limiters
        .get(provider.id)
        .call(null, () => queryProvider(provider, title, http, timeoutMs, logger))
        .catch(() => null);

      if (!candidate) continue;

      // 模糊搜索会给出离谱结果，错封面比没封面更糟——不匹配就继续找下一个源
      if (!titleMatches(title, candidate.matchedTitle)) {
        logger(`${provider.id} 返回的片名不匹配（${candidate.matchedTitle}），跳过`);
        continue;
      }

      hit = candidate;
      break;
    }

    const meta = hit
      ? {
          provider: hit.provider,
          imageUrl: hit.imageUrl,
          pageUrl: hit.pageUrl,
          matchedTitle: hit.matchedTitle,
          imageType: null,
          at: Date.now(),
        }
      : { provider: null, imageUrl: null, pageUrl: null, matchedTitle: null, imageType: null, at: Date.now() };

    await writeMeta(cache, key, meta).catch(() => {});
    logger(`封面 ${hit ? `命中（${hit.provider}）：${title}` : `未命中：${title}`}`);
    return hit ? { key, title, ...meta } : null;
  }

  /**
   * 取封面图片字节（带缓存）。
   *
   * 只服务缓存里已存在的 key——否则这个接口就成了任意 URL 代理（SSRF）。
   *
   * @param {string} key
   * @returns {Promise<{body: Buffer, contentType: string}|null>}
   */
  async function image(key) {
    if (!enabled || !/^[0-9a-f]{20}$/.test(key)) return null;

    const meta = await readMeta(cache, key);
    if (meta === null || !meta.imageUrl) return null;

    const imageKey = `cover-img-${coverKey(meta.imageUrl)}`;
    const cachedImage = await cache.get(imageKey, { maxAgeMs: META_TTL_MS }).catch(() => null);
    if (cachedImage) {
      return { body: cachedImage.body, contentType: meta.imageType ?? guessType(meta.imageUrl) };
    }

    try {
      const response = await http.request(meta.imageUrl, {
        timeoutMs,
        maxBytes: 3 * 1024 * 1024,
        headers: { 'user-agent': 'torrent-search/1.0 (local search tool)' },
      });
      if (response.status !== 200) return null;
      const contentType =
        String(response.headers['content-type'] ?? '').split(';')[0].trim() || guessType(meta.imageUrl);
      await cache.set(imageKey, response.body).catch(() => {});
      await writeMeta(cache, key, { ...meta, imageType: contentType }).catch(() => {});
      return { body: response.body, contentType };
    } catch (error) {
      logger(`封面图片获取失败：${error?.message ?? error}`);
      return null;
    }
  }

  return { lookup, image, enabled };
}

/**
 * 查单个数据源。
 *
 * @param {any} provider
 * @param {string} title
 * @param {any} http
 * @param {number} timeoutMs
 * @param {(message: string) => void} logger
 */
async function queryProvider(provider, title, http, timeoutMs, logger) {
  try {
    const response = await http.request(provider.buildUrl(title), {
      timeoutMs,
      maxBytes: 1024 * 1024,
      headers: provider.headers,
    });
    if (response.status !== 200) return null;
    const parsed = provider.parse(JSON.parse(response.body.toString('utf8')));
    if (!parsed) return null;
    return { provider: provider.id, ...parsed };
  } catch (error) {
    logger(`${provider.id} 查询失败：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 读元数据缓存。
 *
 * @param {any} cache
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function readMeta(cache, key) {
  const hit = await cache.get(`cover-meta-${key}`, { maxAgeMs: META_TTL_MS }).catch(() => null);
  if (!hit) return null;
  try {
    const meta = JSON.parse(hit.body.toString('utf8'));
    // 未命中的记录用更短的有效期
    if (!meta.imageUrl && Date.now() - Number(meta.at ?? 0) > MISS_TTL_MS) return null;
    return meta;
  } catch {
    return null;
  }
}

/**
 * 写元数据缓存。
 *
 * @param {any} cache
 * @param {string} key
 * @param {any} meta
 */
async function writeMeta(cache, key, meta) {
  await cache.set(`cover-meta-${key}`, Buffer.from(JSON.stringify(meta), 'utf8'));
}

/**
 * 从 URL 猜图片类型（缓存里没记下 content-type 时用）。
 *
 * @param {string} url
 * @returns {string}
 */
function guessType(url) {
  if (/\.png(\?|$)/i.test(url)) return 'image/png';
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
  if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
  if (/\.svg(\?|$)/i.test(url)) return 'image/svg+xml';
  return 'image/jpeg';
}
