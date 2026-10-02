/**
 * 生成并写入 qBittorrent 的 WebUI 密码（带引号值格式，与 qBittorrent 自写格式一致）。
 *
 * 用法：node tools/qbittorrent-password.mjs [密码] [ini路径]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const password = process.argv[2] ?? 'torrent-search';
const iniPath = process.argv[3] ?? path.join(os.homedir(), 'AppData', 'Roaming', 'qBittorrent', 'qBittorrent.ini');

const salt = crypto.randomBytes(16);
const dk = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha512');
// HMAC key 用【原始 salt 字节】（qBittorrent password.cpp），用错会静默禁用 WebUI
const hmac = crypto.createHmac('sha512', salt).update(dk).digest('base64');

let ini = fs.readFileSync(iniPath, 'utf8');
const pbkdf2Value = `${dk.toString('base64')}:${salt.toString('base64')}`;

ini = ini.replace(/^WebUI\\Password_pbkdf2=.*$/m, `WebUI\\Password_pbkdf2="${pbkdf2Value}"`);
ini = ini.replace(/^WebUI\\Password_hmac=.*$/m, `WebUI\\Password_hmac="${hmac}"`);
// 确保用户名存在
if (!/^WebUI\\Username=/m.test(ini)) {
  ini = ini.replace(/(\[Preferences\]\n)/, `$1WebUI\\Username=admin\n`);
}
if (!/^WebUI\\Enabled=/m.test(ini)) {
  ini = ini.replace(/(\[Preferences\]\n)/, `$1WebUI\\Enabled=true\nWebUI\\Port=8080\nWebUI\\Address=*\nWebUI\\LocalHostAuth=false\n`);
}

fs.writeFileSync(iniPath, ini, 'utf8');
console.log(`已写入 ${iniPath}`);
console.log(`  用户名: admin  密码: ${password}`);
