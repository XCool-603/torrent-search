/**
 * 种子搜索 —— 纯前端（原生 ES module，零依赖、零构建）
 *
 * 后端接口契约（同源，无鉴权）：
 *   GET /api/search?q=&sources=&sort=&order=&page=&pageSize=&timeoutMs=
 *                  &minSeeders=&exclude=&safe=1&noCache=1
 *   GET /api/sources
 *   GET /api/health
 *
 * sort ∈ relevance | seeders | leechers | size | date（均为后端全局排序）
 * order ∈ desc | asc
 *
 * 安全约定：所有来自接口的数据一律通过 textContent / setAttribute / 文本节点写入 DOM，
 * 本文件不使用任何 HTML 字符串拼接接口（无标记注入面，天然防 XSS）；
 * 关键词高亮同样通过分割文本节点 + 创建 <mark> 元素实现。
 */

const LS_PREFIX = 'torrent-search:';
const LS_KEYS = {
  sources: LS_PREFIX + 'sources',
  sort: LS_PREFIX + 'sort',
  order: LS_PREFIX + 'order',
  pageSize: LS_PREFIX + 'pageSize',
  filters: LS_PREFIX + 'filters',
  covers: LS_PREFIX + 'covers',
};

const SORT_VALUES = ['relevance', 'seeders', 'leechers', 'size', 'date'];
const ORDER_VALUES = ['desc', 'asc'];
const DL_STATUS_LABELS = {
  queued: '排队中',
  metadata: '获取元数据',
  downloading: '下载中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  stopped: '已达上限',
  interrupted: '中断',
  paused: '已暂停',
};
const DL_BACKEND_LABELS = { builtin: '内置引擎', qbittorrent: 'qBittorrent' };
const DL_ACTIVE_STATUSES = ['queued', 'metadata', 'downloading'];
const DL_FAILED_HINT = '请检查网络环境或换用成熟的 BT 客户端';
const DL_FLUSH_MS = 120; // progress 事件合流节流（后端已按 500ms 合流，这里再兜一层）
const DL_FLASH_MS = 1500;
const PAGE_SIZES = [20, 50, 100];
const EXAMPLE_KEYWORDS = ['ubuntu', '进击的巨人', 'Blender'];
const DEFAULT_PAGE_SIZE = 20;
const SKELETON_ROWS = 6;
const TOAST_MS = 1600;
const CLIENT_TIMEOUT_MS = 45000; // 客户端兜底超时，避免后端无响应时界面永久卡在加载态
const MAX_HIGHLIGHT_TERMS = 8;

/** 表头可排序列 → 后端 sort 参数（5 列全部由后端做全局排序）。 */
const SORT_COLUMNS = {
  title: { label: '标题', sort: 'relevance' },
  size: { label: '大小', sort: 'size' },
  seeders: { label: '做种', sort: 'seeders' },
  leechers: { label: '下载', sort: 'leechers' },
  date: { label: '时间', sort: 'date' },
};
const SORT_TO_COLUMN = { relevance: 'title', seeders: 'seeders', leechers: 'leechers', size: 'size', date: 'date' };
const DEFAULT_FILTERS = { minSeeders: 0, exclude: '', safe: false };

const state = {
  query: '',
  page: 1,
  sort: 'relevance',
  sortColumn: 'title',
  order: 'desc',
  pageSize: DEFAULT_PAGE_SIZE,
  filters: { ...DEFAULT_FILTERS },
  allSources: [],
  sourcesLoaded: false,
  selected: new Set(),
  loading: false,
  hasResults: false,
  lastResults: [],
  controller: null,
  seq: 0,
  // 封面：默认开启（关掉后不向任何第三方发送标题）
  coversEnabled: true,
  coverObserver: null,
  coverPending: new Set(),
  coverTimer: null,
  coverSeq: 0,
  downloads: {
    open: false,
    loaded: false, // 首次展开面板时才拉列表
    dir: '',
    enabled: null, // 来自 /api/health：null=未知
    tasks: new Map(),
    rows: new Map(),
    order: [],
    pending: new Map(),
    flushTimer: null,
    source: null,
  },
};

const dom = { sortButtons: {}, sortArrows: {}, sortHeaders: {} };

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function $(id) {
  return document.getElementById(id);
}

/** 创建元素：属性与文本都走安全 API。 */
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.attrs) {
    for (const key of Object.keys(options.attrs)) {
      const value = options.attrs[key];
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (options.dataset) {
    for (const key of Object.keys(options.dataset)) {
      const value = options.dataset[key];
      if (value === null || value === undefined) continue;
      node.dataset[key] = String(value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  if (node) node.replaceChildren();
}

function lsGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 容忍 null / 缺失 / 类型不符的字段。 */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function formatInt(value) {
  const n = asNumber(value);
  if (n === null) return '-';
  return n.toLocaleString('zh-CN');
}

function formatBytes(bytes) {
  const n = asNumber(bytes);
  if (n === null || n <= 0) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(digits) + ' ' + units[i];
}

function formatSize(item) {
  const text = asString(item && item.sizeText);
  if (text) return text;
  return formatBytes(item && item.size);
}

function formatRelative(iso) {
  const raw = asString(iso);
  if (!raw) return '-';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return '-';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + ' 天前';
  const months = Math.floor(days / 30);
  if (months < 12) return months + ' 个月前';
  return Math.floor(days / 365) + ' 年前';
}

function formatAbsolute(iso) {
  const raw = asString(iso);
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return raw;
  }
}

function seedClass(seeders) {
  const n = asNumber(seeders);
  if (n === null) return 'seed-none';
  if (n > 10) return 'seed-high';
  if (n >= 1) return 'seed-mid';
  return 'seed-zero';
}

function seedText(seeders) {
  const n = asNumber(seeders);
  return n === null ? '-' : formatInt(n);
}

/* ------------------------------------------------------------------ */
/* 关键词高亮（纯 DOM，文本节点分割）                                  */
/* ------------------------------------------------------------------ */

/** 把查询词拆成高亮词：空格 / 逗号 / 顿号分隔，去重并限量。 */
function keywordsOf(query) {
  const raw = asString(query);
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[\s,，、]+/)) {
    const term = part.trim();
    if (!term || term.length > 64) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_HIGHLIGHT_TERMS) break;
  }
  return out;
}

/** 计算所有命中区间并合并重叠。 */
function matchRanges(text, keywords) {
  const lower = text.toLowerCase();
  const ranges = [];
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      ranges.push([index, index + needle.length]);
      from = index + needle.length;
    }
  }
  if (!ranges.length) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i += 1) {
    const last = merged[merged.length - 1];
    const current = ranges[i];
    if (current[0] <= last[1]) last[1] = Math.max(last[1], current[1]);
    else merged.push(current);
  }
  return merged;
}

/** 把 text 写入容器，命中的部分包在 <mark> 里（只创建 mark 元素）。 */
function highlightInto(container, text, keywords) {
  const source = asString(text);
  const ranges = keywords.length ? matchRanges(source, keywords) : [];
  if (!ranges.length) {
    container.appendChild(document.createTextNode(source));
    return;
  }
  let position = 0;
  for (const [start, end] of ranges) {
    if (start > position) container.appendChild(document.createTextNode(source.slice(position, start)));
    container.appendChild(el('mark', { text: source.slice(start, end) }));
    position = end;
  }
  if (position < source.length) container.appendChild(document.createTextNode(source.slice(position)));
}

/* ------------------------------------------------------------------ */
/* 提示与提示条                                                        */
/* ------------------------------------------------------------------ */

let toastTimer = null;

function toast(message) {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  void dom.toast.offsetWidth; // 触发一次样式计算，保证过渡生效
  dom.toast.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove('show');
    window.setTimeout(() => {
      if (!dom.toast.classList.contains('show')) dom.toast.hidden = true;
    }, 220);
  }, TOAST_MS);
}

function showAlert(kind, message) {
  if (!dom.alertSlot) return;
  clear(dom.alertSlot);
  const text = el('div', { class: 'alert-text', text: message });
  const close = el('button', {
    class: 'alert-close',
    text: '×',
    attrs: { type: 'button', 'aria-label': '关闭提示', title: '关闭' },
  });
  close.addEventListener('click', clearAlert);
  dom.alertSlot.appendChild(el('div', { class: 'alert ' + (kind || 'info') }, [text, close]));
}

function clearAlert() {
  clear(dom.alertSlot);
}

function friendlyError(error) {
  const message = error && error.message ? String(error.message) : '未知错误';
  if (error && (error.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(message))) {
    return '无法连接到本地服务，请确认后端已启动（npm run serve）。';
  }
  return message;
}

