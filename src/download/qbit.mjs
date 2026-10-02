/**
 * qBittorrent 桥接：把下载任务交给本机的 qBittorrent（Web API v2）。
 *
 * 为什么要有这个桥：内置引擎在受限网络（代理 TUN/机场拦 P2P）下无法下载，
 * 而 qBittorrent 自带 MSE 协议加密、更完善的 peer 策略——用户的网络若只是
 * DPI 拦明文握手，qBittorrent 往往能下。工具负责「找到资源」，qB 负责下载。
 *
 * 配置来源（依次）：
 *   1. 显式参数 / CLI --qb-url
 *   2. 环境变量 TORRENT_SEARCH_QBITTORRENT（形如 http://127.0.0.1:8080[|用户名|密码]）
 *   3. 默认 http://127.0.0.1:8080
 */

import crypto from 'node:crypto';

const DEFAULT_URL = 'http://127.0.0.1:8080';

/**
 * @typedef {object} QbitConfig
 * @property {string} baseUrl 形如 http://127.0.0.1:8080
 * @property {string} username
 * @property {string} password
 */

/**
 * 解析配置字符串 "url[|user|pass]"。
 *
 * @param {string|null|undefined} raw
 * @returns {QbitConfig}
 */
export function parseQbitConfig(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { baseUrl: DEFAULT_URL, username: 'admin', password: '' };

  const parts = text.split('|');
  const baseUrl = parts[0].replace(/\/+$/, '');
  return {
    baseUrl: /^https?:\/\//.test(baseUrl) ? baseUrl : `http://${baseUrl}`,
    username: parts[1] ?? 'admin',
    password: parts[2] ?? '',
  };
}

/**
 * 从常见安装位置找 qBittorrent.exe。
 *
 * @returns {Promise<string|null>}
 */
