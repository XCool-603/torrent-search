/**
 * 运行时环境适配（本机 / 容器）。
 *
 * 为什么需要单独一层：同一个服务在本机跑和在容器里跑，默认值应该不同——
 *   - 容器里必须绑 0.0.0.0，否则端口映射进不来；
 *   - 容器里的 127.0.0.1 指向容器自己，连宿主机的 qBittorrent 要用 host.docker.internal；
 *   - 容器里看不到宿主机的 TUN 网卡，网络诊断不能因此误报"没问题"。
 *
 * 所有默认值都可以用环境变量覆盖（TORRENT_SEARCH_* 前缀）。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 判断是否运行在容器里。
 *
 * 依据（按可靠性排序）：显式环境变量 > /.dockerenv > /proc/1/cgroup 关键字。
 * 显式变量同时用于测试注入与用户强制指定。
 *
 * @param {{fileExists?: (path: string) => boolean, readCgroup?: (path: string) => string|null}} [options]
 * @returns {boolean}
 */
export function detectContainer(options = {}) {
  if (process.env.TORRENT_SEARCH_CONTAINER === '1') return true;
  if (process.env.TORRENT_SEARCH_CONTAINER === '0') return false;

  const fileExists = options.fileExists ?? ((path) => {
    try {
      return fs.existsSync(path);
    } catch {
      return false;
    }
  });
  if (fileExists('/.dockerenv')) return true;

  const readCgroup = options.readCgroup ?? ((path) => {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  });
  const cgroup = readCgroup('/proc/1/cgroup');
  return typeof cgroup === 'string' && /docker|containerd|kubepods|podman|libpod/i.test(cgroup);
}

/**
 * 读字符串环境变量（空串视为未设置）。
 *
 * @param {string} name
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
export function envString(name, fallback = null) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === '') return fallback;
  return String(value).trim();
}

/**
 * 读整数环境变量（非法值回退）。
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function envInt(name, fallback) {
  const raw = envString(name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 读布尔环境变量（1/true/yes/on 为真，0/false/no/off 为假）。
 *
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function envBool(name, fallback) {
  const raw = envString(name, null);
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

/**
 * 监听地址默认值：容器里必须 0.0.0.0（否则端口映射无效），本机默认只绑回环（更安全）。
 *
 * @param {{inContainer?: boolean}} [options]
 * @returns {string}
 */
export function resolveHostDefault(options = {}) {
  const explicit = envString('TORRENT_SEARCH_HOST', null);
  if (explicit !== null) return explicit;
  const inContainer = options.inContainer ?? detectContainer();
  return inContainer ? '0.0.0.0' : '127.0.0.1';
}

/**
 * 端口默认值。
 *
 * @returns {number}
 */
export function resolvePortDefault() {
  return envInt('TORRENT_SEARCH_PORT', 8787);
}

/**
 * qBittorrent 地址默认值：容器里指向宿主机（host.docker.internal），本机指向回环。
 *
 * @param {{inContainer?: boolean}} [options]
 * @returns {string}
 */
export function resolveQbitDefault(options = {}) {
  const explicit = envString('TORRENT_SEARCH_QBITTORRENT', null);
  if (explicit !== null) return explicit;
  const inContainer = options.inContainer ?? detectContainer();
  return inContainer ? 'http://host.docker.internal:8080' : 'http://127.0.0.1:8080';
}

/**
 * 下载后端默认值（auto/builtin/qbittorrent）。
 *
 * @returns {string}
 */
export function resolveBackendDefault() {
  return envString('TORRENT_SEARCH_BACKEND', 'auto');
}

/**
 * 下载目录默认值（容器里建议挂卷到 /downloads）。
 *
 * @returns {string|null}
 */
export function resolveDownloadDirOverride() {
  return envString('TORRENT_SEARCH_DOWNLOAD_DIR', null);
}

/**
 * 解析 .env 文本成键值对。
 *
 * 规则与 docker compose 的 .env 保持一致（够用即可，不追求完整实现）：
 *   - 忽略空行与 # 注释；
 *   - 支持 `export KEY=VALUE` 前缀；
 *   - 值两端的成对引号会被去掉（引号内的 # 不当注释）；
 *   - 不做变量插值（${...} 原样保留）。
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const values = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // 未加引号时，行内的 # 视为注释
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    values[key] = value;
  }

  return values;
}

/**
 * 读取 .env 文件并把其中的变量注入 process.env。
 *
 * 为什么需要：Docker 部署走 `docker compose`，它会自动读 .env；而**本地直接跑**
 * （`node bin/magnet-search.mjs serve`）以前完全不读，于是同一个 .env 在容器里生效、
 * 在本地被静默忽略 —— 想改端口/下载目录时，两种跑法的行为不一致，很难排查。
 *
 * **已有的环境变量优先**（只填 process.env 里没有的键），这样命令行上
 * `TORRENT_SEARCH_PORT=9000 node bin/...` 仍然能覆盖 .env。
 *
 * @param {{cwd?: string, file?: string, env?: NodeJS.ProcessEnv, logger?: (message: string) => void}} [options]
 * @returns {string[]} 实际注入的键名（供测试与日志使用）
 */
export function loadEnvFile(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const file = options.file ?? path.join(cwd, '.env');
  const logger = options.logger ?? (() => {});

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // 没有 .env 是正常情况
  }

  const applied = [];
  for (const [key, value] of Object.entries(parseEnvText(text))) {
    if (env[key] !== undefined && env[key] !== '') continue; // 显式设置优先
    env[key] = value;
    applied.push(key);
  }

  if (applied.length > 0) logger(`已从 .env 读取 ${applied.length} 项配置：${applied.join(', ')}`);
  return applied;
}