/* ------------------------------------------------------------------ */
/* 视图切换                                                            */
/* ------------------------------------------------------------------ */

function setView(view) {
  if (dom.emptyState) dom.emptyState.hidden = view !== 'empty';
  if (dom.loading) dom.loading.hidden = view !== 'loading';
  if (dom.noResults) dom.noResults.hidden = view !== 'noresults';
  if (dom.resultsTable) dom.resultsTable.hidden = view !== 'results';
  if (view !== 'results') {
    if (dom.pagination) dom.pagination.hidden = true;
  }
  if (dom.results) dom.results.setAttribute('aria-busy', view === 'loading' ? 'true' : 'false');
}

function renderSkeleton() {
  if (!dom.skeletonRows) return;
  clear(dom.skeletonRows);
  for (let i = 0; i < SKELETON_ROWS; i += 1) {
    const widths = ['w-80', 'w-60', 'w-40', 'w-30'];
    const row = el('div', { class: 'skeleton-row' });
    row.appendChild(el('span', { class: 'skeleton-bar ' + widths[i % widths.length] }));
    row.appendChild(el('span', { class: 'skeleton-bar w-15' }));
    row.appendChild(el('span', { class: 'skeleton-bar w-15' }));
    dom.skeletonRows.appendChild(row);
  }
}

function setLoading(loading) {
  state.loading = loading;
  if (dom.searchBtn) {
    dom.searchBtn.disabled = loading;
    dom.searchBtn.textContent = loading ? '搜索中…' : '搜索';
    dom.searchBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
  }
  if (dom.searchInput) dom.searchInput.setAttribute('aria-busy', loading ? 'true' : 'false');
}

/* ------------------------------------------------------------------ */
/* 偏好（localStorage）                                                */
/* ------------------------------------------------------------------ */

function restorePrefs() {
  const sort = lsGet(LS_KEYS.sort);
  if (sort && SORT_VALUES.indexOf(sort) >= 0) state.sort = sort;
  state.sortColumn = SORT_TO_COLUMN[state.sort] || 'title';

  const order = lsGet(LS_KEYS.order);
  state.order = order && ORDER_VALUES.indexOf(order) >= 0 ? order : 'desc';
  if (state.sort === 'relevance') state.order = 'desc'; // 相关度没有方向

  const pageSize = asNumber(lsGet(LS_KEYS.pageSize));
  if (pageSize !== null && PAGE_SIZES.indexOf(pageSize) >= 0) state.pageSize = pageSize;

  // 封面偏好：只有显式存过 "0" 才关闭（默认开启）
  state.coversEnabled = lsGet(LS_KEYS.covers) !== '0';

  if (dom.sort) dom.sort.value = state.sort;
  if (dom.pageSize) dom.pageSize.value = String(state.pageSize);
  if (dom.covers) dom.covers.checked = state.coversEnabled;

  state.filters = restoreFilters();
  writeFilterInputs(state.filters);
}

function restoreFilters() {
  const raw = lsGet(LS_KEYS.filters);
  if (!raw) return { ...DEFAULT_FILTERS };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_FILTERS };
  }
  if (!isPlainObject(parsed)) return { ...DEFAULT_FILTERS };
  const minRaw = asNumber(parsed.minSeeders);
  let min = minRaw === null ? 0 : Math.floor(minRaw);
  if (!Number.isFinite(min) || min < 0) min = 0;
  return {
    minSeeders: min,
    exclude: asString(parsed.exclude),
    safe: parsed.safe === true,
  };
}

function writeFilterInputs(filters) {
  if (dom.minSeeders) dom.minSeeders.value = String(filters.minSeeders > 0 ? filters.minSeeders : 0);
  if (dom.exclude) dom.exclude.value = filters.exclude;
  if (dom.safe) dom.safe.checked = filters.safe === true;
}

function readFilterInputs() {
  const minRaw = dom.minSeeders ? asNumber(dom.minSeeders.value) : 0;
  let min = minRaw === null ? 0 : Math.floor(minRaw);
  if (!Number.isFinite(min) || min < 0) min = 0;
  return {
    minSeeders: min,
    exclude: dom.exclude ? String(dom.exclude.value || '') : '',
    safe: !!(dom.safe && dom.safe.checked),
  };
}

function saveFilters() {
  lsSet(LS_KEYS.filters, JSON.stringify(state.filters));
}

/** 「应用过滤」：把控件值落成生效值并重新搜索（回到第 1 页）。 */
function applyFilters() {
  state.filters = readFilterInputs();
  saveFilters();
  if (state.query) {
    runSearch({ query: state.query, page: 1 });
  } else {
    showAlert('info', '过滤条件已保存，输入关键词搜索时生效。');
  }
}

function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS };
  writeFilterInputs(state.filters);
  saveFilters();
  if (state.query) runSearch({ query: state.query, page: 1 });
  else toast('过滤条件已重置');
}

function savedSourceIds() {
  const raw = lsGet(LS_KEYS.sources);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id) => typeof id === 'string');
  } catch {
    return null;
  }
}

function saveSelectedSources() {
  lsSet(LS_KEYS.sources, JSON.stringify(Array.from(state.selected)));
}

/* ------------------------------------------------------------------ */
/* 数据源列表                                                          */
/* ------------------------------------------------------------------ */

function sourceNameOf(id) {
  const found = state.allSources.find((item) => item && item.id === id);
  return found && found.name ? String(found.name) : String(id);
}

function updateSourceCount() {
  if (!dom.sourceCount) return;
  if (!state.sourcesLoaded) {
    dom.sourceCount.textContent = '';
    return;
  }
  dom.sourceCount.textContent = '已选 ' + state.selected.size + ' / ' + state.allSources.length + ' 个源';
}

function renderSourceList() {
  if (!dom.sourceList) return;
  clear(dom.sourceList);

  if (!state.allSources.length) {
    dom.sourceList.appendChild(
      el('p', { class: 'muted small', text: '未能获取数据源列表，将使用后端默认启用的全部源。' }),
    );
    updateSourceCount();
    return;
  }

  for (const source of state.allSources) {
    const id = asString(source && source.id) || 'unknown';
    const name = asString(source && source.name) || id;
    const description = asString(source && source.description);
    const homepage = asString(source && source.homepage);
    const kinds = Array.isArray(source && source.kinds) ? source.kinds : [];

    const checkbox = el('input', {
      attrs: { type: 'checkbox', value: id, 'aria-label': '数据源 ' + name },
    });
    checkbox.checked = state.selected.has(id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(id);
      else state.selected.delete(id);
      saveSelectedSources();
      updateSourceCount();
    });

    const titleParts = [name];
    if (description) titleParts.push(description);
    if (homepage) titleParts.push(homepage);

    const label = el('label', { class: 'source-item', attrs: { title: titleParts.join(' — ') } }, [
      checkbox,
      el('span', { class: 'name', text: name }),
    ]);

    for (const kind of kinds.slice(0, 2)) {
      label.appendChild(el('span', { class: 'kind', text: String(kind) }));
    }

    dom.sourceList.appendChild(label);
  }

  updateSourceCount();
}

async function loadSources() {
  try {
    const res = await fetch('/api/sources', { headers: { accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      throw new Error((data && data.error && data.error.message) || '获取数据源失败（HTTP ' + res.status + '）');
    }
    const list = data && Array.isArray(data.sources) ? data.sources : [];
    state.allSources = list.filter(isPlainObject);
    state.sourcesLoaded = true;

    const saved = savedSourceIds();
    if (saved) {
      const known = new Set(state.allSources.map((item) => item.id));
      state.selected = new Set(saved.filter((id) => known.has(id)));
    } else {
      state.selected = new Set(
        state.allSources.filter((item) => item.defaultEnabled !== false).map((item) => item.id),
      );
    }
  } catch (error) {
    state.sourcesLoaded = false;
    state.allSources = [];
    renderSourceList();
    showAlert('info', '数据源列表加载失败：' + friendlyError(error) + ' 搜索时将使用后端默认启用的源。');
    return;
  }
  renderSourceList();
}

/* ------------------------------------------------------------------ */
/* 后端服务状态                                                        */
/* ------------------------------------------------------------------ */

function setServiceStatus(stateName, text) {
  if (dom.serviceDot) dom.serviceDot.dataset.state = stateName;
  if (dom.serviceText) dom.serviceText.textContent = text;
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data && data.ok === false) throw new Error('服务自检失败');
    const version = asString(data && data.version);
    const uptime = asNumber(data && data.uptimeSec);
    const parts = ['服务正常'];
    if (version) parts.push('v' + version);
    if (uptime !== null) parts.push('已运行 ' + Math.max(0, Math.round(uptime)) + ' 秒');

    // 下载能力（/api/health 新增字段）
    const downloads = isPlainObject(data && data.downloads) ? data.downloads : null;
    if (downloads) {
      const wasEnabled = state.downloads.enabled;
      state.downloads.enabled = downloads.enabled !== false;
      parts.push(state.downloads.enabled ? '下载已启用' : '下载未启用');
      const dir = asString(downloads.dir);
      if (dir) {
        state.downloads.dir = dir;
        renderDownloadsDir();
      }
      const active = asNumber(downloads.active);
      if (!state.downloads.loaded && active !== null && active > 0 && dom.downloadsBadge) {
        dom.downloadsBadge.textContent = String(Math.trunc(active));
        dom.downloadsBadge.hidden = false;
      }
      // 能力变化后刷新结果行上的「下载」按钮状态
      if (wasEnabled === null && state.hasResults) renderRows();
    }

    setServiceStatus('ok', parts.join(' · '));
  } catch {
    setServiceStatus('bad', '无法连接后端服务');
  }
}

