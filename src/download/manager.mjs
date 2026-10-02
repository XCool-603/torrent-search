/**
 * 下载任务管理器：排队、并发上限、进度事件、取消、持久化。
 *
 * 职责边界：只做"任务调度 + 状态"，真正的 BT 协议在 src/bt/engine.mjs。
 * 这样以后想接 aria2 / qBittorrent 这类外部下载器，只要换掉 run() 里的执行体。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

import { download as engineDownload } from '../bt/engine.mjs';
import { parseMagnetInput } from '../magnet.mjs';
import { shortHash, buildMagnet } from '../magnet.mjs';
import { QbitClient, parseQbitConfig, mapQbitTorrent } from './qbit.mjs';
import { normalizeTrackers } from '../bt/engine.mjs';

/** 任务状态：queued → metadata → downloading → done / failed / cancelled / interrupted / stopped / paused */
export const TASK_STATUS = ['queued', 'metadata', 'downloading', 'done', 'failed', 'cancelled', 'interrupted', 'stopped', 'paused'];

/** 具体后端（任务最终只会是这两个之一） */
export const BACKENDS = ['builtin', 'qbittorrent'];

/**
 * 允许用户选择的后端（多一个 auto = 有 qBittorrent 就用它）。
 * 注意区分：BACKENDS 是"最终落地的后端"，BACKEND_CHOICES 是"用户可选值"。
 * 早期版本混用两者，导致 backend:'auto' 被静默降级成 builtin（被测试抓到）。
 */
export const BACKEND_CHOICES = [...BACKENDS, 'auto'];

/**
 * 默认下载目录。
 *
 * @returns {string}
 */
export function defaultDownloadDir() {
  const fromEnv = process.env.TORRENT_SEARCH_DOWNLOAD_DIR;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), 'Downloads', 'torrent-search');
}

export class DownloadManager extends EventEmitter {
  /**
   * @param {{
   *   dir?: string,
   *   maxConcurrent?: number,
   *   maxBytes?: number,
   *   limitSpeed?: number|null,    // 全局下载限速（字节/秒），null = 不限
   *   useDefaultTrackers?: boolean,
   *   useDht?: boolean,                          // 是否允许内置引擎用 DHT 回退
   *   backend?: 'builtin'|'qbittorrent'|'auto',  // auto = qBittorrent 可用就用它
   *   qbit?: string|QbitClient|null,             // "http://127.0.0.1:8080|admin|密码" 或现成客户端
   *   persistFile?: string|null,
   *   logger?: (msg: string) => void,
   *   engine?: Function,
   * }} [options]
   */
  constructor(options = {}) {
    super();
    this.dir = path.resolve(options.dir ?? defaultDownloadDir());
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.maxBytes = options.maxBytes ?? 0;
    this.limitSpeed = options.limitSpeed ?? 0;
    this.useDefaultTrackers = options.useDefaultTrackers !== false;
    this.useDht = options.useDht !== false;

    // 后端选择：builtin（内置引擎）/ qbittorrent（外部客户端）/ auto（有 qB 就用 qB）
    this.backend = BACKEND_CHOICES.includes(options.backend) ? options.backend : 'builtin';
    /** @type {QbitClient|null} */
    this.qbit = options.qbit instanceof QbitClient
      ? options.qbit
      : options.qbit
        ? new QbitClient(parseQbitConfig(options.qbit))
        : null;
    /** qBittorrent 可用性缓存（避免每个任务都 ping 一次） */
    this.qbitStatus = null;
    this.persistFile = options.persistFile ?? null;
    this.logger = options.logger ?? (() => {});
    this.engine = options.engine ?? engineDownload;

    /** @type {Map<string, any>} */
    this.tasks = new Map();
    /** @type {Set<string>} */
    this.running = new Set();
    this.sequence = 0;
  }

  /**
   * 面向外部的任务快照（去掉内部字段，方便 JSON 序列化与 SSE 推送）。
   *
   * @param {any} task
   * @returns {any}
   */
  snapshot(task) {
    return {
      id: task.id,
      infoHash: task.infoHash,
      name: task.name,
      magnet: task.magnet,
      trackers: task.trackers,
      dir: task.dir,
      status: task.status,
      phase: task.phase,
      totalBytes: task.totalBytes,
      bytesDone: task.bytesDone,
      piecesDone: task.piecesDone,
      pieceCount: task.pieceCount,
      progress: task.totalBytes > 0 ? Math.min(1, task.bytesDone / task.totalBytes) : 0,
      speed: task.speed,
      peersConnected: task.peersConnected,
      peersAvailable: task.peersAvailable,
      files: task.files,
      error: task.error,
      backend: task.backend,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    };
  }

