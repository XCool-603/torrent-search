/**
 * 数据源注册表。
 *
 * 新增一个源只需要：
 * 1. 写一个模块，default 导出 {id, name, description, homepage, kinds, defaultEnabled, search(query, ctx)}
 * 2. 在下面 import 并加进 SOURCES
 * 其它地方（CLI、Web API、聚合、测试）会自动看到它。
 */

import apibay from './apibay.mjs';
import nyaa from './nyaa.mjs';
import bitsearch from './bitsearch.mjs';
import mikan from './mikan.mjs';
import dmhy from './dmhy.mjs';
import academic from './academic.mjs';
import demo from './demo.mjs';

export const SOURCES = [apibay, nyaa, bitsearch, mikan, dmhy, academic, demo];

export const SOURCE_MAP = new Map(SOURCES.map((source) => [source.id, source]));

/**
 * 供 API/CLI 展示的源元信息（不含函数）。
 *
 * @returns {Array<{id: string, name: string, description: string, homepage: string, kinds: string[], defaultEnabled: boolean, offline: boolean}>}
 */
export function listSources() {
  return SOURCES.map((source) => ({
    id: source.id,
    name: source.name,
    description: source.description,
    homepage: source.homepage,
    kinds: source.kinds ?? [],
    defaultEnabled: source.defaultEnabled !== false,
    offline: source.offline === true,
  }));
}

/**
 * @param {string} id
 * @returns {any|null}
 */
export function getSource(id) {
  return SOURCE_MAP.get(String(id)) ?? null;
}

/**
 * 把用户输入的源选择解析成源对象数组。
 *
 * @param {string|string[]|null|undefined} selector
 *   - 空 / 'all' / '*'：全部源
 *   - 'default'：默认启用的源
 *   - 'a,b' 或 ['a','b']：指定源
 * @returns {{sources: any[], unknown: string[]}}
 */
export function resolveSources(selector) {
  if (selector === null || selector === undefined || selector === '' || selector === 'all' || selector === '*') {
    return { sources: [...SOURCES], unknown: [] };
  }

  if (selector === 'default') {
    return { sources: SOURCES.filter((source) => source.defaultEnabled !== false), unknown: [] };
  }

  const ids = (Array.isArray(selector) ? selector : String(selector).split(','))
    .map((id) => String(id).trim())
    .filter(Boolean);

  const sources = [];
  const unknown = [];
  for (const id of ids) {
    const source = SOURCE_MAP.get(id);
    if (source) sources.push(source);
    else unknown.push(id);
  }

  return { sources, unknown };
}

export { apibay, nyaa, bitsearch, mikan, dmhy, academic, demo };
