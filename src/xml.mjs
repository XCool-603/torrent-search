/**
 * 极简 XML 解析器（零依赖）。
 *
 * 为什么自己写：项目目标是零运行时依赖，而 RSS 是这些站点最稳定的公开接口
 * （nyaa / mikan / dmhy / academictorrents 都提供 RSS）。
 * 只需要支持 RSS 用到的子集：元素、属性、CDATA、注释、处理指令、DOCTYPE、自闭合标签、实体。
 * 不做的事情：命名空间校验、schema 校验、DTD、实体定义。
 *
 * 命名空间用「本地名」处理：nyaa:seeders 与 seeders 等价，取冒号后的部分。
 */

/**
 * 解析 XML 文本为节点树。
 *
 * @param {string} xml
 * @returns {{name: string, attrs: Record<string, string>, children: any[], text: string}|null} 根节点（#root 包裹）
 */
export function parseXml(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') return null;

  const root = createNode('#root');
  const stack = [root];
  const len = xml.length;
  let i = 0;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], xml.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], xml.slice(i, lt));

    // 注释
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // CDATA
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const raw = xml.slice(lt + 9, end === -1 ? len : end);
      appendRaw(stack[stack.length - 1], raw);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // 处理指令 <?xml ... ?>
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // DOCTYPE 等 <! ... >，可能带内部子集 [ ... ]
    if (xml.startsWith('<!', lt)) {
      let depth = 0;
      let j = lt + 2;
      for (; j < len; j += 1) {
        const char = xml[j];
        if (char === '[') depth += 1;
        else if (char === ']') depth -= 1;
        else if (char === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt + 1);
    if (gt === -1) break;

    const raw = xml.slice(lt + 1, gt);

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
    } else {
      const selfClosing = raw.endsWith('/');
      const { name, attrs } = parseTag(selfClosing ? raw.slice(0, -1) : raw);
      if (name) {
        const node = createNode(name, attrs);
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      }
    }

    i = gt + 1;
  }

  return root;
}

function createNode(name, attrs = {}) {
  return { name, attrs, children: [], text: '' };
}

function appendText(node, text) {
  if (text) node.text += decodeEntities(text);
}

function appendRaw(node, text) {
  if (text) node.text += text;
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i += 1) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function parseTag(body) {
  const nameMatch = body.match(/^\s*([^\s/>]+)/);
  if (!nameMatch) return { name: '', attrs: {} };

  const attrs = {};
  const attrRe = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = attrRe.exec(body)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeEntities(value);
  }

  return { name: nameMatch[1], attrs };
}

/**
 * 解码 XML/HTML 常见实体。
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  if (typeof text !== 'string' || text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : full;
    }
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return full;
    }
  });
}

function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * 去掉命名空间前缀。
 *
 * @param {string} name
 * @returns {string}
 */
export function localName(name) {
  if (typeof name !== 'string') return '';
  const index = name.indexOf(':');
  return index === -1 ? name : name.slice(index + 1);
}

/**
 * 直接子节点（可按本地名过滤，大小写不敏感）。
 *
 * @param {any} node
 * @param {string} [name]
 * @returns {any[]}
 */
export function children(node, name) {
  if (!node || !Array.isArray(node.children)) return [];
  if (!name) return node.children;
  const target = name.toLowerCase();
  return node.children.filter((child) => localName(child.name).toLowerCase() === target);
}

/**
 * 第一个匹配的直接子节点。
 *
 * @param {any} node
 * @param {string} name
 * @returns {any|null}
 */
export function child(node, name) {
  return children(node, name)[0] ?? null;
}

/**
 * 第一个匹配子节点的文本（去首尾空白）。
 *
 * @param {any} node
 * @param {string} name
 * @returns {string|null}
 */
export function textOf(node, name) {
  const found = child(node, name);
  if (!found) return null;
  const text = (found.text ?? '').trim();
  return text === '' ? null : text;
}

/**
 * 按优先级返回第一个存在且非空的子节点文本。
 *
 * @param {any} node
 * @param {string[]} names
 * @returns {string|null}
 */
export function textOfAny(node, names) {
  for (const name of names) {
    const value = textOf(node, name);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 节点属性（大小写不敏感）。
 *
 * @param {any} node
 * @param {string} name
 * @returns {string|null}
 */
export function attr(node, name) {
  if (!node || !node.attrs) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/**
 * 深度优先查找第一个匹配本地名的后代节点。
 *
 * @param {any} node
 * @param {string} name
 * @returns {any|null}
 */
export function findDescendant(node, name) {
  if (!node || !Array.isArray(node.children)) return null;
  const target = name.toLowerCase();
  for (const childNode of node.children) {
    if (localName(childNode.name).toLowerCase() === target) return childNode;
    const found = findDescendant(childNode, target);
    if (found) return found;
  }
  return null;
}
