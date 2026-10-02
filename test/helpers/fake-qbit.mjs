/**
 * 假的 qBittorrent Web API 服务（离线测试用）。
 *
 * 实现真实 API 的关键行为：
 *   - POST /api/v2/auth/login  → "Ok." + Set-Cookie: SID=...
 *   - GET  /api/v2/app/version → 版本号
 *   - POST /api/v2/torrents/add    → "Ok." / "Fails."
 *   - GET  /api/v2/torrents/info   → 任务数组（进度按轮询次数推进，模拟下载）
 *   - GET  /api/v2/torrents/files  → 文件列表
 *   - POST /api/v2/torrents/delete → "Ok."
 *
 * 还支持：
 *   - requireAuth：非登录接口必须带 Cookie，否则 403（用于验证"Cookie 过期自动重登"）
 *   - failAdd：让 add 返回 "Fails."
 */

import http from 'node:http';
import { once } from 'node:events';

/**
 * @param {{
 *   progressSteps?: number,   // 轮询多少次后达到 100%
 *   requireAuth?: boolean,
 *   failAdd?: boolean,
 *   state?: string,           // 完成后 qB 报告的状态（默认 uploading）
 *   files?: Array<{name: string, size: number}>,
 * }} [options]
 */
export async function startFakeQbit(options = {}) {
  const progressSteps = options.progressSteps ?? 3;
  const files = options.files ?? [{ name: 'movie.mkv', size: 1000 }];
  const completeState = options.state ?? 'uploading';

  const stats = { login: 0, add: 0, info: 0, files: 0, delete: 0, unauthorized: 0 };
  /** @type {Map<string, any>} */
  const torrents = new Map();
  const requests = { add: [], delete: [] };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;

    const readBody = async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      return new URLSearchParams(body);
    };

    const send = (status, text, headers = {}) => {
      response.writeHead(status, { 'content-type': 'text/plain', ...headers });
      response.end(text);
    };

    if (path === '/api/v2/auth/login') {
      stats.login += 1;
      const form = await readBody();
      if (form.get('username') === 'admin' && (form.get('password') === 'secret' || form.get('password') === '')) {
        send(200, 'Ok.', { 'set-cookie': 'SID=fake-session-id; HttpOnly; path=/' });
      } else {
        send(200, 'Fails.');
      }
      return;
    }

    // 鉴权检查
    if (options.requireAuth) {
      const cookie = request.headers.cookie ?? '';
      if (!cookie.includes('SID=fake-session-id')) {
        stats.unauthorized += 1;
        send(403, 'Forbidden');
        return;
      }
    }

    if (path === '/api/v2/app/version') {
      send(200, 'v5.2.4');
      return;
    }

    if (path === '/api/v2/torrents/add' && request.method === 'POST') {
      stats.add += 1;
      const form = await readBody();
      const urls = form.get('urls') ?? '';
      requests.add.push({ urls, savepath: form.get('savepath'), category: form.get('category') });

      if (options.failAdd) {
        send(200, 'Fails.');
        return;
      }

      // 从磁力里取 info hash 作为任务标识
      const hash = (urls.match(/btih:([0-9a-fA-F]{40})/) ?? [])[1]?.toLowerCase() ?? 'unknown';
      torrents.set(hash, {
        hash,
        name: form.get('category') ? `torrent-${hash.slice(0, 6)}` : `torrent-${hash.slice(0, 6)}`,
        size: 1000,
        progress: 0,
        polls: 0,
        save_path: form.get('savepath') ?? '',
        state: 'downloading',
      });
      send(200, 'Ok.');
      return;
    }

    if (path === '/api/v2/torrents/info') {
      stats.info += 1;
      const filter = url.searchParams.get('hashes');
      const list = [];

      for (const torrent of torrents.values()) {
        if (filter && filter !== torrent.hash) continue;

        // 每次查询推进一格进度
        torrent.polls += 1;
        torrent.progress = Math.min(1, torrent.polls / progressSteps);
        if (torrent.progress >= 1) torrent.state = completeState;

        list.push({
          hash: torrent.hash,
          name: torrent.name,
          size: torrent.size,
          progress: torrent.progress,
          dlspeed: torrent.progress >= 1 ? 0 : 1024,
          num_seeds: 3,
          num_leechs: 2,
          num_complete: 10,
          num_incomplete: 4,
          pieces_num: 10,
          pieces_have: Math.round(torrent.progress * 10),
          state: torrent.state,
          save_path: torrent.save_path,
        });
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(list));
      return;
    }

    if (path === '/api/v2/torrents/files') {
      stats.files += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(files.map((file) => ({ ...file, progress: 1 }))));
      return;
    }

    if (path === '/api/v2/torrents/delete' && request.method === 'POST') {
      stats.delete += 1;
      const form = await readBody();
      requests.delete.push({ hashes: form.get('hashes'), deleteFiles: form.get('deleteFiles') });
      torrents.delete(form.get('hashes') ?? '');
      send(200, 'Ok.');
      return;
    }

    send(404, 'Not Found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    stats,
    requests,
    torrents,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}
