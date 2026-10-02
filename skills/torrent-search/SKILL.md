---
name: torrent-search
description: 'Use when the user wants to find magnet links or torrents for a title, release, artist or file (including Chinese and Japanese media), wants one of them downloaded, or reports that such a download stalls or fails with peer handshake errors. Wraps a zero-dependency local search tool that aggregates public indexers, downloads through a built-in BitTorrent engine or a local qBittorrent, and diagnoses networks that block P2P.'
---

# 种子搜索（torrent-search）

`<skill-directory>\scripts\torrent-search.mjs` 是唯一入口。它**直接调用项目模块**（不启动子进程），
输出紧凑 JSON，便于你解析。项目本身零运行时依赖，需要 Node ≥ 20。

```powershell
& '<skill-directory>\scripts\torrent-search.mjs' search '<关键词>'
```

脚本会自动定位项目根目录（从自身位置推导）。若项目被移动，用 `--home <路径>` 或环境变量
`TORRENT_SEARCH_HOME` 指定；两者都没有时它会报错并说明，不要猜路径。

## 命令

| 命令 | 用途 |
| --- | --- |
| `search <关键词> [选项]` | 聚合搜索，输出紧凑 JSON（默认 10 条） |
| `sources` | 列出数据源及其 id |
| `check [关键词]` | 逐源连通性自检——区分「某个源挂了」与「网络不通」 |
| `doctor` | P2P 下载环境诊断。**任何下载失败都先跑它** |
| `download <目标> [选项]` | 下载磁力 / info hash / 关键词（配 `--pick N`） |
| `tasks` | 查看服务端任务列表（需要 `serve` 在跑） |

常用选项：`--limit N`、`--sources a,b`、`--sort seeders|relevance|size|date|leechers`、
`--order asc|desc`、`--min-seeders N`、`--exclude cam,TS`、`--safe`、`--no-cache`、
`--text`（人类可读表格）、`--magnet-only`。
下载选项：`--pick N`、`--dir <目录>`、`--max-size <MiB>`、`--backend auto|builtin|qbittorrent`、
`--timeout-seconds N`（默认 1800，`0` = 不限）、`--no-extra-trackers`、`--no-dht`。

## 典型流程

1. **搜索**：`search '<关键词>' --limit 10`。中文资源用 `--sources mikan,dmhy`，动漫用 `nyaa`，
   综合用默认源，学术用 `academic`。
2. **挑结果**：按做种数（`seeders`）排序，优先选**做种数高**的。做种数为 0 或 `null` 的结果通常下不动。
   体积、来源、发布时间都在 JSON 里，用它们向用户解释你为什么推荐这一条。
3. **下载**：把选中结果的 `magnet` 原样交给 `download`。

## 硬性经验（都是实际踩出来的，别绕开）

- **磁力链接必须整体加引号**。它含 `&`，不加引号会被 shell 拆成多个参数。
- **下载是长任务**（几分钟到几十分钟）：作为**后台任务**运行，不要阻塞对话。
  进度每 3 秒打到 stderr，最终结果 JSON 打到 stdout——以后台的 stdout 为准判断成败。
  默认 30 分钟超时保护，大文件可以调大或设 `--timeout-seconds 0`。
- **`ok`/`status` 是唯一判据**。`status: "done"` 才算成功；`failed`/`cancelled`/`stopped`
  都要如实告诉用户，并附上 `error` 字段的内容。**不要凭进度条猜测成功。**
- **「握手期间连接被关闭」「无法从任何 peer 获取元数据」是网络层拦截 P2P，不是工具故障。**
  这时必须跑 `doctor`，然后按它的结论向用户解释：通常是代理的 TUN 模式接管了全局路由，
  机场在协议层丢弃 BT 流量。**已验证：换 qBittorrent 也一样拿不到 peer**，所以不要说
  「换个客户端就好了」。真正的解法只有：让 BT 流量直连（代理规则里设为 DIRECT）、
  换不限制 P2P 的网络，或让下载走 VPN 出口。
- **不要在对话里倾倒整页结果**。默认 10 条就够；要更多时先问用户。
- **只用工具返回的磁力/info hash**，绝不自己拼造或"修复"。
- 结果字段里站点没提供的值是 `null`（例如 dmhy 没有体积与做种数）——如实转述，
  不要把 `null` 说成 0，也不要编一个体积出来。
- `--safe` 依据的是站点自己的成人分类标注，不是标题猜测；要更严格就用 `--exclude`。
- 下载默认落到 `~/Downloads/torrent-search`。用 `--dir` 换目录时，**先告诉用户会存到哪里**。
- 工具与本地服务只监听 `127.0.0.1`，不对外暴露。要看界面就启动
  `node bin/magnet-search.mjs serve`（作为后台任务），然后把 `http://127.0.0.1:8787/` 给用户。

## 读 search 的输出

```jsonc
{
  "ok": true,
  "query": "ubuntu",
  "total": 41,              // 过滤后的条数
  "totalBeforeFilter": 102, // 去重后、过滤前的条数
  "tookMs": 1234,
  "cached": false,          // true = 命中服务端 60 秒缓存（要最新结果加 --no-cache）
  "sources": [{ "id": "apibay", "ok": true, "count": 100, "tookMs": 420, "error": null }],
  "results": [{
    "title": "...", "size": "3.40 GiB", "sizeBytes": 3654957056,
    "seeders": 31, "leechers": 1,
    "infoHash": "2c6b6858...", "magnet": "magnet:?xt=urn:btih:...",
    "sources": ["apibay", "bitsearch"],   // 跨源去重后合并的来源
    "publishedAt": "...", "category": "..."
  }]
}
```

`sources` 里 `ok: false` 的项要主动说明（例如「nyaa 超时」），这能解释为什么结果比预期少。

## 失败怎么判断

| 现象 | 含义 | 你该做什么 |
| --- | --- | --- |
| 全部源 `ok: false` | 网络或代理问题 | 提示 `--proxy auto`，或让用户确认代理是否在跑 |
| 只有个别源失败 | 该站点改版/被墙 | 用 `--sources` 换源；若用户想修，那是改适配器的开发任务 |
| `doctor` 报 peer 握手 0 成功 | P2P 被拦截 | 按上文解释，不要归咎于工具 |
| `download` 卡在 `metadata` | 没有可用 peer | 换做种数更高的结果，或跑 `doctor` |
| `status: stopped` | 达到 `--max-size` 上限 | 如实说明，问用户是否要放宽上限 |
| `tasks` 连不上 | 服务没启动 | 提示启动 `serve`（后台任务） |

## 绝不要

- 编造磁力链接、info hash、做种数或体积；
- 在 `status` 不是 `done` 时说下载成功；
- 把网络层拦截 P2P 描述成工具缺陷，或承诺"换个客户端就能下"；
- 未经用户同意把文件下到默认目录之外的路径；
- 一次把几十上百条结果贴进对话。

## 合规

工具只聚合**公开索引站点上已公开的元数据**（标题、体积、info hash），不托管也不分发内容。
帮用户下载前，按其所在地区的法律与站点条款提醒一句：只用于其有权获取的内容
（开源发行版、CC 授权作品等）。用户坚持要下受版权保护的商业内容时，说明风险，不要协助规避。
