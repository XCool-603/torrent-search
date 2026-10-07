#!/usr/bin/env node
/**
 * 零依赖项目自检（`npm run lint`）。
 *
 * 做两类检查：
 * 1. 语法：对每个 .mjs / .js 文件跑 `node --check`（Web 前端的 ES module 用临时 .mjs 副本检查）。
 * 2. 约定：把「本项目刻意坚持的规则」变成可执行的断言，避免以后被无意破坏：
 *    - 前端不得使用 innerHTML 之类会引入 XSS 的 API，不得引用任何外部资源；
 *    - 数据源模块必须实现统一契约并注册进注册表；
 *    - 运行时不得引入第三方依赖（package.json 不能有 dependencies）。
 *
 * 任何一项失败都以非零码退出。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const problems = [];
const checked = { syntax: 0, rules: 0 };

/**
 * 递归收集文件（跳过 node_modules / .git / .cache）。
 *
 * @param {string} dir
 * @param {(file: string) => boolean} match
 * @returns {Promise<string[]>}
 */
async function collect(dir, match) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.cache') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full, match)));
    else if (match(full)) out.push(full);
  }

  return out;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

async function checkSyntax() {
  const files = await collect(ROOT, (file) => /\.(mjs|js)$/.test(file));

  for (const file of files) {
    const ext = path.extname(file);
    let target = file;
    let temp = null;

    // `node --check` 对 .js 默认按 CommonJS 解析，而 web/app.js 是 ES module，
    // 复制成 .mjs 再检查才能得到正确的语法判定。
    if (ext === '.js') {
      temp = `${file}.lint-${process.pid}.mjs`;
      await fs.copyFile(file, temp);
      target = temp;
    }

    try {
      await execFileAsync(process.execPath, ['--check', target], { windowsHide: true });
      checked.syntax += 1;
    } catch (error) {
      problems.push(`语法错误 ${relative(file)}：${String(error.stderr || error.message).split('\n')[0]}`);
    } finally {
      if (temp) await fs.rm(temp, { force: true });
    }
  }
}

async function checkFrontendRules() {
  const files = ['web/index.html', 'web/app.js', 'web/style.css'];

  for (const name of files) {
    const file = path.join(ROOT, name);
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      problems.push(`缺少前端文件 ${name}`);
      continue;
    }

    // 1) 禁止危险的 DOM API（防 XSS）
    const banned = [
      ['innerHTML', /\.innerHTML\s*=/],
      ['outerHTML', /\.outerHTML\s*=/],
      ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/],
      ['document.write', /document\.write\s*\(/],
      ['eval', /[^.\w]eval\s*\(/],
      ['new Function', /new\s+Function\s*\(/],
    ];
    for (const [label, pattern] of banned) {
      if (pattern.test(content)) problems.push(`${name} 使用了被禁止的 API：${label}`);
    }

    // 2) 禁止外部资源（本项目承诺零外部依赖 / 不泄露请求）
    const external = content.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/gi) ?? [];
    if (external.length > 0) {
      const unique = [...new Set(external)];
      // 注释里提到站点域名是允许的，但 src/href/@import 里不允许
      const inResource = /(?:src|href)\s*=\s*["']https?:\/\//i.test(content) || /@import\s+url\(\s*["']?https?:/i.test(content);
      if (inResource) problems.push(`${name} 引用了外部资源：${unique.join(', ')}`);
    }

    checked.rules += 1;
  }
}

async function checkSourceContract() {
  const { SOURCES } = await import('../src/sources/index.mjs');
  const registryIds = new Set(SOURCES.map((source) => source.id));

  const files = await collect(path.join(ROOT, 'src', 'sources'), (file) => file.endsWith('.mjs'));
  const moduleFiles = files.filter((file) => !file.endsWith('index.mjs') && !file.endsWith('util.mjs'));

  if (moduleFiles.length !== registryIds.size) {
    problems.push(`src/sources 下有 ${moduleFiles.length} 个适配器，但注册表里只有 ${registryIds.size} 个（是否忘了注册？）`);
  }

  for (const file of moduleFiles) {
    // Windows 上动态 import 必须用 file:// URL
    const mod = await import(pathToFileURL(file).href);
    const source = mod.default;
    const name = relative(file);

    if (!source || typeof source !== 'object') {
      problems.push(`${name} 没有 default 导出`);
      continue;
    }
    for (const field of ['id', 'name', 'description', 'homepage']) {
      if (typeof source[field] !== 'string' || source[field] === '') problems.push(`${name} 缺少字段 ${field}`);
    }
    if (typeof source.search !== 'function') problems.push(`${name} 缺少 search() 方法`);
    if (!Array.isArray(source.kinds)) problems.push(`${name} 缺少 kinds 数组`);
    if (typeof source.defaultEnabled !== 'boolean') problems.push(`${name} 的 defaultEnabled 必须是布尔值`);
    if (!registryIds.has(source.id)) problems.push(`${name} 的 id=${source.id} 没有注册进 src/sources/index.mjs`);
    checked.rules += 1;
  }
}

async function checkNoRuntimeDependencies() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  const optional = Object.keys(pkg.optionalDependencies ?? {});
  const peer = Object.keys(pkg.peerDependencies ?? {});

  if (deps.length + optional.length + peer.length > 0) {
    problems.push(`本项目承诺零运行时依赖，但 package.json 里有：${[...deps, ...optional, ...peer].join(', ')}`);
  }
  if (pkg.type !== 'module') problems.push('package.json 的 type 必须是 module');
  checked.rules += 1;
}

