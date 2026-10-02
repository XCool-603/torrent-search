/**
 * 分类体系映射。
 *
 * 各站的分类编号含义完全不同，且**必须**由站点自己的定义决定，不能猜：
 * - The Pirate Bay / apibay：1xx 音频、2xx 视频、3xx 软件、4xx 游戏、5xx 成人、6xx/7xx 其他
 * - BitSearch：1 其他、2 电影、3 剧集、4 动漫、5 软件、6 游戏、7 音乐、8 有声书、9 电子书/课程、10 XXX
 *   （该映射来自 bitsearch.to 搜索页自己的分类下拉框，见 tools/ 的调研记录）
 *
 * 除了给用户看的名称，还要标记「是否成人分类」——这是 `--safe` 安全过滤的唯一依据。
 * 刻意只依赖站点自己的分类标注，不去猜标题关键词，避免误杀正常资源。
 */

export const TPB_CATEGORIES = {
  1: '音频',
  2: '视频',
  3: '软件',
  4: '游戏',
  5: '成人',
  6: '其他',
  7: '其他',
};

export const BITSEARCH_CATEGORIES = {
  1: '其他',
  2: '电影',
  3: '剧集',
  4: '动漫',
  5: '软件',
  6: '游戏',
  7: '音乐',
  8: '有声书',
  9: '电子书/课程',
  10: '成人',
};

/** TPB 里 5xx 全部是成人分类 */
const TPB_ADULT_PREFIX = '5';
/** BitSearch 里 10 是成人分类 */
const BITSEARCH_ADULT_ID = 10;

/**
 * 解析 apibay/TPB 的分类。
 *
 * @param {string|number|null|undefined} raw 例如 "303"
 * @returns {{name: string|null, adult: boolean}}
 */
export function parseTpbCategory(raw) {
  if (raw === null || raw === undefined || raw === '') return { name: null, adult: false };

  const text = String(raw).trim();
  if (text === '') return { name: null, adult: false };

  const top = text[0];
  return {
    name: TPB_CATEGORIES[top] ?? text,
    adult: top === TPB_ADULT_PREFIX,
  };
}

/**
 * 解析 BitSearch 的分类。
 *
 * @param {string|number|null|undefined} raw 例如 10 或 "10"
 * @returns {{name: string|null, adult: boolean}}
 */
export function parseBitsearchCategory(raw) {
  if (raw === null || raw === undefined || raw === '') return { name: null, adult: false };

  const text = String(raw).trim();
  const id = Number(text);
  if (!Number.isFinite(id)) return { name: text, adult: false };

  return {
    name: BITSEARCH_CATEGORIES[id] ?? text,
    adult: id === BITSEARCH_ADULT_ID,
  };
}

/**
 * 判断某条结果是否属于成人分类（安全过滤用）。
 *
 * @param {string} sourceId
 * @param {string|number|null|undefined} rawCategory
 * @returns {boolean}
 */
export function isAdultCategory(sourceId, rawCategory) {
  switch (sourceId) {
    case 'apibay':
      return parseTpbCategory(rawCategory).adult;
    case 'bitsearch':
      return parseBitsearchCategory(rawCategory).adult;
    default:
      // 其它站点（nyaa / mikan / dmhy / academic）本身不是成人站
      return false;
  }
}

/**
 * 供 CLI `sources` 命令与文档展示的分类表。
 *
 * @returns {Array<{source: string, mapping: Record<string, string>}>}
 */
export function categoryTables() {
  return [
    { source: 'apibay', mapping: TPB_CATEGORIES },
    { source: 'bitsearch', mapping: BITSEARCH_CATEGORIES },
  ];
}