/* ------------------------------------------------------------------ */
/* 排序                                                                */
/* ------------------------------------------------------------------ */

/** 表头 / 下拉框的方向指示与 aria-sort（相关度无方向，用中性标记 ●）。 */
function updateSortIndicators() {
  for (const column of Object.keys(SORT_COLUMNS)) {
    const config = SORT_COLUMNS[column];
    const active = state.sortColumn === column;
    const directional = active && column !== 'title';
    const arrow = dom.sortArrows[column];
    const button = dom.sortButtons[column];
    const header = dom.sortHeaders[column];

    if (arrow) {
      if (directional) arrow.textContent = state.order === 'asc' ? '↑' : '↓';
      else if (active) arrow.textContent = '●';
      else arrow.textContent = '';
      arrow.className = active && !directional ? 'sort-arrow neutral' : 'sort-arrow';
    }

    if (button) {
      if (active) button.classList.add('active');
      else button.classList.remove('active');

      let hint = '按' + config.label + '排序';
      if (active && directional) {
        hint += '，当前' + (state.order === 'asc' ? '升序' : '降序') + '，再次点击切换方向';
      } else if (active) {
        hint = '当前按相关度排序（相关度没有方向，● 表示当前排序列）';
      }
      button.setAttribute('title', hint);
      button.setAttribute(
        'aria-label',
        active && directional ? config.label + '，' + (state.order === 'asc' ? '升序' : '降序') : config.label,
      );
    }

    if (header) {
      header.setAttribute('aria-sort', directional ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none');
    }
  }

  // 与排序下拉框保持同步（表头点击后下拉框跟着变）
  if (dom.sort && SORT_VALUES.indexOf(state.sort) >= 0) dom.sort.value = state.sort;
}

/**
 * 表头点击：
 * - 非当前列 → sort=<列>、order=desc、page=1
 * - 当前列   → desc/asc 互切、page=1（相关度固定 desc，无方向）
 */
function handleSortHeader(column) {
  const config = SORT_COLUMNS[column];
  if (!config) return;
  if (!state.query) {
    showAlert('info', '请先输入关键词并搜索，再使用表头排序。');
    if (dom.searchInput) dom.searchInput.focus();
    return;
  }

  if (state.sortColumn === column) {
    if (column === 'title') {
      if (state.order === 'desc') return; // 相关度已是默认方向，无需重复请求
      state.order = 'desc';
    } else {
      state.order = state.order === 'asc' ? 'desc' : 'asc';
    }
  } else {
    state.sortColumn = column;
    state.sort = config.sort;
    state.order = 'desc'; // 切换排序列时方向重置为降序
  }

  if (state.sort === 'relevance') state.order = 'desc';

  lsSet(LS_KEYS.sort, state.sort);
  lsSet(LS_KEYS.order, state.order);
  updateSortIndicators();
  runSearch({ query: state.query, page: 1 });
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

function currentSourceParam() {
  if (!state.sourcesLoaded) return null; // 未加载成功：交给后端用默认源
  if (state.selected.size === 0) return null;
  return Array.from(state.selected).join(',');
}

function normalizeExclude(value) {
  return asString(value)
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(',');
}

function syncUrl(query) {
  try {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* 忽略 */
  }
}

function buildSearchParams(query, page, options = {}) {
  const params = new URLSearchParams();
  params.set('q', query);
  const sources = currentSourceParam();
  if (sources) params.set('sources', sources);
  params.set('sort', state.sort);
  params.set('order', state.order);
  params.set('page', String(page));
  params.set('pageSize', String(state.pageSize));

  const filters = state.filters;
  params.set('minSeeders', String(filters.minSeeders > 0 ? filters.minSeeders : 0));
  const exclude = normalizeExclude(filters.exclude);
  if (exclude) params.set('exclude', exclude);
  params.set('safe', filters.safe === true ? '1' : '0');
  if (options.noCache) params.set('noCache', '1');

  return params;
}

async function runSearch(options = {}) {
  const query = String(options.query !== undefined ? options.query : state.query).trim();
  const page = Math.max(1, Math.trunc(asNumber(options.page) || 1));
  const updateUrl = options.updateUrl !== false;
  const noCache = options.noCache === true;

  if (!query) {
    showAlert('info', '请输入搜索关键词。');
    if (dom.searchInput) dom.searchInput.focus();
    return;
  }

  if (state.sourcesLoaded && state.selected.size === 0) {
    showAlert('error', '请至少勾选一个数据源（可点击「全选」），然后再搜索。');
    return;
  }

  if (state.loading) return; // 禁用重复提交

  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;
  const seq = (state.seq += 1);
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CLIENT_TIMEOUT_MS);

  state.query = query;
  state.page = page;
  if (dom.searchInput && dom.searchInput.value !== query) dom.searchInput.value = query;

  clearAlert();
  setLoading(true);
  renderSkeleton();
  setView('loading');
  if (updateUrl) syncUrl(query);
  document.title = query + ' · 种子搜索';

  try {
    const params = buildSearchParams(query, page, { noCache });
    const res = await fetch('/api/search?' + params.toString(), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const message =
        (data && data.error && data.error.message) || (data && data.message) || '搜索失败（HTTP ' + res.status + '）';
      throw new Error(message);
    }
    if (!isPlainObject(data)) throw new Error('后端返回了无法解析的响应。');
    if (seq !== state.seq) return; // 已有更新的请求，丢弃过期响应

    renderResults(data, query);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (timedOut && seq === state.seq) {
        showAlert('error', '请求超时（超过 ' + Math.round(CLIENT_TIMEOUT_MS / 1000) + ' 秒），请稍后重试或减少勾选的数据源。');
        if (!state.hasResults) setView('empty');
      }
      return;
    }
    if (seq !== state.seq) return;
    showAlert('error', friendlyError(error));
    if (!state.hasResults) setView('empty');
  } finally {
    window.clearTimeout(timeoutId);
    if (seq === state.seq) {
      setLoading(false);
      if (state.controller === controller) state.controller = null;
    }
  }
}

function renderResults(data, query) {
  const results = Array.isArray(data.results) ? data.results.filter(isPlainObject) : [];
  const total = asNumber(data.total);
  const tookMs = asNumber(data.tookMs);
  const page = Math.max(1, Math.trunc(asNumber(data.page) || state.page || 1));
  let totalPages = asNumber(data.totalPages);
  if (totalPages === null || totalPages < 1) totalPages = 1;
  totalPages = Math.trunc(totalPages);

  state.page = page;
  state.hasResults = results.length > 0;
  state.lastResults = results;

  // 与后端回显的 sort / order 对齐（后端是排序的唯一权威）
  const serverSort = asString(data.sort);
  if (SORT_VALUES.indexOf(serverSort) >= 0) {
    state.sort = serverSort;
    state.sortColumn = SORT_TO_COLUMN[serverSort] || state.sortColumn;
  }
  const serverOrder = asString(data.order);
  if (ORDER_VALUES.indexOf(serverOrder) >= 0) state.order = serverOrder;

  renderSummary({
    total,
    tookMs,
    totalBeforeFilter: asNumber(data.totalBeforeFilter),
    cached: asBool(data.cached),
    filters: data.filters,
  });
  renderSourceStatus(Array.isArray(data.sources) ? data.sources : []);
  updateSortIndicators();

  if (!results.length) {
    setView('noresults');
    renderPagination(page, totalPages);
    return;
  }

  renderRows();
  setView('results');
  renderPagination(page, totalPages);
}

