#!/usr/bin/env node
/**
 * 实网冒烟测试：对每个数据源发真实请求，并校验结果字段的完整性。
 *
 * 与单元测试的分工：
 * - 单元测试（npm test）离线、确定性，验证解析与聚合逻辑；
 * - 本脚本验证「站点现在是否还能用、字段是否还对得上」，会随站点变化而失败，
 *   这正是它的价值：站点改版时第一个报警。
 *
 *   npm run smoke
 *   node tools/smoke.mjs "进击的巨人" --proxy auto
 */

import { createContext, resolveSources, searchAll, searchOne } from '../src/index.mjs';
import { parseMagnet } from '../src/magnet.mjs';

const argv = process.argv.slice(2);
const proxyIndex = argv.indexOf('--proxy');
const proxy = proxyIndex === -1 ? null : (argv[proxyIndex + 1] ?? 'auto');
const keyword = argv.find((arg, index) => !arg.startsWith('-') && index !== proxyIndex + 1) ?? 'ubuntu';

const problems = [];
const notes = [];

/**
 * 校验单条结果的字段自洽性。
 *
 * @param {string} sourceId
 * @param {any} result
 */
function validateResult(sourceId, result) {
  const where = `${sourceId} / ${result.title?.slice(0, 40)}`;

  if (!result.title || result.title.trim() === '') problems.push(`${where}: 标题为空`);
  if (!result.id?.startsWith(`${sourceId}:`)) problems.push(`${where}: id 前缀不正确 (${result.id})`);

  if (result.infoHash !== null) {
    if (!/^[0-9a-f]{40}$/.test(result.infoHash)) problems.push(`${where}: infoHash 不是小写 40 位 hex (${result.infoHash})`);
    if (!result.magnet) problems.push(`${where}: 有 hash 却没有磁力链接`);
    else {
      const parsed = parseMagnet(result.magnet);
      if (!parsed) problems.push(`${where}: 磁力链接无法解析`);
      else if (parsed.infoHash !== result.infoHash) problems.push(`${where}: 磁力链接里的 hash 与 infoHash 不一致`);
    }
  }

  if (result.size !== null && (!Number.isInteger(result.size) || result.size <= 0)) {
    problems.push(`${where}: size 非法 (${result.size})`);
  }
  if (result.size !== null && !result.sizeText) problems.push(`${where}: 有 size 却没有 sizeText`);

  for (const field of ['seeders', 'leechers']) {
    const value = result[field];
    if (value !== null && (!Number.isInteger(value) || value < 0)) problems.push(`${where}: ${field} 非法 (${value})`);
  }

  if (result.publishedAt !== null && Number.isNaN(Date.parse(result.publishedAt))) {
    problems.push(`${where}: publishedAt 不是合法时间 (${result.publishedAt})`);
  }
}

async function main() {
  const ctx = await createContext({ proxy, timeoutMs: 15_000, verbose: argv.includes('--verbose') });
  const { sources } = resolveSources('all');

  process.stdout.write(`实网冒烟测试：关键词「${keyword}」  代理：${ctx.proxy ?? '直连'}\n\n`);

  const online = sources.filter((source) => source.offline !== true);
  const results = await Promise.all(
    online.map((source) => searchOne(source, keyword, { ...ctx, limit: 20, timeoutMs: 15_000 })),
  );

  let okCount = 0;
  for (const status of results) {
    if (status.ok) {
      okCount += 1;
      const sample = status.sample[0];
      process.stdout.write(
        `  ✓ ${status.id.padEnd(10)} ${String(status.count).padStart(3)} 条  ${String(status.tookMs).padStart(6)}ms  ${sample ? sample.title.slice(0, 50) : '（无结果）'}\n`,
      );
      if (status.count === 0) notes.push(`${status.id}: 连通但没有结果（可能该站确实没有这个关键词）`);
      for (const result of status.sample) validateResult(status.id, result);
    } else {
      process.stdout.write(`  ✗ ${status.id.padEnd(10)} 失败：${status.error}\n`);
      problems.push(`${status.id}: 请求失败 - ${status.error}`);
    }
  }

  // 聚合 + 跨源去重 + 排序
  process.stdout.write('\n聚合搜索（默认源，每页 20）…\n');
  const aggregated = await searchAll({ query: keyword, sources: 'default', pageSize: 20, ...ctx });

  process.stdout.write(`  去重后 ${aggregated.total} 条，用时 ${aggregated.tookMs}ms\n`);
  for (const [index, result] of aggregated.results.slice(0, 5).entries()) {
    process.stdout.write(
      `  ${String(index + 1).padStart(2)}. [${(result.sources ?? [result.source]).join('+')}] ${result.title.slice(0, 60)}  ${result.sizeText ?? '-'}  做种 ${result.seeders ?? '-'}\n`,
    );
  }

  for (const result of aggregated.results) validateResult(result.source, result);

  const merged = aggregated.results.filter((result) => (result.sources?.length ?? 1) > 1);
  if (merged.length > 0) {
    process.stdout.write(`\n跨源去重生效：${merged.length} 条结果来自多个源（例如 ${merged[0].sources.join('+')}）\n`);
  } else {
    notes.push('本次未出现跨源重复项（关键词或站点排序导致，属正常现象）');
  }

  // 代理模式单独确认一次
  if (!ctx.proxy) {
    const detected = await createContext({ proxy: 'auto', timeoutMs: 15_000 });
    if (detected.proxy) {
      const probe = await searchOne(online[0], keyword, { ...detected, limit: 5, timeoutMs: 15_000 });
      if (probe.ok) process.stdout.write(`\n代理路径可用：经 ${detected.proxy} 成功请求 ${online[0].id}（${probe.count} 条）\n`);
      else {
        process.stdout.write(`\n代理路径失败：${probe.error}\n`);
        notes.push(`代理 ${detected.proxy} 不可用：${probe.error}`);
      }
    } else {
      notes.push('未检测到系统代理，跳过代理路径验证');
    }
  }

  process.stdout.write(`\n${'─'.repeat(60)}\n`);
  if (notes.length > 0) {
    process.stdout.write(`提示：\n${notes.map((note) => `  · ${note}`).join('\n')}\n`);
  }

  if (problems.length > 0) {
    process.stdout.write(`\n发现 ${problems.length} 个问题：\n${problems.map((problem) => `  ✗ ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  if (okCount === 0) {
    process.stdout.write('\n所有在线数据源都不可用。\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n全部通过：${okCount}/${online.length} 个在线数据源可用，字段校验无异常。\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
