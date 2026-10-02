#!/usr/bin/env node
/**
 * 把仓库里的 skill 安装到 DSH 的用户级 skill 目录，供所有会话使用。
 *
 * 默认用**目录联结**（junction）指向仓库，这样只有一份源文件：改仓库里的 skill，
 * 立刻对所有会话生效，也不会出现"仓库改了但装的那份没变"。
 * 联结失败（权限/文件系统不支持）时回退为复制。
 *
 * 用法：
 *   node tools/install-skill.mjs            # 安装（已存在则更新）
 *   node tools/install-skill.mjs --uninstall
 *   node tools/install-skill.mjs --copy     # 强制复制而不是联结
 *   node tools/install-skill.mjs --dir <目标 skill 根目录>
 *
 * DSH 的 skill 发现位置（按优先级）：
 *   <项目>/.dsh/skills  <项目>/.agents/skills  <自定义>
 *   ~/.dsh/skills       ~/.agents/skills       $DSH_BUNDLED_SKILL_DIR
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'torrent-search';
const SOURCE_DIR = path.join(ROOT, 'skills', SKILL_NAME);

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { copy: false, uninstall: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--copy') options.copy = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--dir') {
      options.dir = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

/**
 * 默认安装到用户级 skill 目录（~/.dsh/skills）。
 *
 * @param {string|undefined} explicit
 * @returns {string}
 */
function resolveTargetRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'skills');
}

/**
 * 删除路径（文件、目录或联结）。
 *
 * @param {string} target
 */
async function remove(target) {
  // 联结/符号链接必须先删链接本身，不能递归进去删内容
  const info = await fs.lstat(target).catch(() => null);
  if (info === null) return false;
  if (info.isSymbolicLink() || info.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  } else {
    await fs.rm(target, { force: true });
  }
  return true;
}

/**
 * 建立目录联结（Windows 上不需要管理员权限，与符号链接不同）。
 *
 * @param {string} linkPath
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function createJunction(linkPath, targetPath) {
  if (process.platform !== 'win32') {
    // 类 Unix 用符号链接
    try {
      await fs.symlink(targetPath, linkPath, 'dir');
      return true;
    } catch {
      return false;
    }
  }

  return await new Promise((resolve) => {
    const child = spawn('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * 递归复制目录。
 *
 * @param {string} from
 * @param {string} to
 */
async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await fs.copyFile(source, target);
  }
}

/**
 * 写一份项目路径记录，供包装脚本在联结被替换成副本时定位项目。
 *
 * @param {string} dshHome
 */
async function writeHomeRecord(dshHome) {
  const record = path.join(dshHome, 'torrent-search-home.txt');
  await fs.mkdir(dshHome, { recursive: true });
  await fs.writeFile(record, `${ROOT}\n`, 'utf8');
  return record;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetRoot = resolveTargetRoot(options.dir);
  const target = path.join(targetRoot, SKILL_NAME);
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');

  if (options.uninstall) {
    const removed = await remove(target);
    process.stdout.write(removed ? `已移除 ${target}\n` : `未安装（${target} 不存在）\n`);
    return 0;
  }

  // 源目录自检：避免装一个空的/不完整的 skill
  const skillFile = path.join(SOURCE_DIR, 'SKILL.md');
  try {
    await fs.access(skillFile);
  } catch {
    throw new Error(`找不到 skill 源文件：${skillFile}`);
  }
  const scriptFile = path.join(SOURCE_DIR, 'scripts', 'torrent-search.mjs');
  try {
    await fs.access(scriptFile);
  } catch {
    throw new Error(`找不到 skill 脚本：${scriptFile}`);
  }

  await fs.mkdir(targetRoot, { recursive: true });
  await remove(target);

  let mode = 'junction';
  if (!options.copy) {
    const linked = await createJunction(target, SOURCE_DIR);
    if (!linked) {
      mode = 'copy';
      process.stderr.write('联结创建失败（可能不支持或权限不足），回退为复制。\n');
    }
  } else {
    mode = 'copy';
  }

  if (mode === 'copy') await copyDir(SOURCE_DIR, target);

  const record = await writeHomeRecord(dshHome);

  process.stdout.write(
    `已安装 skill：${target}\n` +
      `  方式：${mode === 'junction' ? '目录联结（改仓库即生效）' : '复制（改仓库后需重新运行本命令）'}\n` +
      `  源：${SOURCE_DIR}\n` +
      `  项目路径记录：${record}\n` +
      `\n下一步：新开会话（或等 skill 目录变更被监听到）后即可使用；\n` +
      `  也可以直接跑：node "${path.join(target, 'scripts', 'torrent-search.mjs')}" help\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