/** 每次重渲染自增：分块插入时用它丢弃已过期的任务（避免旧结果插到新列表里）。 */
let renderGeneration = 0;
/** 每块插入的行数：首块立即渲染，其余分帧补上。 */
const ROW_CHUNK_SIZE = 24;

/** 把回调排到空闲时间（不支持 requestIdleCallback 时退化为下一帧）。 */
function scheduleIdle(callback) {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(callback, { timeout: 200 });
    return;
  }
  window.setTimeout(callback, 16);
}

function renderRows() {
  if (!dom.resultsBody) return;
  const generation = ++renderGeneration;
  const keywords = keywordsOf(state.query);
  // 排序完全由后端全局完成，这里保持响应顺序
  const list = Array.isArray(state.lastResults) ? state.lastResults.slice() : [];
  clear(dom.resultsBody);
  resetCoverWork();

  // 先把行建好再插入。脱离文档的节点不触发布局，构建本身很便宜；
  // 真正的开销在插入时的布局：一次性插入 100 行实测要 ~200ms（肉眼一顿），
  // 所以首块立即插入、其余分帧补上——首屏只付第一块的代价。
  const rows = list.map((item) => buildResultRow(item, keywords));

  const insertChunk = (start) => {
    if (generation !== renderGeneration) return; // 期间又渲染过一次，丢弃这批
    const end = Math.min(start + ROW_CHUNK_SIZE, rows.length);
    const chunk = rows.slice(start, end);
    const fragment = document.createDocumentFragment();
    for (const row of chunk) fragment.appendChild(row);
    dom.resultsBody.appendChild(fragment);
    // 注意：appendChild(fragment) 会把 fragment 搬空，所以这里必须用行元素数组，
    // 不能拿 fragment 去 querySelectorAll（那样永远查不到，封面也就永远不加载）。
    observeCovers(chunk);
    if (end < rows.length) scheduleIdle(() => insertChunk(end));
  };

  insertChunk(0);

  if (state.query) dom.resultsTable.setAttribute('aria-label', '“' + state.query + '”的搜索结果');
}

/* ------------------------------------------------------------------ */
/* 封面：只对进入视口的行查询，且批量、串行、可中断                      */
/* ------------------------------------------------------------------ */

/** 一次最多查多少个标题（服务端上限是 24）。
 *  取小值是为了**渐进出现**：一次查 24 个要等全部完成才返回，封面会迟迟不露面。 */
const MAX_COVER_BATCH = 6;

/** 取片名的首个字母/汉字，用作无封面时的占位。 */
function initialOf(title) {
  const match = String(title).match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : '?';
}

/** 重渲染前清掉封面相关的在途状态（旧行已从 DOM 移除）。 */
function resetCoverWork() {
  state.coverSeq += 1;
  if (state.coverTimer !== null) {
    window.clearTimeout(state.coverTimer);
    state.coverTimer = null;
  }
  if (state.coverObserver) {
    state.coverObserver.disconnect();
    state.coverObserver = null;
  }
  state.coverPending = new Map();
}

/** 用户关掉封面开关时调用：停止一切在途查询。 */
function cancelCoverWork() {
  resetCoverWork();
}

/**
 * 观察这一批行里的封面占位块：进入视口才加入待查队列。
 *
 * 这样即使一页 100 行，也只会为真正看得到的行去查第三方，
 * 既省请求也不会拖慢首屏。
 *
 * @param {Element[]} rows 已经插入文档的行元素
 */
function observeCovers(rows) {
  if (!state.coversEnabled || rows.length === 0) return;

  const targets = [];
  for (const row of rows) {
    const node = row.querySelector('.cover[data-cover-title]');
    if (node) targets.push(node);
  }
  if (targets.length === 0) return;

  if (typeof window.IntersectionObserver !== 'function') {
    // 不支持就直接排队（老浏览器上功能优先）
    for (const node of targets) enqueueCover(node);
    return;
  }

  if (!state.coverObserver) {
    state.coverObserver = new window.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state.coverObserver.unobserve(entry.target);
          enqueueCover(entry.target);
        }
      },
      // 提前 200px 开始查，滚到跟前时通常已经就绪
      { rootMargin: '200px 0px' },
    );
  }
  for (const node of targets) state.coverObserver.observe(node);
}

/** 把一行加入待查队列，并按批触发查询。 */
function enqueueCover(node) {
  if (!state.coversEnabled || node.dataset.coverDone === '1') return;
  const title = node.dataset.coverTitle;
  if (!title) return;
  node.dataset.coverDone = '1';

  let nodes = state.coverPending.get(title);
  if (!nodes) {
    nodes = new Set();
    state.coverPending.set(title, nodes);
  }
  nodes.add(node);

  if (state.coverTimer === null) {
    state.coverTimer = window.setTimeout(() => {
      state.coverTimer = null;
      flushCovers();
    }, 120);
  }
}

