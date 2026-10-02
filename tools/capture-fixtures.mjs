#!/usr/bin/env node
/**
 * 抓取真实响应并裁剪成测试夹具（test/fixtures/）。
 *
 * 目的：单元测试完全离线、可重复，同时保证解析逻辑面对的是「真实的站点格式」，
 * 而不是我们想象出来的格式。站点改版后重新运行本脚本即可更新夹具：
 *
 *   npm run fixtures
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 从 RSS 里只保留前 N 个 item，保证夹具体积小且格式合法。
 *
 * @param {string} xml
 * @param {number} count
 * @returns {string}
 */
function trimRss(xml, count) {
  const firstItem = xml.indexOf('<item>');
  if (firstItem === -1) return xml;

  const header = xml.slice(0, firstItem);
  const items = [];
  let cursor = firstItem;

  while (items.length < count) {
    const start = xml.indexOf('<item>', cursor);
    if (start === -1) break;
    const end = xml.indexOf('</item>', start);
    if (end === -1) break;
    items.push(xml.slice(start, end + '</item>'.length));
    cursor = end + '</item>'.length;
  }

  const closing = /<\/rss>\s*$/i.test(xml) ? '</channel>\n</rss>\n' : '</channel>\n';
  return `${header}${items.join('\n')}\n${closing}`;
}

const JOBS = [
  {
    file: 'apibay-ubuntu.json',
    url: 'https://apibay.org/q.php?q=ubuntu',
    transform: (text) => `${JSON.stringify(JSON.parse(text).slice(0, 5), null, 2)}\n`,
  },
  {
    file: 'apibay-empty.json',
    url: 'https://apibay.org/q.php?q=zzzzqqqxxnotexistkeyword',
    transform: (text) => `${JSON.stringify(JSON.parse(text).slice(0, 3), null, 2)}\n`,
  },
  {
    file: 'nyaa-ubuntu.xml',
    url: 'https://nyaa.si/?page=rss&q=ubuntu&c=0_0&f=0',
    transform: (text) => trimRss(text, 3),
  },
  {
    file: 'bitsearch-ubuntu.json',
    url: 'https://bitsearch.to/api/v1/search?q=ubuntu&limit=5&sort=seeders',
    transform: (text) => {
      const data = JSON.parse(text);
      data.results = (data.results ?? []).slice(0, 5);
      return `${JSON.stringify(data, null, 2)}\n`;
    },
  },
  {
    file: 'mikan-shingeki.xml',
    url: `https://mikanani.me/RSS/Search?searchstr=${encodeURIComponent('进击的巨人')}`,
    transform: (text) => trimRss(text, 3),
  },
  {
    file: 'dmhy-shingeki.xml',
    url: `https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent('进击的巨人')}`,
    transform: (text) => trimRss(text, 3),
  },
  {
    file: 'academic-database.xml',
    url: 'https://academictorrents.com/database.xml',
    transform: (text) => trimRss(text, 5),
  },
];

async function main() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });

  for (const job of JOBS) {
    process.stdout.write(`抓取 ${job.file} … `);
    try {
      const response = await fetch(job.url, {
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      });
      if (!response.ok) {
        process.stdout.write(`跳过（HTTP ${response.status}）\n`);
        continue;
      }
      const text = await response.text();
      const output = job.transform(text);
      await fs.writeFile(path.join(FIXTURE_DIR, job.file), output, 'utf8');
      process.stdout.write(`OK (${Buffer.byteLength(output)} 字节)\n`);
    } catch (error) {
      process.stdout.write(`失败：${error.message}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
