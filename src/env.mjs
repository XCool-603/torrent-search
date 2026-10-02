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