/** 取一批待查标题，问服务端要封面地址，然后填到对应行上。 */
async function flushCovers() {
  if (!state.coversEnabled) return;
  const batch = [...state.coverPending.keys()].slice(0, MAX_COVER_BATCH);
  if (batch.length === 0) return;

  const nodesByTitle = new Map();
  for (const title of batch) {
    nodesByTitle.set(title, state.coverPending.get(title));
    state.coverPending.delete(title);
  }

  const seq = state.coverSeq;
  const params = new URLSearchParams();
  for (const title of batch) params.append('title', title);

  try {
    const response = await fetch('/api/covers?' + params.toString(), { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    const data = await response.json();
    // 期间重渲染过、或用户关掉了封面 → 丢弃这批结果
    if (seq !== state.coverSeq || !state.coversEnabled) return;

    for (const item of data.covers ?? []) {
      const nodes = nodesByTitle.get(item.title);
      if (!nodes) continue;
      for (const node of nodes) {
        if (!node.isConnected) continue;
        if (item.url) {
          node.appendChild(
            el('img', {
              class: 'cover-img',
              attrs: { src: item.url, alt: '', decoding: 'async', loading: 'lazy' },
            }),
          );
          if (item.pageUrl) node.setAttribute('title', '封面来自 ' + (item.provider ?? '第三方'));
        } else {
          node.classList.add('cover-empty');
        }
      }
    }
  } catch {
    /* 网络问题就静默放弃：封面只是锦上添花，不该影响主流程 */
  } finally {
    if (state.coverPending.size > 0) {
      if (state.coverTimer === null) {
        state.coverTimer = window.setTimeout(() => {
          state.coverTimer = null;
          flushCovers();
        }, 120);
      }
    }
  }
}

/**
 * 建一行结果。
 *
 * @param {object} item 一条搜索结果
 * @param {string[]} keywords 用于高亮的关键词
 * @returns {HTMLTableRowElement}
 */
function buildResultRow(item, keywords) {
  {
    const title = asString(item.title) || '(无标题)';
    const detailsUrl = asString(item.detailsUrl);
    const torrentUrl = asString(item.torrentUrl);
    const magnet = asString(item.magnet);
    const infoHash = asString(item.infoHash);

    const tr = el('tr');

    // 标题（关键词高亮：文本节点分割 + <mark>）
    const titleCell = el('td', { class: 'cell-title', dataset: { label: '标题' } });
    if (state.coversEnabled) {
      // 占位块先占好位置（固定尺寸），封面到了再塞 <img>，避免加载时抖动。
      // 没有封面时这个块显示片名首字，所以也不会出现空洞。
      titleCell.appendChild(
        el('span', {
          class: 'cover',
          dataset: { coverTitle: title, initial: initialOf(title) },
          attrs: { 'aria-hidden': 'true' },
        }),
      );
    }
    const titleNode = detailsUrl
      ? el('a', {
          class: 'title-link',
          attrs: { href: detailsUrl, target: '_blank', rel: 'noopener noreferrer', title: title },
        })
      : el('span', { class: 'title-link', attrs: { title: title } });
    highlightInto(titleNode, title, keywords);
    titleCell.appendChild(titleNode);
    if (infoHash) {
      titleCell.appendChild(el('span', { class: 'hash', text: infoHash, attrs: { title: 'InfoHash：' + infoHash } }));
    }
    tr.appendChild(titleCell);

    // 大小
    tr.appendChild(el('td', { class: 'num', text: formatSize(item), dataset: { label: '大小' } }));

    // 做种
    const seeders = asNumber(item.seeders);
    tr.appendChild(
      el('td', {
        class: 'num ' + seedClass(seeders),
        text: seedText(seeders),
        dataset: { label: '做种' },
        attrs: { title: seeders === null ? '做种数未知' : '做种 ' + seeders },
      }),
    );

    // 下载
    tr.appendChild(el('td', { class: 'num', text: formatInt(item.leechers), dataset: { label: '下载' } }));

    // 来源徽章（含合并来源）
    const sourceCell = el('td', { dataset: { label: '来源' } });
    const badges = el('div', { class: 'badges' });
    const ids = Array.isArray(item.sources) && item.sources.length
      ? item.sources.filter((id) => typeof id === 'string' && id)
      : [asString(item.source) || 'unknown'];
    const primary = asString(item.source);
    for (const id of ids) {
      const isPrimary = id === primary;
      const label = id === primary && asString(item.sourceName) ? asString(item.sourceName) : sourceNameOf(id);
      const classes = ['badge'];
      if (isPrimary) classes.push('primary');
      if (ids.length > 1 && !isPrimary) classes.push('merged');
      badges.appendChild(el('span', { class: classes.join(' '), text: label, attrs: { title: '数据源：' + id } }));
    }
    sourceCell.appendChild(badges);
    tr.appendChild(sourceCell);

    // 时间
    const publishedAt = asString(item.publishedAt);
    tr.appendChild(
      el('td', {
        class: 'nowrap',
        text: formatRelative(publishedAt),
        dataset: { label: '时间' },
        attrs: publishedAt ? { title: formatAbsolute(publishedAt) } : {},
      }),
    );

    // 操作
    const actionsCell = el('td', { class: 'cell-actions', dataset: { label: '操作' } });
    const actions = el('div', { class: 'actions' });

    const copyBtn = el('button', {
      class: 'btn linkish',
      text: '复制磁力',
      attrs: {
        type: 'button',
        title: magnet ? '复制磁力链接到剪贴板' : '该结果没有磁力链接',
        'aria-label': '复制《' + title + '》的磁力链接',
      },
    });
    if (!magnet) {
      copyBtn.disabled = true;
      copyBtn.setAttribute('aria-disabled', 'true');
    } else {
      copyBtn.addEventListener('click', () => copyMagnet(magnet, copyBtn));
    }
    actions.appendChild(copyBtn);

    const openBtn = el('button', {
      class: 'btn linkish',
      text: '打开磁力',
      attrs: {
        type: 'button',
        title: magnet ? '用系统默认 BT 客户端打开磁力链接' : '该结果没有磁力链接',
        'aria-label': '打开《' + title + '》的磁力链接',
      },
    });
    if (!magnet) {
      openBtn.disabled = true;
      openBtn.setAttribute('aria-disabled', 'true');
    } else {
      openBtn.addEventListener('click', () => openMagnet(magnet));
    }
    actions.appendChild(openBtn);

    // 下载：在服务端创建 BT 下载任务
    const downloadsDisabled = state.downloads.enabled === false;
    const downloadBtn = el('button', {
      class: 'btn linkish',
      text: '下载',
      attrs: {
        type: 'button',
        title: !magnet
          ? '该结果没有磁力链接'
          : downloadsDisabled
            ? '后端未启用下载功能'
            : '在服务端创建 BT 下载任务',
        'aria-label': '下载《' + title + '》',
      },
    });
    if (!magnet || downloadsDisabled) {
      downloadBtn.disabled = true;
      downloadBtn.setAttribute('aria-disabled', 'true');
    } else {
      downloadBtn.addEventListener('click', () => addDownload(magnet, downloadBtn));
    }
    actions.appendChild(downloadBtn);

    if (torrentUrl) {
      actions.appendChild(
        el('a', {
          class: 'btn linkish',
          text: '下载种子',
          attrs: {
            href: torrentUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '在新窗口打开种子文件链接',
            'aria-label': '下载《' + title + '》的种子文件',
          },
        }),
      );
    } else {
      const disabled = el('span', {
        class: 'btn linkish',
        text: '下载种子',
        attrs: { title: '该结果没有种子下载链接', 'aria-disabled': 'true' },
      });
      disabled.style.opacity = '0.45';
      actions.appendChild(disabled);
    }

    actionsCell.appendChild(actions);
    tr.appendChild(actionsCell);

    return tr;
  }
}

/** 结果摘要：总数 / 耗时 / 已过滤 N 条 / 缓存标记。 */
function renderSummary(meta) {
  if (dom.resultSummary) {
    const parts = ['共 ' + formatInt(meta.total === null ? 0 : meta.total) + ' 条结果'];
    if (meta.tookMs !== null) parts.push('耗时 ' + Math.round(meta.tookMs) + ' ms');
    dom.resultSummary.textContent = parts.join('，');
  }

  const after = meta.total === null ? 0 : meta.total;
  const before = meta.totalBeforeFilter;
  if (dom.filterNote) {
    if (before !== null && before > after) {
      dom.filterNote.textContent = '已过滤 ' + formatInt(before - after) + ' 条';
      dom.filterNote.hidden = false;
      dom.filterNote.setAttribute(
        'title',
        '过滤前 ' + formatInt(before) + ' 条，过滤后 ' + formatInt(after) + ' 条' + describeFilters(meta.filters),
      );
    } else {
      dom.filterNote.textContent = '';
      dom.filterNote.hidden = true;
      dom.filterNote.removeAttribute('title');
    }
  }

  if (dom.cacheNote) dom.cacheNote.hidden = meta.cached !== true;
}

/** 过滤条件描述（优先用后端回显的 filters）。 */
function describeFilters(serverFilters) {
  const filters = isPlainObject(serverFilters) ? serverFilters : state.filters;
  const bits = [];
  const min = asNumber(filters.minSeeders);
  if (min !== null && min > 0) bits.push('最少做种 ' + min);
  const exclude = Array.isArray(filters.exclude) ? filters.exclude.join(',') : asString(filters.exclude);
  if (exclude) bits.push('排除 ' + exclude);
  if (filters.safe === true) bits.push('安全过滤');
  return bits.length ? '；过滤条件：' + bits.join(' · ') : '';
}

function renderSourceStatus(list) {
  if (!dom.sourceStatusPanel || !dom.sourceStatusList) return;
  clear(dom.sourceStatusList);

  const sources = list.filter(isPlainObject);
  if (!sources.length) {
    dom.sourceStatusList.appendChild(el('span', { class: 'muted small', text: '本次响应未包含数据源状态。' }));
    dom.sourceStatusPanel.hidden = false;
    return;
  }

  for (const source of sources) {
    const id = asString(source.id) || 'unknown';
    const name = asString(source.name) || sourceNameOf(id);
    const ok = source.ok !== false;
    const count = asNumber(source.count);
    const ms = asNumber(source.tookMs);
    const errorText = asString(source.error);
    const cached = source.cached === true;

    const chip = el('span', {
      class: 'source-chip ' + (ok ? 'ok' : 'fail'),
      attrs: {
        title: ok
          ? name + '：' + (count === null ? 0 : count) + ' 条' + (ms === null ? '' : '，耗时 ' + ms + ' ms')
          : name + '：' + (errorText || '该数据源本次搜索失败'),
      },
    });

    chip.appendChild(el('span', { class: 'chip-name', text: name }));
    if (ok) {
      chip.appendChild(el('span', { class: 'chip-meta', text: (count === null ? 0 : count) + ' 条' }));
      chip.appendChild(el('span', { class: 'chip-meta', text: ms === null ? '— ms' : ms + ' ms' }));
      if (cached) chip.appendChild(el('span', { class: 'chip-tag', text: '缓存' }));
    } else {
      chip.appendChild(el('span', { class: 'chip-meta', text: '失败' }));
      chip.appendChild(el('span', { class: 'chip-tag', text: '查看原因' }));
    }

    dom.sourceStatusList.appendChild(chip);
  }

  dom.sourceStatusPanel.hidden = false;
}

function renderPagination(page, totalPages) {
  if (!dom.pagination) return;
  if (totalPages <= 1) {
    dom.pagination.hidden = true;
    if (dom.pageInfo) dom.pageInfo.textContent = '第 1 / 1 页';
    return;
  }
  dom.pagination.hidden = false;
  if (dom.pageInfo) dom.pageInfo.textContent = '第 ' + page + ' / ' + totalPages + ' 页';
  if (dom.prevPage) dom.prevPage.disabled = page <= 1;
  if (dom.nextPage) dom.nextPage.disabled = page >= totalPages;
}

/* ------------------------------------------------------------------ */
/* 磁力链接操作                                                        */
/* ------------------------------------------------------------------ */

function legacyCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.left = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);

  const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  document.body.removeChild(area);
  if (selection && previousRange) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  return ok === true;
}