export async function findQbittorrentExe() {
  const candidates = [
    'C:\\Program Files\\qBittorrent\\qbittorrent.exe',
    'C:\\Program Files (x86)\\qBittorrent\\qbittorrent.exe',
    `${process.env.LOCALAPPDATA}\\Programs\\qBittorrent\\qbittorrent.exe`,
  ];
  const { access } = await import('node:fs/promises');

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/**
 * qBittorrent 客户端（自动登录与 Cookie 维护）。
 */
export class QbitClient {
  /** @param {QbitConfig} config */
  constructor(config) {
    this.config = config;
    /** @type {string|null} */
    this.cookie = null;
  }

  /**
   * 登录（LocalHostAuth 关闭时也能成功，用于拿 Cookie）。
   *
   * @returns {Promise<boolean>}
   */
  async login() {
    const body = new URLSearchParams({
      username: this.config.username,
      password: this.config.password,
    });

    const response = await fetch(`${this.config.baseUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });

    const text = await response.text();
    if (!response.ok || text.trim() !== 'Ok.') {
      throw new Error(`qBittorrent 登录失败（HTTP ${response.status}）：${text.slice(0, 80)}`);
    }

    const setCookie = response.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/SID=([^;]+)/);
    this.cookie = match ? `SID=${match[1]}` : null;
    return true;
  }

  /**
   * 带鉴权请求。
   *
   * @param {string} path
   * @param {{method?: string, body?: string|URLSearchParams, form?: URLSearchParams, retry?: boolean}} [options]
   */
  async request(path, options = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (options.form) headers['content-type'] = 'application/x-www-form-urlencoded';

    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.form ? options.form.toString() : options.body,
      signal: AbortSignal.timeout(8000),
    });

    // 403 = Cookie 过期，重新登录一次
    if (response.status === 403 && options.retry !== false) {
      await this.login();
      return this.request(path, { ...options, retry: false });
    }

    return response;
  }

  /**
   * 服务是否可用（能拿到版本号即认为可用）。
   *
   * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
   */
  async ping() {
    try {
      await this.login();
      const response = await this.request('/api/v2/app/version');
      const version = await response.text();
      return { ok: response.ok, version: version.trim() };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  /**
   * 添加磁力下载。
   *
   * @param {{magnet: string, savePath?: string, category?: string}} params
   * @returns {Promise<{ok: boolean, duplicate?: boolean, error?: string}>}
   */
  async addMagnet({ magnet, savePath, category }) {
    await this.login();

    const form = new URLSearchParams({ urls: magnet });
    if (savePath) form.set('savepath', savePath);
    if (category) form.set('category', category);

    const response = await this.request('/api/v2/torrents/add', { method: 'POST', form });
    const text = await response.text();

    // qB 对重复任务返回 200 + "Fails."（也与其它失败共用），以 torrents 列表复核
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 80)}` };
    if (text.trim() === 'Fails.') return { ok: false, error: 'qBittorrent 拒绝了该磁力' };
    return { ok: true };
  }

  /**
   * 列出任务（可按 category 过滤）。
   *
   * @param {{category?: string, hash?: string}} [options]
   * @returns {Promise<Array<any>>}
   */
  async listTorrents(options = {}) {
    const params = new URLSearchParams();
    if (options.category) params.set('category', options.category);
    if (options.hash) params.set('hashes', options.hash);

    const query = params.toString();
    const response = await this.request(`/api/v2/torrents/info${query ? `?${query}` : ''}`);
    if (!response.ok) throw new Error(`获取任务列表失败（HTTP ${response.status}）`);
    return response.json();
  }

  /**
   * 删除任务。
   *
   * @param {string} hash
   * @param {{deleteFiles?: boolean}} [options]
   */
  async deleteTorrent(hash, options = {}) {
    const form = new URLSearchParams({
      hashes: hash,
      deleteFiles: options.deleteFiles ? 'true' : 'false',
    });
    const response = await this.request('/api/v2/torrents/delete', { method: 'POST', form });
    if (!response.ok) throw new Error(`删除失败（HTTP ${response.status}）`);
  }

  /**
   * 取某个任务的文件列表（用于完成后展示）。
   *
   * @param {string} hash
   * @returns {Promise<Array<{path: string, length: number, progress: number}>>}
   */
  async files(hash) {
    const response = await this.request(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`);
    if (!response.ok) return [];

    const list = await response.json();
    return (Array.isArray(list) ? list : []).map((file) => ({
      path: String(file.name ?? ''),
      length: Number(file.size ?? 0),
      progress: Number(file.progress ?? 0),
    }));
  }

  /**
   * 暂停 / 恢复。
   */
  async pause(hash) {
    await this.request('/api/v2/torrents/pause', { method: 'POST', form: new URLSearchParams({ hashes: hash }) });
  }

  async resume(hash) {
    await this.request('/api/v2/torrents/resume', { method: 'POST', form: new URLSearchParams({ hashes: hash }) });
  }
}

/** qBittorrent 的任务状态 → 本项目的任务状态 */
const QB_STATE_MAP = {
  // 下载中
  downloading: 'downloading',
  forcedDL: 'downloading',
  metaDL: 'metadata',
  forcedMetaDL: 'metadata',
  allocating: 'downloading',
  checkingDL: 'downloading',
  checkingResumeData: 'downloading',
  stalledDL: 'downloading',
  queuedDL: 'queued',
  moving: 'downloading',
  // 已完成（qB 里"完成"表现为做种中）
  uploading: 'done',
  forcedUP: 'done',
  stalledUP: 'done',
  queuedUP: 'done',
  // 暂停
  pausedDL: 'paused',
  pausedUP: 'paused',
  stoppedDL: 'paused',
  stoppedUP: 'paused',
  // 失败
  error: 'failed',
  missingFiles: 'failed',
  unknown: 'failed',
};

/**
 * 把 qBittorrent 的任务状态映射成本项目的状态。
 *
 * @param {string} state
 * @returns {string}
 */
export function mapQbitState(state) {
  return QB_STATE_MAP[String(state)] ?? 'downloading';
}

/**
 * 把一个 qBittorrent 任务对象映射成本项目的任务进度字段。
 *
 * 字段对应关系（qB → 本项目）：
 *   size × progress → bytesDone；dlspeed → speed；
 *   num_seeds + num_leechs → peersConnected（已连上的）；
 *   num_complete + num_incomplete → peersAvailable（整个 swarm 的）。
 *
 * @param {any} torrent
 * @returns {{status: string, phase: string, name: string, totalBytes: number, bytesDone: number, speed: number, peersConnected: number, peersAvailable: number, pieceCount: number, piecesDone: number, savePath: string|null}}
 */
export function mapQbitTorrent(torrent) {
  const size = Number(torrent?.size ?? 0);
  const progress = Math.min(1, Math.max(0, Number(torrent?.progress ?? 0)));
  const status = mapQbitState(torrent?.state);

  return {
    status,
    phase: String(torrent?.state ?? ''),
    name: String(torrent?.name ?? ''),
    totalBytes: Number.isFinite(size) ? size : 0,
    bytesDone: Number.isFinite(size) ? Math.round(size * progress) : 0,
    speed: Number(torrent?.dlspeed ?? 0) || 0,
    peersConnected: (Number(torrent?.num_seeds ?? 0) || 0) + (Number(torrent?.num_leechs ?? 0) || 0),
    peersAvailable: (Number(torrent?.num_complete ?? 0) || 0) + (Number(torrent?.num_incomplete ?? 0) || 0),
    pieceCount: Number(torrent?.pieces_num ?? 0) || 0,
    piecesDone: Number(torrent?.pieces_have ?? 0) || 0,
    savePath: torrent?.save_path ? String(torrent.save_path) : null,
  };
}

/**
 * 稳定的任务 id（供 manager 引用外部任务）。
 *
 * @param {string} infoHash
 * @returns {string}
 */
export function qbitTaskId(infoHash) {
  return `qb:${crypto.createHash('sha1').update(infoHash).digest('hex').slice(0, 16)}`;
}
