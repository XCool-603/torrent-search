/**
 * 演示数据源（demo）—— 完全离线、确定性输出。
 *
 * 用途：
 * - 单元测试与 CI：不依赖网络，验证聚合/去重/排序/分页逻辑。
 * - 断网或站点全挂时：`--sources demo` 仍能演示 CLI 与 Web UI。
 * - 教学：展示适配器应该产出什么形状的数据。
 *
 * 默认不启用，避免污染真实搜索结果。
 */

import { makeResult } from '../models.mjs';
import { normalizeTitle, tokenize } from '../models.mjs';
import { shortHash } from '../magnet.mjs';

const DATASET = [
  { title: 'Ubuntu 24.04 LTS Desktop amd64', size: 5_368_709_120, seeders: 412, leechers: 23, category: '软件', days: 30 },
  { title: 'Ubuntu Server 22.04.4 LTS amd64', size: 2_013_265_920, seeders: 187, leechers: 11, category: '软件', days: 120 },
  { title: 'Debian 12.5 netinst amd64', size: 659_554_304, seeders: 96, leechers: 4, category: '软件', days: 90 },
  { title: 'Blender 4.2 LTS Open Source 3D Creation Suite', size: 322_122_547, seeders: 64, leechers: 9, category: '软件', days: 45 },
  { title: '进击的巨人 最终季 全 16 集 1080p 简繁字幕', size: 12_884_901_888, seeders: 233, leechers: 45, category: '动漫', days: 7 },
  { title: '葬送的芙莉莲 全 28 集 1080p HEVC 简日双语', size: 8_589_934_592, seeders: 158, leechers: 31, category: '动漫', days: 3 },
  { title: 'The Last of Us Part I Repack', size: 42_949_672_960, seeders: 78, leechers: 12, category: '游戏', days: 60 },
  { title: 'Pink Floyd - The Wall (1979) FLAC 24bit', size: 1_610_612_736, seeders: 45, leechers: 2, category: '音乐', days: 400 },
  { title: 'Big Buck Bunny 4K Animation Short', size: 1_073_741_824, seeders: 21, leechers: 1, category: '视频', days: 800 },
  { title: 'ImageNet ILSVRC2012 Dataset', size: 154_618_298_368, seeders: 12, leechers: 3, category: '数据集', days: 900 },
];

export default {
  id: 'demo',
  name: '演示数据源（离线）',
  description: '内置 10 条固定数据的离线源，用于测试与断网演示，默认不启用',
  homepage: 'https://example.invalid/demo',
  kinds: ['demo'],
  defaultEnabled: false,
  offline: true,

  /**
   * @param {string} query
   * @param {{limit: number}} ctx
   */
  async search(query, ctx) {
    const tokens = tokenize(query);
    const items = DATASET.map((entry) => {
      const normTitle = normalizeTitle(entry.title);
      const hits = tokens.filter((token) => normTitle.includes(token)).length;
      return { entry, hits, normTitle };
    })
      .filter((item) => tokens.length === 0 || item.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.entry.seeders - a.entry.seeders)
      .slice(0, Number.isFinite(ctx.limit) && ctx.limit > 0 ? ctx.limit : DATASET.length);

    return items.map(({ entry }) =>
      makeResult({
        source: 'demo',
        title: entry.title,
        // 确定性伪 hash，让 demo 也能演示磁力链接与去重
        infoHash: shortHash(entry.title, 40),
        size: entry.size,
        seeders: entry.seeders,
        leechers: entry.leechers,
        category: entry.category,
        publishedAt: new Date(Date.now() - entry.days * 86_400_000).toISOString(),
        detailsUrl: null,
        torrentUrl: null,
      }),
    );
  },

  _dataset: DATASET,
};
