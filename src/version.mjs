/**
 * 版本号：从 package.json 读，**不要**在源码里硬编码。
 *
 * 早期版本把 '1.0.0' 写死在 src/index.mjs 与 src/server.mjs 里，于是发了 v1.2.0、v1.2.1
 * 之后 /api/health 仍然报 1.0.0 —— 部署后想确认"跑的是哪一版"就失去了依据
 * （真实踩过：用户反复构建旧代码，而健康检查看不出来）。
 */

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = String(pkg.version ?? '0.0.0');