async function copyMagnet(magnet, button) {
  if (!magnet) return;
  let ok = false;

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(magnet);
      ok = true;
    }
  } catch {
    ok = false;
  }

  if (!ok) ok = legacyCopy(magnet);

  if (ok) {
    toast('已复制磁力链接');
    flashButton(button, '已复制', 1200);
  } else {
    toast('复制失败，请手动选择磁力链接');
  }
}

function openMagnet(magnet) {
  if (!magnet) return;
  try {
    window.location.href = magnet;
  } catch {
    toast('无法打开磁力链接，请改用「复制磁力」');
  }
}

/* ------------------------------------------------------------------ */
/* 下载面板（BT 下载任务）                                             */
/* ------------------------------------------------------------------ */

function clamp01(value) {
  const n = asNumber(value);
  if (n === null) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function formatSpeed(bytesPerSecond) {
  const n = asNumber(bytesPerSecond);
  if (n === null || n <= 0) return '';
  return formatBytes(n) + '/s';
}

function downloadStatusLabel(status) {
  const key = asString(status);
  return DL_STATUS_LABELS[key] || (key || '未知');
}

function isActiveStatus(status) {
  return DL_ACTIVE_STATUSES.indexOf(asString(status)) >= 0;
}

/** 短暂把按钮文案换成反馈文案（如「已加入」「已复制」）。 */
function flashButton(button, text, ms) {
  if (!button) return;
  const original = button.textContent;
  button.textContent = text;
  button.classList.add('copied');
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
    button.disabled = false;
  }, ms || DL_FLASH_MS);
}

function getEventSourceCtor() {
  try {
    if (typeof window !== 'undefined' && typeof window.EventSource === 'function') return window.EventSource;
  } catch {
    /* 忽略 */
  }
  return null;
}

function setDownloadsHint(text, kind) {
  if (!dom.downloadsAlert) return;
  const message = asString(text);
  clear(dom.downloadsAlert);
  if (!message) return;
  dom.downloadsAlert.appendChild(
    el('div', { class: 'alert ' + (kind === 'error' ? 'error' : 'info'), text: message }),
  );
}

function updateDownloadsBadge() {
  if (!dom.downloadsBadge) return;
  const count = state.downloads.tasks.size;
  if (count > 0) {
    dom.downloadsBadge.textContent = String(count);
    dom.downloadsBadge.hidden = false;
  } else {
    dom.downloadsBadge.textContent = '';
    dom.downloadsBadge.hidden = true;
  }
}

function renderDownloadsDir() {
  if (!dom.downloadsDir) return;
  const dir = asString(state.downloads.dir);
  dom.downloadsDir.textContent = dir ? '保存到：' + dir : '';
  dom.downloadsDir.setAttribute('title', dir ? '服务端默认下载目录：' + dir : '服务端默认下载目录');
}

function renderDownloadsEmpty() {
  if (!dom.downloadsList) return;
  let empty = dom.downloadsEmpty;
  if (!empty) {
    empty = el('p', { class: 'muted small dl-empty', text: '暂无下载任务。在搜索结果里点「下载」即可创建任务。' });
    dom.downloadsEmpty = empty;
  }
  const isEmpty = state.downloads.tasks.size === 0;
  if (isEmpty && !empty.parentNode) dom.downloadsList.appendChild(empty);
  if (!isEmpty && empty.parentNode) empty.parentNode.removeChild(empty);
}

/** 建一行任务 DOM，返回 { row, refs }。 */
function createTaskRow(task) {
  const refs = { taskId: asString(task.id), filesLen: -1 };
  const row = el('article', { class: 'dl-task', attrs: { 'data-id': refs.taskId } });

  const head = el('div', { class: 'dl-task-head' });
  refs.name = el('span', { class: 'dl-name' });
  refs.status = el('span', { class: 'dl-status' });
  refs.backend = el('span', { class: 'dl-backend' });
  head.appendChild(refs.name);
  head.appendChild(refs.status);
  head.appendChild(refs.backend);
  head.appendChild(el('span', { class: 'spacer' }));

  refs.cancel = el('button', {
    class: 'btn linkish',
    text: '取消',
    attrs: { type: 'button', title: '停止该任务并从列表移除（不会删除已下载的文件）' },
  });
  refs.cancel.addEventListener('click', () => requestRemoveDownload(refs.taskId, false, refs.cancel));

  // 重试/续传：失败、中断、取消的任务可重新添加（后端会先校验已有分片，已校验过的自动跳过）
  refs.retry = el('button', {
    class: 'btn linkish',
    text: '续传',
    attrs: { type: 'button', title: '重新创建下载任务：已下载且校验通过的分片会自动跳过' },
  });
  refs.retry.hidden = true;
  refs.retry.addEventListener('click', () => retryDownload(refs.taskId, refs.retry));

  refs.delCheck = el('input', { attrs: { type: 'checkbox', 'aria-label': '删除任务时同时删除已下载的文件' } });
  const delLabel = el(
    'label',
    { class: 'dl-del', attrs: { title: '勾选后点「删除」会一并删除已下载的文件（deleteFiles=1）' } },
    [refs.delCheck, el('span', { text: '删文件' })],
  );

  refs.remove = el('button', {
    class: 'btn linkish',
    text: '删除',
    attrs: { type: 'button', title: '删除该任务记录（默认保留已下载的文件）' },
  });
  refs.remove.addEventListener('click', () =>
    requestRemoveDownload(refs.taskId, refs.delCheck.checked === true, refs.remove),
  );

  head.appendChild(refs.cancel);
  head.appendChild(refs.retry);
  head.appendChild(delLabel);
  head.appendChild(refs.remove);
  row.appendChild(head);

  refs.bar = el('div', {
    class: 'dl-bar',
    attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' },
  });
  refs.barFill = el('div', { class: 'dl-bar-fill' });
  refs.bar.appendChild(refs.barFill);
  row.appendChild(refs.bar);

  const meta = el('div', { class: 'dl-meta' });
  refs.bytes = el('span', { class: 'dl-bytes' });
  refs.pct = el('span', { class: 'dl-pct' });
  refs.speed = el('span', { class: 'dl-speed' });
  refs.peers = el('span', { class: 'dl-peers' });
  meta.appendChild(refs.bytes);
  meta.appendChild(refs.pct);
  meta.appendChild(refs.speed);
  meta.appendChild(refs.peers);
  row.appendChild(meta);

  refs.error = el('p', { class: 'dl-error' });
  refs.error.hidden = true;
  row.appendChild(refs.error);

  refs.files = el('ul', { class: 'dl-files' });
  refs.files.hidden = true;
  row.appendChild(refs.files);

  return { row, refs };
}

/** 用最新快照就地更新一行（不重建 DOM，避免闪烁与丢失勾选状态）。 */
function updateTaskRow(entry, task) {
  const refs = entry.refs;
  const status = asString(task.status) || 'queued';
  const name = asString(task.name) || '(未命名任务)';

  refs.name.textContent = name;
  refs.name.setAttribute('title', name);
  refs.status.textContent = downloadStatusLabel(status);
  refs.status.className = 'dl-status dl-status-' + status;

  // 标明这条任务是哪个后端在跑（内置引擎 / qBittorrent）——用户需要知道文件在哪
  const backend = asString(task.backend);
  const backendText = DL_BACKEND_LABELS[backend] ?? '';
  refs.backend.textContent = backendText;
  refs.backend.hidden = backendText === '';
  refs.backend.setAttribute('title', backendText ? '由「' + backendText + '」执行' : '');

  const progress = clamp01(task.progress);
  const percent = progress === null ? 0 : progress * 100;
  refs.barFill.style.width = percent.toFixed(1) + '%';
  refs.bar.setAttribute('aria-valuenow', String(Math.round(percent)));

  const done = asNumber(task.bytesDone);
  const total = asNumber(task.totalBytes);
  refs.bytes.textContent = formatBytes(done) + ' / ' + (total !== null && total > 0 ? formatBytes(total) : '未知');
  refs.pct.textContent = progress === null ? '' : percent.toFixed(1) + '%';

  const speedText = formatSpeed(task.speed);
  refs.speed.textContent = speedText;
  refs.speed.hidden = speedText === '';

  const connected = asNumber(task.peersConnected);
  const available = asNumber(task.peersAvailable);
  const peersText =
    connected === null && available === null
      ? ''
      : 'peer ' + (connected === null ? 0 : connected) + '/' + (available === null ? 0 : available);
  refs.peers.textContent = peersText;
  refs.peers.hidden = peersText === '';

  const errorText = asString(task.error);
  if (errorText) {
    refs.error.textContent = status === 'failed' ? errorText + '（' + DL_FAILED_HINT + '）' : errorText;
    refs.error.hidden = false;
  } else {
    refs.error.textContent = '';
    refs.error.hidden = true;
  }

  refs.cancel.hidden = !isActiveStatus(status);
  // 续传按钮：只对"没下完且没在跑"的任务出现
  refs.retry.hidden = !['failed', 'interrupted', 'cancelled', 'stopped'].includes(status);
  refs.remove.disabled = false;

  const files = Array.isArray(task.files) ? task.files.filter(isPlainObject) : [];
  if (status === 'done' && files.length > 0) {
    if (refs.filesLen !== files.length) {
      clear(refs.files);
      for (const file of files) {
        const path = asString(file.path);
        if (!path) continue;
        const length = asNumber(file.length);
        refs.files.appendChild(
          el('li', { class: 'dl-file', attrs: { title: path } }, [
            el('span', { class: 'dl-file-path', text: path }),
            el('span', { class: 'dl-file-size', text: length === null ? '' : formatBytes(length) }),
          ]),
        );
      }
      refs.filesLen = files.length;
    }
    refs.files.hidden = false;
  } else {
    refs.files.hidden = true;
  }
}

