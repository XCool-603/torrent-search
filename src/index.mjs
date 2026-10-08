/**
 * 库入口：把「聚合搜索」当成一个 Node 模块用。
 *
 * 用法示例：
 *   import { createContext, searchAll } from './src/index.mjs';
 *   const ctx = createContext({});
 *   const { results } = await searchAll({ query: 'ubuntu', ...ctx });
 */

import { createHttpClient, detectSystemProxy } from './http.mjs';
import { DiskCache } from './cache.mjs';
import { searchAll } from './aggregate.mjs';

// 版本号统一从 package.json 读（见 src/version.mjs）
export { VERSION } from './version.mjs';

export {
  searchAll,
  searchOne,
  mergeResults,
  sortResults,
  scoreResult,
  filterResults,
  normalizeFilters,
  compileExcludeMatchers,
  selectSources,
  clearSearchCache,
  searchCacheSize,
  describeError,
  SORT_MODES,
  SORT_ORDERS,
} from './aggregate.mjs';
export { createHttpClient, detectSystemProxy, normalizeProxy, HttpError } from './http.mjs';
export { DiskCache, defaultCacheDir } from './cache.mjs';
export { DownloadManager, defaultDownloadDir, TASK_STATUS, BACKENDS, BACKEND_CHOICES } from './download/manager.mjs';
export { QbitClient, parseQbitConfig, mapQbitState, mapQbitTorrent, findQbittorrentExe, qbitTaskId } from './download/qbit.mjs';
export { detectTunAdapter, classifyPeerError, summarizePeerFailures, buildPeerFailureHint, buildNoPeersHint } from './netdiag.mjs';
export {
  detectContainer,
  envString,
  envInt,
  envBool,
  resolveHostDefault,
  resolvePortDefault,
  resolveQbitDefault,
  resolveBackendDefault,
  resolveDownloadDirOverride,
} from './env.mjs';
export { SpeedLimiter, parseSpeedLimit } from './bt/limiter.mjs';
export { dhtGetPeers, generateNodeId, distance as dhtDistance } from './bt/dht.mjs';
export { download as downloadTorrent, fetchMetadataOnly, generatePeerId, normalizeTrackers as normalizeTrackerList } from './bt/engine.mjs';
export { parseInfoDict, pieceSize, splitIntoBlocks } from './bt/torrent.mjs';
export { encode as bencodeEncode, decode as bencodeDecode, decodeAll as bencodeDecodeAll, infoHashOf } from './bt/bencode.mjs';
export { SOURCES, SOURCE_MAP, listSources, getSource, resolveSources } from './sources/index.mjs';
export {
  TPB_CATEGORIES,
  BITSEARCH_CATEGORIES,
  parseTpbCategory,
  parseBitsearchCategory,
  isAdultCategory,
  categoryTables,
} from './categories.mjs';
export { makeResult, dedupeKey, normalizeTitle, tokenize } from './models.mjs';
export {
  buildMagnet,
  parseMagnet,
  extractMagnet,
  normalizeInfoHash,
  base32ToHex,
  isInfoHash,
  withTrackers,
} from './magnet.mjs';
export { parseSizeText, formatBytes, formatRelativeTime, parseTimestamp, toCount } from './size.mjs';
export { parseXml, decodeEntities, localName, textOf, children, child, attr } from './xml.mjs';
export { parseRss, itemTag } from './rss.mjs';
export { createApiServer, startServer } from './server.mjs';

/**
 * 组装搜索上下文：HTTP 客户端 + 磁盘缓存 + 日志函数。
 *
 * @param {{
 *   proxy?: string|boolean|null,   // 'auto' 或 true = 自动探测系统代理
 *   timeoutMs?: number,
 *   cacheDir?: string,
 *   verbose?: boolean,
 *   logger?: (msg: string) => void,
 *   maxBytes?: number,
 *   retries?: number,
 * }} [options]
 * @returns {Promise<{http: any, cache: any, logger: (msg: string) => void, proxy: string|null}>}
 */
export async function createContext(options = {}) {
  const logger = options.logger ?? (options.verbose ? (msg) => console.error(`[debug] ${msg}`) : () => {});

  let proxy = options.proxy ?? null;
  if (proxy === true || proxy === 'auto') {
    proxy = await detectSystemProxy({ includeSystem: true });
    if (proxy) logger(`自动探测到系统代理：${proxy}`);
    else logger('未探测到系统代理，使用直连');
  }

  const http = createHttpClient({
    proxy,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes,
    retries: options.retries,
    logger,
  });

  return {
    http,
    cache: new DiskCache({ dir: options.cacheDir }),
    logger,
    proxy: proxy ? String(proxy) : null,
  };
}

/**
 * 一步完成搜索（给外部调用者的便捷函数）。
 *
 * @param {string} query
 * @param {Parameters<typeof searchAll>[0] & Parameters<typeof createContext>[0]} [options]
 */
export async function search(query, options = {}) {
  const ctx = await createContext(options);
  return searchAll({ ...options, ...ctx, query });
}