  /**
   * 检测 qBittorrent 是否可用（结果缓存 30 秒）。
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
   */
  async checkQbit(options = {}) {
    if (!this.qbit) return { ok: false, error: '未配置 qBittorrent 地址' };

    const cached = this.qbitStatus;
    if (!options.force && cached && Date.now() - cached.at < 30_000) return cached.value;

    const value = await this.qbit.ping();
    this.qbitStatus = { at: Date.now(), value };
    return value;
  }

  /**
   * 决定这次任务用哪个后端。
   *
   * @param {string|undefined} requested
   * @returns {Promise<'builtin'|'qbittorrent'>}
   */
  async resolveBackend(requested) {
    const wanted = BACKEND_CHOICES.includes(requested) ? requested : this.backend;

    if (wanted === 'qbittorrent') return 'qbittorrent';
    if (wanted === 'builtin') return 'builtin';

    // auto：qBittorrent 可用就交给它（它的 peer 策略与协议加密更完善）
    const status = await this.checkQbit();
    return status.ok ? 'qbittorrent' : 'builtin';
  }

  /**
   * 全部任务（按创建顺序）。
   *
   * @returns {any[]}
   */
  list() {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).map((task) => this.snapshot(task));
  }

  /**
   * @param {string} id
   * @returns {any|null}
   */
  get(id) {
    const task = this.tasks.get(id);
    return task ? this.snapshot(task) : null;
  }

  /**
   * 校验任务目录：必须位于默认下载目录之内（或就是它本身）。
   *
   * 安全考虑：/api/downloads 的 dir 参数来自请求体。若允许任意路径，
   * 恶意网页（即使有同源策略保护，本机其它程序也可能误用）可以让引擎往
   * 系统任意可写位置写文件。这里强制收敛到下载根目录之下。
   *
   * @param {string|undefined} requested
   * @returns {string}
   */
  resolveTaskDir(requested) {
    if (!requested) return this.dir;
    const target = path.resolve(String(requested));
    if (target !== this.dir && !target.startsWith(this.dir + path.sep)) {
      throw new Error(`保存目录必须在下载根目录之内：${this.dir}`);
    }
    return target;
  }

  /**
   * 新建下载任务（立即返回，后台执行）。
   *
   * 注意：`backend: 'auto'` 的探测放在 run() 里做（运行时关注点），
   * 所以 add() 保持同步——调用方不必 await，也让 CLI/API/测试的调用点保持简单。
   *
   * @param {{input: string, dir?: string, name?: string, maxBytes?: number, backend?: string}} params
   * @returns {any} 任务快照
   */
  add(params) {
    const parsed = parseMagnetInput(params.input);
    const id = `${parsed.infoHash.slice(0, 12)}-${shortHash(`${parsed.infoHash}|${Date.now()}|${this.sequence++}`, 6)}`;

    const existing = [...this.tasks.values()].find(
      (task) => task.infoHash === parsed.infoHash && ['queued', 'metadata', 'downloading'].includes(task.status),
    );
    if (existing) return this.snapshot(existing);

    const requested = params.backend ?? this.backend;
    const task = {
      id,
      infoHash: parsed.infoHash,
      magnet: parsed.magnet,
      trackers: parsed.trackers,
      name: params.name ?? parsed.name ?? parsed.infoHash.slice(0, 12),
      dir: this.resolveTaskDir(params.dir),
      // 可能是 'auto'：run() 里会解析成 builtin 或 qbittorrent
      backend: requested === 'auto' ? 'auto' : (BACKENDS.includes(requested) ? requested : 'builtin'),
      status: 'queued',
      phase: 'queued',
      totalBytes: 0,
      bytesDone: 0,
      piecesDone: 0,
      pieceCount: 0,
      speed: 0,
      peersConnected: 0,
      peersAvailable: 0,
      files: [],
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      maxBytes: params.maxBytes ?? this.maxBytes,
      controller: null,
      qbitTimer: null,
    };

    this.tasks.set(id, task);
    this.logger(`新增下载任务 ${id}：${task.name}（后端 ${task.backend}）`);
    this.emit('added', this.snapshot(task));
    // 统一走 update：SSE/UI 只需要订阅一种事件就能看到包括"新增"在内的全部变化
    this.emit('update', this.snapshot(task));
    this.pump();
    return this.snapshot(task);
  }

  /**
   * 有空闲槽位就启动排队中的任务。
   */
  pump() {
    if (this.running.size >= this.maxConcurrent) return;

    const next = [...this.tasks.values()].find((task) => task.status === 'queued');
    if (!next) return;

    this.running.add(next.id);
    this.run(next)
      .catch((error) => this.logger(`任务 ${next.id} 异常：${error?.message ?? error}`))
      .finally(() => {
        this.running.delete(next.id);
        this.pump();
      });
  }

  /**
   * 执行一个任务。
   *
   * @param {any} task
   */
  async run(task) {
    // 先让出控制权：add() 要在任务还是 queued 状态时返回快照，
    // 否则假引擎/快引擎会在 add 返回之前就把状态改掉（实测踩过）。
    await new Promise((resolve) => setImmediate(resolve));

    // 解析后端（auto 会探测 qBittorrent 是否可用）
    if (task.backend === 'auto') {
      const resolved = await this.resolveBackend('auto');
      task.backend = resolved;
      this.logger(`[${task.id}] 后端选择：${resolved}`);
      this.emit('update', this.snapshot(task));
    }

    task.status = 'metadata';
    task.phase = 'metadata';
    task.startedAt = Date.now();
    task.controller = new AbortController();
    this.emit('update', this.snapshot(task));

    try {
      if (task.backend === 'qbittorrent') {
        await this.runViaQbit(task);
      } else {
        await this.runViaEngine(task);
      }
    } catch (error) {
      const aborted = task.controller?.signal.aborted === true;
      task.status = aborted ? 'cancelled' : 'failed';
      task.phase = task.status;
      task.error = aborted ? '已取消' : (error?.message ?? String(error));
      this.logger(`任务 ${task.id} ${task.status}：${task.error}`);
    } finally {
      if (task.qbitTimer) {
        clearInterval(task.qbitTimer);
        task.qbitTimer = null;
      }
      task.finishedAt = Date.now();
      task.controller = null;
      this.emit('update', this.snapshot(task));
      await this.save();
    }
  }

  /**
   * 用内置引擎下载（原路径）。
   *
   * @param {any} task
   */
  async runViaEngine(task) {
    const result = await this.engine({
      infoHash: task.infoHash,
      trackers: task.trackers,
      dir: task.dir,
      signal: task.controller.signal,
      maxBytes: task.maxBytes,
      limitSpeed: this.limitSpeed > 0 ? this.limitSpeed : undefined,
      useDefaultTrackers: this.useDefaultTrackers,
      useDht: this.useDht,
      logger: (message) => this.logger(`[${task.id}] ${message}`),
      onProgress: (progress) => {
        task.phase = progress.phase;
        task.name = progress.name ?? task.name;
        task.totalBytes = progress.totalBytes ?? task.totalBytes;
        task.bytesDone = progress.bytesDone ?? task.bytesDone;
        task.piecesDone = progress.piecesDone ?? task.piecesDone;
        task.pieceCount = progress.pieceCount ?? task.pieceCount;
        task.speed = progress.speed ?? task.speed;
        task.peersConnected = progress.peersConnected ?? 0;
        task.peersAvailable = progress.peersAvailable ?? 0;
        if (progress.phase === 'downloading' && task.status === 'metadata') {
          // 状态跃迁必须同时发 update：只发 progress 的话，订阅方（UI/SSE）看不到状态变化
          task.status = 'downloading';
          this.emit('update', this.snapshot(task));
        }
        this.emit('progress', this.snapshot(task));
      },
    });

    task.files = result.files ?? [];
    task.totalBytes = result.totalBytes;
    task.bytesDone = result.downloadedBytes;
    task.pieceCount = result.pieceCount;
    task.status = result.completed ? 'done' : 'stopped';
    task.phase = task.status;
    task.error = result.completed ? null : '达到大小上限后停止';
  }

  /**
   * 用 qBittorrent 下载：添加磁力后轮询它的进度。
   *
   * 与内置引擎的区别：下载真正发生在 qBittorrent 里，我们只做"下单 + 跟踪 + 取消"。
   * 好处是 qB 的 peer 策略与协议加密更完善，受限网络下成功率更高。
   *
   * @param {any} task
   */
  async runViaQbit(task) {
    if (!this.qbit) throw new Error('未配置 qBittorrent 地址');

    const status = await this.checkQbit();
    if (!status.ok) throw new Error(`qBittorrent 不可用：${status.error ?? '无法连接'}`);

    // qBittorrent 只接受磁力链接（不接受裸 hash）；裸 hash 时补上公共 tracker
    let magnet = task.magnet;
    if (!/^magnet:\?/i.test(magnet)) magnet = buildMagnet({ infoHash: task.infoHash });
    const trackers = normalizeTrackers(task.trackers, this.useDefaultTrackers);
    if (!/tr=/.test(magnet) && trackers.length > 0) {
      magnet = buildMagnet({ infoHash: task.infoHash, name: task.name, trackers });
    }

    this.logger(`[${task.id}] 交给 qBittorrent（保存到 ${task.dir}）`);
    const added = await this.qbit.addMagnet({ magnet, savePath: task.dir });
    if (!added.ok) throw new Error(`qBittorrent 添加失败：${added.error ?? '未知原因'}`);

    task.status = 'downloading';
    task.phase = 'qBittorrent';
    this.emit('update', this.snapshot(task));

    // 轮询直到完成/失败/取消
    await new Promise((resolve, reject) => {
      let polls = 0;

      const poll = async () => {
        if (task.controller?.signal.aborted) {
          // 取消：从 qB 移除任务但保留文件（与内置引擎的取消语义一致）
          await this.qbit.deleteTorrent(task.infoHash, { deleteFiles: false }).catch(() => {});
          reject(new Error('已取消'));
          return;
        }

        try {
          const list = await this.qbit.listTorrents({ hash: task.infoHash });
          const torrent = Array.isArray(list) ? list[0] : null;

          if (!torrent) {
            // 刚添加时可能还没出现，给它几次机会
            if (polls++ < 5) return;
            reject(new Error('qBittorrent 中没有找到该任务（可能被它的规则过滤）'));
            return;
          }

          const mapped = mapQbitTorrent(torrent);
          task.name = mapped.name || task.name;
          task.totalBytes = mapped.totalBytes;
          task.bytesDone = mapped.bytesDone;
          task.speed = mapped.speed;
          task.peersConnected = mapped.peersConnected;
          task.peersAvailable = mapped.peersAvailable;
          task.pieceCount = mapped.pieceCount;
          task.piecesDone = mapped.piecesDone;
          task.phase = mapped.phase;

          if (mapped.status !== task.status) {
            task.status = mapped.status;
            this.emit('update', this.snapshot(task));
          }
          this.emit('progress', this.snapshot(task));

          if (mapped.status === 'done') {
            task.files = await this.qbit.files(task.infoHash).catch(() => []);
            resolve();
            return;
          }
          if (mapped.status === 'failed') {
            reject(new Error(`qBittorrent 报告失败（状态：${mapped.phase}）`));
            return;
          }
        } catch (error) {
          this.logger(`[${task.id}] 查询 qBittorrent 失败：${error?.message ?? error}`);
        }
      };

      task.qbitTimer = setInterval(() => {
        poll().catch(() => {});
      }, 1000);
      poll().catch(() => {});
    });
  }

  /**
   * 取消任务（排队中的直接取消，运行中的中断连接）。
   *
   * @param {string} id
   * @returns {boolean}
   */
  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;

    if (['done', 'failed', 'cancelled', 'stopped'].includes(task.status)) return false;

    if (task.status === 'queued') {
      task.status = 'cancelled';
      task.phase = 'cancelled';
      task.finishedAt = Date.now();
      this.emit('update', this.snapshot(task));
      this.save().catch(() => {});
      return true;
    }

    task.controller?.abort();
    return true;
  }

  /**
   * 删除任务记录（可选连同已下载文件）。
   *
   * @param {string} id
   * @param {{deleteFiles?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async remove(id, options = {}) {
    const task = this.tasks.get(id);
    if (!task) return false;

    this.cancel(id);

    // qBittorrent 任务：删除委托给它（文件保留与否由 deleteFiles 决定）
    if (task.backend === 'qbittorrent' && this.qbit) {
      try {
        await this.qbit.deleteTorrent(task.infoHash, { deleteFiles: options.deleteFiles === true });
      } catch (error) {
        this.logger(`从 qBittorrent 删除任务失败（忽略）：${error?.message ?? error}`);
      }
    }

    if (task.qbitTimer) clearInterval(task.qbitTimer);
    this.tasks.delete(id);

    if (options.deleteFiles && task.backend !== 'qbittorrent' && task.files.length > 0) {
      const dir = task.dir;
      for (const file of task.files) {
        const target = path.resolve(dir, file.path);
        // 只删自己下载目录里的东西
        if (!target.startsWith(path.resolve(dir) + path.sep)) continue;
        await fs.rm(target, { force: true }).catch(() => {});
      }
    }

    this.emit('removed', { id });
    await this.save();
    return true;
  }

  /**
   * 从磁盘恢复任务列表（未完成的一律标记为 interrupted）。
   *
   * @param {{autoResume?: boolean}} [options] autoResume = 启动时自动重新入队未完成的任务
   * @returns {Promise<number>} 恢复的任务数
   */
  async load(options = {}) {
    if (!this.persistFile) return 0;

    let restored = 0;
    try {
      const raw = await fs.readFile(this.persistFile, 'utf8');
      const data = JSON.parse(raw);
      for (const saved of data.tasks ?? []) {
        if (!saved?.id || !saved?.infoHash) continue;
        const wasRunning = ['queued', 'metadata', 'downloading'].includes(saved.status);
        const status = wasRunning ? 'interrupted' : saved.status;
        this.tasks.set(saved.id, {
          ...saved,
          status,
          phase: status,
          speed: 0,
          peersConnected: 0,
          peersAvailable: 0,
          controller: null,
          qbitTimer: null,
          // 重新入队时进度归零：内置引擎会先校验磁盘上的已有分片再续传
          bytesDone: wasRunning ? 0 : (saved.bytesDone ?? 0),
          piecesDone: wasRunning ? 0 : (saved.piecesDone ?? 0),
          error: status === 'interrupted' ? '进程重启导致中断，可重新添加以续传' : (saved.error ?? null),
        });
        restored += 1;
      }
    } catch {
      return 0;
    }

    if (options.autoResume) {
      let resumed = 0;
      for (const task of this.tasks.values()) {
        if (task.status !== 'interrupted') continue;
        task.status = 'queued';
        task.phase = 'queued';
        task.error = null;
        task.finishedAt = null;
        resumed += 1;
      }
      if (resumed > 0) {
        this.logger(`自动续传 ${resumed} 个未完成任务`);
        this.pump();
      }
    }

    return restored;
  }

  /**
   * 持久化任务列表。
   */
  async save() {
    if (!this.persistFile) return;
    try {
      await fs.mkdir(path.dirname(this.persistFile), { recursive: true });
      const tasks = [...this.tasks.values()].map((task) => {
        // controller / qbitTimer 是运行时对象，不能进 JSON
        const { controller, qbitTimer, ...rest } = task;
        return rest;
      });
      await fs.writeFile(this.persistFile, JSON.stringify({ version: 1, tasks }, null, 2), 'utf8');
    } catch (error) {
      this.logger(`保存任务列表失败（忽略）：${error.message}`);
    }
  }

  /**
   * 等待所有运行中的任务结束（测试与 CLI 一次性下载用）。
   *
   * 为什么轮询而不是监听 update 事件：run() 的收尾顺序是
   * 「emit('update') → finally 里 running.delete() → pump()」，
   * 最后一次 update 发出时任务还在 running 里；等 waitForIdle 回头检查时，
   * 事件已被消费、running 也清空了，如果此刻没有新事件就会永远等下去。
   * 小间隔轮询在这里更简单也更可靠。
   *
   * @returns {Promise<void>}
   */
  async waitForIdle() {
    while (this.running.size > 0) {
      // 刻意不 unref：调用方就是要等它结束，若事件循环此刻没有其它句柄，
      // unref 会让进程直接退出（CLI 一次性下载会静默失败，实测踩过）
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