function appendTaskRow(task) {
  if (!dom.downloadsList) return null;
  const id = asString(task.id);
  if (!id) return null;
  const entry = createTaskRow(task);
  state.downloads.tasks.set(id, task);
  state.downloads.rows.set(id, entry);
  if (state.downloads.order.indexOf(id) < 0) state.downloads.order.push(id);
  updateTaskRow(entry, task);
  dom.downloadsList.appendChild(entry.row);
  renderDownloadsEmpty();
  return entry;
}

function dropTask(id) {
  const key = asString(id);
  if (!key) return;
  const entry = state.downloads.rows.get(key);
  if (entry && entry.row && entry.row.parentNode) entry.row.parentNode.removeChild(entry.row);
  state.downloads.rows.delete(key);
  state.downloads.tasks.delete(key);
  state.downloads.pending.delete(key);
  const index = state.downloads.order.indexOf(key);
  if (index >= 0) state.downloads.order.splice(index, 1);
  updateDownloadsBadge();
  renderDownloadsEmpty();
}

function resetTasks(list) {
  state.downloads.tasks = new Map();
  state.downloads.rows = new Map();
  state.downloads.order = [];
  state.downloads.pending.clear();
  if (dom.downloadsList) clear(dom.downloadsList);
  const tasks = list
    .filter(isPlainObject)
    .slice()
    .sort((a, b) => (asNumber(a.createdAt) || 0) - (asNumber(b.createdAt) || 0));
  for (const task of tasks) appendTaskRow(task);
  updateDownloadsBadge();
  renderDownloadsEmpty();
}

/** progress 事件合流：同一个任务只保留最新快照，定时批量刷新。 */
function queueTaskRender(task) {
  const id = asString(task && task.id);
  if (!id) return;
  state.downloads.pending.set(id, task);
  if (state.downloads.flushTimer !== null) return;
  state.downloads.flushTimer = window.setTimeout(() => {
    state.downloads.flushTimer = null;
    flushTaskRenders();
  }, DL_FLUSH_MS);
}

function flushTaskRenders() {
  const pending = state.downloads.pending;
  if (pending.size === 0) return;
  const tasks = Array.from(pending.values());
  pending.clear();
  for (const task of tasks) {
    const id = asString(task.id);
    const entry = state.downloads.rows.get(id);
    state.downloads.tasks.set(id, task);
    if (entry) updateTaskRow(entry, task);
    else appendTaskRow(task);
  }
  updateDownloadsBadge();
}

function handleStreamPayload(raw) {
  const text = asString(raw);
  if (!text) return;
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (!isPlainObject(payload)) return;
  const type = asString(payload.type);

  if (type === 'hello') {
    state.downloads.loaded = true;
    resetTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
    setDownloadsHint('', 'info');
    return;
  }
  if (type === 'update' || type === 'progress') {
    if (isPlainObject(payload.task)) queueTaskRender(payload.task);
    return;
  }
  if (type === 'removed') {
    dropTask(asString(payload.id));
  }
}

function connectDownloadsStream() {
  disconnectDownloadsStream();
  const Ctor = getEventSourceCtor();
  if (!Ctor) {
    setDownloadsHint('当前浏览器不支持 EventSource，无法实时刷新进度，可点「刷新」手动更新。', 'error');
    return;
  }
  try {
    const source = new Ctor('/api/downloads/stream');
    state.downloads.source = source;
    source.onmessage = (event) => handleStreamPayload(event && event.data);
    source.onopen = () => setDownloadsHint('', 'info');
    source.onerror = () => setDownloadsHint('实时连接中断，浏览器会自动重连…', 'error');
  } catch (error) {
    setDownloadsHint('无法建立实时连接：' + friendlyError(error), 'error');
  }
}

function disconnectDownloadsStream() {
  const source = state.downloads.source;
  if (!source) return;
  state.downloads.source = null;
  try {
    source.onmessage = null;
    source.onopen = null;
    source.onerror = null;
    if (typeof source.close === 'function') source.close();
  } catch {
    /* 忽略 */
  }
}

async function loadDownloads() {
  if (!dom.downloadsList) return;
  setDownloadsHint('正在加载任务列表…', 'info');
  try {
    const res = await fetch('/api/downloads', { headers: { accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      throw new Error((data && data.error && data.error.message) || '加载任务失败（HTTP ' + res.status + '）');
    }
    state.downloads.loaded = true;
    const dir = asString(data && data.dir);
    if (dir) state.downloads.dir = dir;
    renderDownloadsDir();
    resetTasks(Array.isArray(data && data.tasks) ? data.tasks : []);
    setDownloadsHint('', 'info');
  } catch (error) {
    setDownloadsHint(friendlyError(error), 'error');
  }
}

function openDownloadsPanel() {
  if (!dom.downloadsPanel) return;
  state.downloads.open = true;
  if (dom.downloadsBody) dom.downloadsBody.hidden = false;
  if (dom.downloadsToggle) dom.downloadsToggle.setAttribute('aria-expanded', 'true');
  if (dom.downloadsCaret) dom.downloadsCaret.textContent = '▾';
  renderDownloadsDir();
  if (!state.downloads.loaded) loadDownloads();
  connectDownloadsStream();
  if (dom.downloadsPanel.scrollIntoView) {
    try {
      dom.downloadsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      /* 忽略 */
    }
  }
}

function closeDownloadsPanel() {
  state.downloads.open = false;
  if (dom.downloadsBody) dom.downloadsBody.hidden = true;
  if (dom.downloadsToggle) dom.downloadsToggle.setAttribute('aria-expanded', 'false');
  if (dom.downloadsCaret) dom.downloadsCaret.textContent = '▸';
  disconnectDownloadsStream();
}

function toggleDownloadsPanel() {
  if (state.downloads.open) closeDownloadsPanel();
  else openDownloadsPanel();
}

/** 新建下载任务（POST /api/downloads，成功为 201）。 */
async function addDownload(magnet, button) {
  const input = asString(magnet);
  if (!input) return;
  if (state.downloads.enabled === false) {
    showAlert('error', '后端未启用下载功能。');
    return;
  }
  if (button) button.disabled = true;

  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ input }),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      throw new Error((data && data.error && data.error.message) || '创建下载任务失败（HTTP ' + res.status + '）');
    }
    if (!isPlainObject(data)) throw new Error('后端返回了无法解析的响应。');

    // 201=新建成功；重复任务后端返回已存在的那条，同样按成功处理
    state.downloads.enabled = true;
    queueTaskRender(data);
    flushTaskRenders();
    openDownloadsPanel();
    flashButton(button, '已加入', DL_FLASH_MS);
  } catch (error) {
    if (button) button.disabled = false;
    showAlert('error', friendlyError(error));
  }
}