/**
 * 源码文件的 BOM 约定。
 *
 * 这两条要求是**相反的**，而且都踩过：
 *     中文被拆坏后连字符串引号都会被吃掉，直接变成语法错误；
 *   - 源码（.mjs/.js）绝不能带 BOM：shebang 前多三个字节就会报语法错误。
 *     .mjs 的 shebang 同样会被破坏（`#!/usr/bin/env node` 前多三个字节就报语法错误）。
 *
 */
async function checkScriptEncodings() {
  const BOM = [0xef, 0xbb, 0xbf];

  const hasBom = (buffer) => buffer.length >= 3 && buffer[0] === BOM[0] && buffer[1] === BOM[1] && buffer[2] === BOM[2];

    // 源码一律不能带 BOM：shebang 前多三个字节就会报语法错误。
  // ② 其它源码一律不能带 BOM
  const SKIP_DIRS = new Set(['.git', '.cache', 'downloads', 'node_modules', 'fixtures']);
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(mjs|js|sh)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (hasBom(await fs.readFile(full))) {
        problems.push(`${path.relative(ROOT, full)} 不应带 UTF-8 BOM（会破坏 shebang / 解析）`);
      }
    }
  };
  await walk(ROOT);

  checked.rules += 1;
}

/**
 * compose 引用的环境变量必须在 .env.example 里有说明。
 *
 * 纯正则实现（不为一条检查引入 YAML 解析依赖），防的是文档腐烂：
 * 加了新变量却忘了写进 .env.example，用户就不知道该调什么。
 * 注释形式的 `# KEY=...` 也算已说明——可选项就是这么写的。
 */
async function checkComposeEnvDocs() {
  let composeText;
  let envText;
  try {
    composeText = await fs.readFile(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    envText = await fs.readFile(path.join(ROOT, '.env.example'), 'utf8');
  } catch {
    problems.push('缺少 docker-compose.yml 或 .env.example');
    checked.rules += 1;
    return;
  }

  const documented = new Set();
  for (const line of envText.split(/\r?\n/)) {
    const match = line.trim().match(/^#?\s*([A-Z0-9_]+)=/);
    if (match) documented.add(match[1]);
  }

  const referenced = new Set();
  for (const match of composeText.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)) referenced.add(match[1]);

  for (const key of referenced) {
    if (!documented.has(key)) {
      problems.push(`docker-compose.yml 引用了 ${key}，但 .env.example 里没有说明`);
    }
  }

  checked.rules += 1;
}

async function main() {
  await checkSyntax();
  await checkFrontendRules();
  await checkSourceContract();
  await checkNoRuntimeDependencies();
  await checkScriptEncodings();
  await checkComposeEnvDocs();

  process.stdout.write(`语法检查：${checked.syntax} 个文件\n`);
  process.stdout.write(`规则检查：${checked.rules} 项\n`);

  if (problems.length > 0) {
    process.stdout.write(`\n发现 ${problems.length} 个问题：\n${problems.map((problem) => `  ✗ ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n全部通过。\n');
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