/** 取消 / 删除任务（后端只有 DELETE：取消会连记录一起移除）。 */
async function requestRemoveDownload(id, deleteFiles, button) {
  const key = asString(id);
  if (!key) return;
  if (button) button.disabled = true;
  try {
    const url = '/api/downloads/' + encodeURIComponent(key) + (deleteFiles ? '?deleteFiles=1' : '');
    const res = await fetch(url, { method: 'DELETE', headers: { accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      throw new Error((data && data.error && data.error.message) || '操作失败（HTTP ' + res.status + '）');
    }
    dropTask(key);
    setDownloadsHint(deleteFiles ? '任务已删除，已下载的文件已一并删除。' : '任务已移除（已下载的文件保留）。', 'info');
  } catch (error) {
    if (button) button.disabled = false;
    setDownloadsHint(friendlyError(error), 'error');
  }
}

/** 续传：用任务自带的磁力重新创建一个下载任务（后端会校验并跳过已有分片）。 */
async function retryDownload(id, button) {
  const task = state.downloads.tasks.get(asString(id));
  const magnet = task ? asString(task.magnet) : '';
  if (!magnet) {
    setDownloadsHint('这个任务没有磁力链接，无法续传；请回到搜索结果重新下载。', 'error');
    return;
  }
  // addDownload 会打开面板并闪「已加入」；这里换成「续传中」更贴切
  await addDownload(magnet, button);
  if (button && button.textContent === '已加入') flashButton(button, '续传中', DL_FLASH_MS);
}

/* ------------------------------------------------------------------ */
/* 事件绑定与初始化                                                    */
/* ------------------------------------------------------------------ */

function renderExamples() {
  if (!dom.examples) return;
  clear(dom.examples);
  for (const keyword of EXAMPLE_KEYWORDS) {
    const btn = el('button', {
      class: 'btn tiny',
      text: keyword,
      attrs: { type: 'button', title: '搜索 ' + keyword, 'aria-label': '搜索示例关键词 ' + keyword },
    });
    btn.addEventListener('click', () => {
      if (dom.searchInput) dom.searchInput.value = keyword;
      runSearch({ query: keyword, page: 1 });
    });
    dom.examples.appendChild(btn);
  }
}

function bindEvents() {
  if (dom.searchForm) {
    dom.searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runSearch({ query: dom.searchInput ? dom.searchInput.value : '', page: 1 });
    });
  }

  if (dom.sort) {
    dom.sort.addEventListener('change', () => {
      state.sort = SORT_VALUES.indexOf(dom.sort.value) >= 0 ? dom.sort.value : 'relevance';
      state.sortColumn = SORT_TO_COLUMN[state.sort] || 'title';
      state.order = 'desc'; // 下拉框切换排序列时方向重置为降序
      lsSet(LS_KEYS.sort, state.sort);
      lsSet(LS_KEYS.order, state.order);
      updateSortIndicators();
      if (state.query) runSearch({ query: state.query, page: 1 });
    });
  }

  if (dom.pageSize) {
    dom.pageSize.addEventListener('change', () => {
      const value = asNumber(dom.pageSize.value);
      state.pageSize = value !== null && PAGE_SIZES.indexOf(value) >= 0 ? value : DEFAULT_PAGE_SIZE;
      lsSet(LS_KEYS.pageSize, String(state.pageSize));
      if (state.query) runSearch({ query: state.query, page: 1 });
    });
  }

  if (dom.selectAll) {
    dom.selectAll.addEventListener('click', () => {
      state.selected = new Set(state.allSources.map((item) => item.id));
      saveSelectedSources();
      renderSourceList();
    });
  }

  if (dom.selectNone) {
    dom.selectNone.addEventListener('click', () => {
      state.selected = new Set();
      saveSelectedSources();
      renderSourceList();
    });
  }

  // 表头排序（<button> 天然支持 Enter / Space）
  for (const column of Object.keys(SORT_COLUMNS)) {
    const button = dom.sortButtons[column];
    if (!button) continue;
    button.addEventListener('click', () => handleSortHeader(column));
  }

  // 过滤控件：变更不立即请求
  if (dom.applyFilters) dom.applyFilters.addEventListener('click', applyFilters);
  if (dom.resetFilters) dom.resetFilters.addEventListener('click', resetFilters);
  for (const input of [dom.minSeeders, dom.exclude]) {
    if (!input) continue;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyFilters();
      }
    });
  }
  if (dom.safe) {
    dom.safe.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyFilters();
      }
    });
  }

  // 封面开关：关掉后立刻停止一切第三方查询（不重新搜索，只重渲染当前结果）
  if (dom.covers) {
    dom.covers.addEventListener('change', () => {
      state.coversEnabled = dom.covers.checked === true;
      lsSet(LS_KEYS.covers, state.coversEnabled ? '1' : '0');
      if (!state.coversEnabled) cancelCoverWork();
      renderRows();
    });
  }

  // 重新抓取（跳过服务端缓存）
  if (dom.refreshBtn) {
    dom.refreshBtn.addEventListener('click', () => {
      if (!state.query) return;
      runSearch({ query: state.query, page: state.page, noCache: true });
    });
  }

  // 下载面板：展开才建连接，收起即断开
  if (dom.downloadsToggle) dom.downloadsToggle.addEventListener('click', toggleDownloadsPanel);
  if (dom.downloadsRefresh) dom.downloadsRefresh.addEventListener('click', loadDownloads);

  if (dom.prevPage) {
    dom.prevPage.addEventListener('click', () => {
      if (state.page > 1) runSearch({ query: state.query, page: state.page - 1 });
    });
  }

  if (dom.nextPage) {
    dom.nextPage.addEventListener('click', () => {
      runSearch({ query: state.query, page: state.page + 1 });
    });
  }
}

function buildSortHeaderControls() {
  for (const column of Object.keys(SORT_COLUMNS)) {
    const idSuffix = column;
    dom.sortButtons[column] = $('th-sort-' + idSuffix);
    dom.sortHeaders[column] = $('th-' + (column === 'title' ? 'title' : idSuffix));
    const button = dom.sortButtons[column];
    if (!button) continue;
    const arrow = el('span', { class: 'sort-arrow', attrs: { 'aria-hidden': 'true' } });
    button.appendChild(arrow);
    dom.sortArrows[column] = arrow;
  }
}

function cacheDom() {
  dom.searchForm = $('search-form');
  dom.searchInput = $('q');
  dom.searchBtn = $('search-btn');
  dom.sort = $('sort');
  dom.pageSize = $('page-size');
  dom.sourceList = $('source-list');
  dom.sourceCount = $('source-count');
  dom.selectAll = $('select-all');
  dom.selectNone = $('select-none');
  dom.minSeeders = $('min-seeders');
  dom.exclude = $('exclude');
  dom.safe = $('safe');
  dom.covers = $('covers');
  dom.applyFilters = $('apply-filters');
  dom.resetFilters = $('reset-filters');
  dom.alertSlot = $('alert-slot');
  dom.sourceStatusPanel = $('source-status-panel');
  dom.sourceStatusList = $('source-status-list');
  dom.resultSummary = $('result-summary');
  dom.filterNote = $('filter-note');
  dom.cacheNote = $('cache-note');
  dom.refreshBtn = $('refresh-btn');
  dom.results = $('results');
  dom.emptyState = $('empty-state');
  dom.loading = $('loading');
  dom.skeletonRows = $('skeleton-rows');
  dom.noResults = $('no-results');
  dom.resultsTable = $('results-table');
  dom.resultsBody = $('results-body');
  dom.pagination = $('pagination');
  dom.pageInfo = $('page-info');
  dom.prevPage = $('prev-page');
  dom.nextPage = $('next-page');
  dom.examples = $('examples');
  dom.toast = $('toast');
  dom.serviceDot = $('service-dot');
  dom.serviceText = $('service-text');
  dom.downloadsPanel = $('downloads-panel');
  dom.downloadsToggle = $('downloads-toggle');
  dom.downloadsCaret = $('downloads-caret');
  dom.downloadsBadge = $('downloads-badge');
  dom.downloadsDir = $('downloads-dir');
  dom.downloadsRefresh = $('downloads-refresh');
  dom.downloadsBody = $('downloads-body');
  dom.downloadsAlert = $('downloads-alert');
  dom.downloadsList = $('downloads-list');
  buildSortHeaderControls();
}

function urlQuery() {
  try {
    return new URL(window.location.href).searchParams.get('q') || '';
  } catch {
    return '';
  }
}

async function init() {
  cacheDom();
  restorePrefs();
  renderExamples();
  bindEvents();
  updateSortIndicators();
  setView('empty');
  setLoading(false);

  // 先加载数据源（搜索时要用到勾选状态），失败也不阻塞搜索
  await loadSources();

  const initialQuery = urlQuery().trim();
  if (initialQuery) {
    if (dom.searchInput) dom.searchInput.value = initialQuery;
    await runSearch({ query: initialQuery, page: 1, updateUrl: false });
  }

  checkHealth();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
