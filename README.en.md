# Torrent Search

A **local search tool** that aggregates several public magnet/BitTorrent indexers — usable as a CLI, a web UI, or a JSON API. **Zero runtime dependencies** (Node built-ins only).

[中文文档](README.md) | **English**

```bash
node bin/magnet-search.mjs "ubuntu 24.04"
node bin/magnet-search.mjs serve          # then open http://127.0.0.1:8787
```

![Search results](docs/screenshot-search.png)

---

## Features

- **Multi-source aggregation** — one query hits 6 public sources concurrently; results are merged and de-duplicated (the same torrent from several sites appears once, with all sources listed).
- **Transparent failure handling** — a source timing out, being blocked, or changing its markup never breaks the others; per-source result counts, latency, and error reasons are all surfaced.
- **Result filtering** — minimum seeders, excluded keywords (`cam`/`TS`/…), and a safe filter (drops results the site itself tags as adult).
- **Controllable sorting** — relevance / seeders / leechers / size / date, each ascending or descending, applied to the whole candidate pool (not just the current page).
- **Zero dependencies** — no `npm install`, no build step. Node ≥ 20 runs it as-is.
- **Proxy support** — `--proxy 127.0.0.1:7897`, or `--proxy auto` (reads the system proxy; on Windows it reads the registry).
- **Three ways to use it** — CLI (pipeable, scriptable), web UI (visual), JSON API (callable from other programs).
- **Verifiable** — 232 offline tests (with real captured fixtures) + a live smoke test + a project self-check (`npm run lint`).

## Quick start

```bash
# 1) Aggregate search
node bin/magnet-search.mjs "ubuntu 24.04"

# 2) Magnets only (handy for piping)
node bin/magnet-search.mjs "ubuntu 24.04" --magnet

# 3) Pick Chinese sources and sort
node bin/magnet-search.mjs "进击的巨人" -s mikan,dmhy --sort seeders

# 4) Start the web UI + API
node bin/magnet-search.mjs serve
```

## Command line

```
magnet-search <keywords> [options]   aggregate search
magnet-search serve [options]        start local web UI + JSON API (default 127.0.0.1:8787)
magnet-search sources                list all data sources
magnet-search check [keywords]       per-source connectivity self-check
magnet-search doctor                 diagnose the P2P download environment (run this first if downloads fail)
magnet-search download <target>      download a magnet / info hash (built-in BT engine, zero deps)
magnet-search downloads              show download task history
```

### Downloads failing? Run `doctor` first

```bash
node bin/magnet-search.mjs doctor
```

It checks each layer and prints an **actionable conclusion**: proxy TUN adapters, tracker announce (HTTP),
DHT (UDP), and a real BitTorrent handshake against actual peers. Example output behind a Clash TUN setup:

```
  ⚠ proxy TUN adapter   adapter "Meta" looks like a proxy TUN device
  ✓ tracker announce    50 peers returned (HTTP, can go through the proxy)
  ⚠ DHT (UDP)           network reachable but no peers found (UDP may be blocked)
  ✗ peer BT handshake   0 succeeded (5 closed by the remote peer)

Conclusion
  P2P traffic is being intercepted by the proxy (TUN mode owns the default route).
  Fix: switch Clash from TUN to "system proxy", or disable TUN temporarily;
  alternatively route BT traffic (high TCP ports and UDP) as DIRECT in your proxy rules.
```

When a download fails, the engine attaches the same kind of diagnosis automatically
(failure-mode summary + detected TUN adapter + suggestions).

### Downloading via qBittorrent (recommended on restricted networks)

If your network blocks P2P as above, the built-in engine (plaintext handshake) will not move,
but **qBittorrent ships protocol encryption (MSE)** which defeats many DPI setups. The tool has a
bridge: it hands the task to your local qBittorrent and tracks progress / cancellation itself.

```bash
# 1. Install and start qBittorrent (skip if already installed)
winget install qBittorrent.qBittorrent

# 2. Enable its Web UI: Tools → Options → Web UI
#    Tick "Web User Interface", set a username/password (port 8080 by default)

# 3. Point the tool at it (optional, defaults to http://127.0.0.1:8080)
export TORRENT_SEARCH_QBITTORRENT="http://127.0.0.1:8080|admin|your-password"

# 4. Download (--backend auto is the default: use qBittorrent when available)
node bin/magnet-search.mjs download "magnet:?xt=urn:btih:..." --backend auto
node bin/magnet-search.mjs download "ubuntu 24.04" --pick 1 --backend qbittorrent
node bin/magnet-search.mjs doctor        # tells you whether the bridge is usable
```

| Backend option | Meaning |
| --- | --- |
| `--backend auto` | **Default.** Uses qBittorrent when reachable, otherwise the built-in engine |
| `--backend builtin` | Built-in engine only (zero deps, plaintext handshake) |
| `--backend qbittorrent` | qBittorrent only (task fails with a clear reason when unreachable) |
| `--qb-url <url>` | Override the endpoint: `http://127.0.0.1:8080\|user\|password` |

The task list shows which backend handled each task (the web UI has a small
"built-in engine / qBittorrent" badge; `downloads` prints it too). Cancelling tells qBittorrent to
remove the task (keeping files); deleting honours your choice about the files.

> Measured note: on the machine this was developed on (Clash TUN + a commercial proxy),
> qBittorrent **also** got zero peers — the provider drops all BT traffic at the protocol layer,
> and encryption does not save it. **The only real fix is to let BT traffic go direct**
> (mark BT traffic as DIRECT in your proxy rules, or use a network that does not restrict P2P).

| Option | Meaning |
| --- | --- |
| `-s, --sources <list>` | Sources, comma separated; `default` = default set, `all` = everything; e.g. `apibay,nyaa` |
| `--sort <mode>` | `relevance` (default) / `seeders` / `leechers` / `size` / `date` |
| `--order <dir>` | `desc` (default) / `asc` |
| `-n, --page-size <N>` | Results per page (default 20, max 100) |
| `--page <N>` | Page number, starting at 1 |
| `--min-seeders <N>` | Keep only results with ≥ N seeders (unknown seeder counts are dropped) |
| `--exclude <words>` | Excluded keywords, comma separated; e.g. `--exclude cam,TS` |
| `--safe` | Safe filter: drop results the site tags as adult |
| `--json` | Emit full JSON (including per-source status) for scripting |
| `--magnet` | Emit magnet links only, one per line |
| `--timeout <ms>` | Per-source timeout (default 8000) |
| `--proxy <addr>` | HTTP proxy, e.g. `127.0.0.1:7897`; `auto` = detect the system proxy |
| `--demo` | Use only the built-in offline demo source (no network needed) |
| `--open` | (`serve`) open the browser after starting |
| `--no-color` / `-v` | Disable colours / verbose debug logging |

Filtering examples:

```bash
# Only results with ≥ 20 seeders, excluding cam/TS rips
node bin/magnet-search.mjs "blender open movie" --min-seeders 20 --exclude cam,TS

# Safe filter + ascending leechers (find obscure items)
node bin/magnet-search.mjs ubuntu --safe --sort leechers --order asc
```

**Exit codes**: `0` success (including "no results"), `1` runtime error or **all** sources failed, `2` bad arguments.

### Downloading

A **zero-dependency minimal BitTorrent engine** is built in (HTTP/UDP trackers, peer protocol,
BEP 9 metadata exchange, piece download with SHA1 verification), so search results can be downloaded directly:

```bash
# A magnet link
node bin/magnet-search.mjs download "magnet:?xt=urn:btih:...&dn=..."

# An info hash (40-char hex or 32-char Base32)
node bin/magnet-search.mjs download 2c6b6858d61da9543d4231a71db4b1c9264b0685

# Search first, download the 1st result
node bin/magnet-search.mjs download "ubuntu 24.04" --pick 1

# Size cap (stop when reached), custom dir, no extra public trackers
node bin/magnet-search.mjs download "magnet:?..." --max-size 500 --dir /tmp/dl --no-extra-trackers
```

| Download option | Meaning |
| --- | --- |
| `--pick <N>` | Search by keyword first and take the Nth result's magnet (1-based) |
| `--dir <path>` | Save directory, default `~/Downloads/torrent-search` |
| `--max-size <MiB>` | Size cap; stops when reached (marks the task `stopped`) |
| `--no-extra-trackers` | Trust only the magnet's own trackers (less exposure) |
| `--no-dht` | No DHT fallback: give up when trackers fail (faster, one path less) |
| `--limit-speed <rate>` | Rate limit, e.g. `2M` / `500K` / `1048576` (unlimited by default) |
| `--backend <name>` | `auto` (default) / `builtin` / `qbittorrent` — see above |
| `--qb-url <url>` | qBittorrent WebUI endpoint (`http://127.0.0.1:8080\|user\|password`) |

Every result in the web UI has a **Download** button, and the page has a downloads panel
(progress bar / speed / peers / cancel / delete) fed by SSE (`GET /api/downloads/stream`).

![Downloads panel](docs/screenshot-downloads.png)

**Honest scope of the engine:**

- ✅ Supported: magnet parsing, HTTP(S)/UDP trackers, **DHT (BEP 5 iterative `get_peers`, as a tracker fallback)**,
  metadata exchange (BEP 9), multi-file torrents, per-piece SHA1 verification, resume (re-adding the same
  magnet verifies existing pieces first), a size cap as a safety valve.
- ❌ Not implemented: **DHT `announce_peer` and PEX**, seeding/uploading, protocol encryption, uTP. Therefore:
  - Peer discovery order is "magnet's own trackers → added public trackers → DHT fallback"; it only errors
    when all three fail (it never hangs silently).
  - **DHT is UDP and cannot traverse an HTTP proxy** — behind a proxy DHT will fail, so it is a
    "best-effort extra", never the only path; use `--no-dht` to skip it.
  - Throughput depends on peer count and is usually below mature clients such as qBittorrent/aria2.
  - For large files prefer a mature BT client; this feature targets small files and "search and grab" flows.

---

## Web UI

```bash
node bin/magnet-search.mjs serve            # http://127.0.0.1:8787
node bin/magnet-search.mjs serve --port 9000 --proxy auto
```

Interface: keyword search, multi-select sources (preference remembered), click-to-sort headers
(both directions), result filters (min seeders / excluded keywords / safe filter), pagination,
a per-source status bar (hover for failure reasons), keyword highlighting, one-click copy magnet /
open magnet / download `.torrent`, a "re-fetch" that bypasses the server cache, and a responsive
narrow-screen layout. It binds to the loopback address only — it is not exposed to the network.

---

## JSON API

### `GET /api/search`

| Parameter | Required | Meaning |
| --- | --- | --- |
| `q` | ✅ | Keywords (max 200 chars) |
| `sources` | | Comma-separated source ids; omitted = default set |
| `sort` | | `relevance` (default) / `seeders` / `leechers` / `size` / `date` |
| `order` | | `desc` (default) / `asc` |
| `page` / `pageSize` | | Default 1 / 20, `pageSize` capped at 100 |
| `minSeeders` | | Keep results with ≥ this many seeders; unknown counts are dropped |
| `exclude` | | Excluded keywords, comma separated (max 20); ASCII words match at word starts, CJK matches substrings |
| `safe` | | `1` = drop results the site tags as adult |
| `noCache` | | `1` = skip the 60-second server-side result cache |
| `timeoutMs` | | Per-source timeout, default 8000 |

```jsonc
{
  "query": "ubuntu",
  "sort": "relevance",
  "order": "desc",
  "tookMs": 1234,
  "page": 1, "pageSize": 20,
  "total": 41,              // after filtering
  "totalBeforeFilter": 102, // after de-duplication, before filtering
  "totalPages": 3,
  "cached": false,
  "filters": { "minSeeders": 10, "exclude": ["cam"], "safe": true },
  "results": [
    {
      "id": "apibay:2c6b6858d61da9543d4231a71db4b1c9264b0685",
      "title": "Ubuntu 22.04 LTS",
      "infoHash": "2c6b6858d61da9543d4231a71db4b1c9264b0685",
      "magnet": "magnet:?xt=urn:btih:2c6b6858d61da9543d4231a71db4b1c9264b0685&dn=Ubuntu%2022.04%20LTS",
      "size": 3654957056, "sizeText": "3.40 GiB",
      "seeders": 31, "leechers": 1,
      "category": "Software",
      "adult": false,
      "publishedAt": "2022-05-18T14:33:51.000Z",
      "source": "apibay", "sourceName": "The Pirate Bay (apibay)",
      "detailsUrl": "https://thepiratebay.org/description.php?id=59191690",
      "torrentUrl": "https://apibay.org/torrent/59191690",
      "score": 42.7,
      "sources": ["apibay", "bitsearch"]
    }
  ],
  "sources": [
    { "id": "apibay", "name": "The Pirate Bay (apibay)", "ok": true, "count": 100, "tookMs": 420, "error": null, "cached": false },
    { "id": "nyaa", "name": "Nyaa", "ok": false, "count": 0, "tookMs": 8000, "error": "timeout (8000ms)", "cached": false }
  ]
}
```

> Fields a site does not provide are always `null` (e.g. dmhy has no size or seeder count) — never faked as `0`.
> `adult` relies solely on the site's own category tags, not on guessing from titles.

### Other endpoints

- `GET /api/sources` — source list (id, name, description, enabled by default)
- `GET /api/health` — `{ok, version, uptimeSec, node, proxy, downloads:{enabled, dir, active, backend}}`
- Download tasks (requires `serve`):
  - `POST /api/downloads` — body `{"input":"magnet or hash","dir"?,"name"?,"backend"?}` → 201 task snapshot
  - `GET /api/downloads` — task list (includes `dir`, `backend`, `qbit:{ok,version}`)
  - `GET /api/downloads/:id` — one task; `DELETE /api/downloads/:id?deleteFiles=1` — cancel and delete
  - `GET /api/downloads/stream` — SSE progress stream
- Errors are uniform: `{"error":{"code":"bad_request","message":"..."}}`

### Using it as a library

```js
import { createContext, searchAll } from './src/index.mjs';

const ctx = await createContext({ proxy: 'auto' });
const { results, sources } = await searchAll({ query: 'blender', sort: 'seeders', ...ctx });
console.log(results[0].magnet, sources);
```

### As an AI-agent skill

The repository ships a **DSH skill** (`skills/torrent-search/`) so an AI agent can search, pick a result,
start a download, and handle the "download won't move" case correctly:

```bash
npm run install-skill     # installs to ~/.dsh/skills/torrent-search (directory junction: edits apply live)
```

The wrapper calls the project modules **in-process** (no subprocess) and emits compact JSON.
`SKILL.md` encodes the hard-won rules: quote magnet links, treat downloads as long-running background
tasks, judge success by `status` rather than a progress bar, and read "peer handshake closed" as the
network blocking P2P rather than a tool defect.

---

## Data sources

| id | Site | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `apibay` | The Pirate Bay | General | ✅ | Official JSON API, up to 100 results per query |
| `nyaa` | Nyaa | Anime/general | ✅ | RSS, includes category and seeder counts |
| `bitsearch` | BitSearch | General | ✅ | DHT crawler index, JSON API, broad coverage |
| `mikan` | Mikan Project | Chinese anime | ✅ | RSS search; the episode number *is* the info hash |
| `dmhy` | DMHY (动漫花园) | Chinese anime | ✅ | RSS search; magnets are Base32 (normalised) |
| `academic` | Academic Torrents | Academic | ✅ | No search API: the full catalogue (~3 MB) is cached locally and queried |
| `demo` | Built-in offline data | Demo | ❌ | 10 fixed entries; works with no network |

Adding a source means implementing one `search(query, ctx)` and registering it in
`src/sources/index.mjs` (~60 lines). See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Proxy

```bash
node bin/magnet-search.mjs "ubuntu" --proxy 127.0.0.1:7897   # explicit
node bin/magnet-search.mjs "ubuntu" --proxy auto             # detect (env vars → Windows registry)
```

Implementation: direct requests use Node's built-in `fetch`; proxied requests build an HTTP `CONNECT`
tunnel plus TLS by hand (Node's built-in fetch only reads proxy environment variables at process start,
so it cannot be switched at runtime).

---

## Docker deployment

### One-command deploy

```bash
git clone https://github.com/XCool-603/torrent-search.git
cd torrent-search
sh scripts/docker.sh deploy
```

The script checks Docker, creates `.env` from `.env.example`, builds the image, starts the container,
and **only reports success once the health check passes** (on failure it prints the container logs).
It ends by telling you the URL and the download directory.

Without the script, two commands do the same:

```bash
cp .env.example .env          # optional: port, download directory, download backend
docker compose up -d --build
```

Windows PowerShell:

```powershell
git clone https://github.com/XCool-603/torrent-search.git
cd torrent-search
.\scripts\docker.ps1 deploy
```

### One-command upgrade

```bash
sh scripts/docker.sh upgrade              # pull latest main → rebuild → restart → health check
sh scripts/docker.sh upgrade --ref v1.1.0 # move to a specific tag or branch (also works for rollback)
sh scripts/docker.sh upgrade --no-cache   # skip the build cache
```

Windows:

```powershell
.\scripts\docker.ps1 upgrade
.\scripts\docker.ps1 upgrade --ref v1.1.0
```

The upgrade script is safe to run because it:

- **records the current commit first** and **automatically rolls back** if the rebuilt container fails
  its health check;
- **aborts when tracked files have local modifications** (it will not overwrite your edits); untracked
  files such as `.env` and `downloads/` do not block an upgrade;
- handles a previous `--ref` upgrade (detached HEAD) by switching back to the default branch first;
- keeps **downloads and the task list inside the `./downloads` volume** — upgrading, rebuilding or
  removing the container never touches them, and unfinished downloads resume automatically on restart.

Other commands:

```bash
sh scripts/docker.sh status   # container status + health check
sh scripts/docker.sh logs     # follow logs
sh scripts/docker.sh down     # stop and remove the container (downloads are kept)
```

> On a slow machine the health check may need longer than the default 30 × 2 s:
> `TORRENT_SEARCH_HEALTH_ATTEMPTS=60 sh scripts/docker.sh deploy`

### Deploying to a server

Any server with Docker works exactly like a local machine:

```bash
# on the server
git clone https://github.com/XCool-603/torrent-search.git /opt/torrent-search
cd /opt/torrent-search && sh scripts/docker.sh deploy
```

Rather not install git on the server? Push from your machine instead — this needs **only ssh and tar**,
not git or Node on the server:

```bash
node tools/remote-deploy.mjs deploy  --host user@server --dir /opt/torrent-search
node tools/remote-deploy.mjs upgrade --host user@server --ref v1.1.0   # upgrade / pin a version
node tools/remote-deploy.mjs status  --host user@server
node tools/remote-deploy.mjs logs    --host user@server
node tools/remote-deploy.mjs doctor  --host user@server                # diagnose inside the container
```

> `.env` and `downloads/` are **never overwritten** when pushing — that is your configuration and your
> downloaded files. The code is transferred as a tar stream and the target directory is replaced, so do
> not keep unrelated files there.

**Security (important)**: this service has **no authentication** — anyone who can reach it can create
download tasks (and thus write files into the download directory). The container therefore binds to the
server's loopback by default; reach it through an SSH tunnel:

```bash
node tools/remote-deploy.mjs tunnel --host user@server
# then open http://127.0.0.1:8787/ locally
```

To let other devices on your LAN connect, set `TORRENT_SEARCH_BIND=0.0.0.0` in the server's `.env` and
run `upgrade` again, making sure the firewall only allows trusted subnets. **Do not** expose it directly
to the internet — put it behind an authenticating reverse proxy if you need that.

### Configuration

Everything tunable lives in `.env` (created from `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TORRENT_SEARCH_PORT` | `8787` | Host port |
| `TORRENT_SEARCH_DOWNLOADS` | `./downloads` | Host directory for downloads (e.g. `/volume1/downloads` on a NAS) |
| `TORRENT_SEARCH_BACKEND` | `auto` | `auto` / `builtin` / `qbittorrent` |
| `TORRENT_SEARCH_QBITTORRENT` | `http://host.docker.internal:8080` | qBittorrent WebUI on the host |
| `HTTPS_PROXY` / `HTTP_PROXY` | empty | Route search requests through a host proxy (P2P is TCP/UDP; a proxy does not help it) |

Inside the container (already set by the image):

| Variable | Default (native / container) | Meaning |
| --- | --- | --- |
| `TORRENT_SEARCH_HOST` | `127.0.0.1` / `0.0.0.0` | Bind address. In a container it must be `0.0.0.0` or port mapping cannot reach it |
| `TORRENT_SEARCH_PORT` | `8787` | Listen port |
| `TORRENT_SEARCH_DOWNLOAD_DIR` | `~/Downloads/torrent-search` / `/downloads` | Download directory |
| `TORRENT_SEARCH_CACHE` | user cache dir | Disk cache (the academic catalogue) |

Diagnostics inside the container:

```bash
docker compose exec torrent-search node bin/magnet-search.mjs doctor
```

> **Download directory permissions on Linux / NAS**: the container runs as a fixed UID/GID `10001`
> (non-root). With the `./downloads` bind mount, the host directory must be writable by that UID or
> downloads fail with a permission error. Two fixes:
>
> ```bash
> sudo chown -R 10001:10001 ./downloads      # 1) give the host directory to the container user
> # 2) or rebuild with your own UID/GID so both sides match:
> docker compose build --build-arg UID=$(id -u) --build-arg GID=$(id -g)
> ```
>
> Docker Desktop bind mounts (Windows/macOS) are permissive, so this usually needs no action.

### Three honest notes about containerising

**1. Docker does not bypass the blocking.** On Windows, Docker Desktop runs containers inside a WSL2 VM,
and their traffic still leaves through the host network stack — **Clash TUN can still capture it**.
The blocking also happens at the proxy provider's egress, independent of where the client runs.

**2. It adds things you must handle** (all handled by the image and code above): files need a volume,
the server must bind `0.0.0.0`, qBittorrent must be reached via `host.docker.internal`, and `doctor`
cannot see the host's TUN device from inside a container (it says so explicitly instead of guessing).

**3. The two cases where it genuinely pays off:**

- **Deploying to a Linux NAS / home server** for always-on use with access from other devices;
- **Pairing with a VPN container** so BT traffic takes a clean egress — see the commented example at the
  end of `docker-compose.yml` (`network_mode: service:gluetun`). Container traffic leaves through the VPN,
  unaffected by the host's Clash TUN, and VPN providers usually do not block P2P.

> Conversely: if your goal is just "download on this Windows machine", **running Node natively is simpler** —
> the project has zero dependencies, so `node bin/magnet-search.mjs serve` is all it takes.

---

## Tests

```bash
npm test           # 232 offline tests: parsing, aggregation, filtering, cache, HTTP, server, BT engine, download manager
npm run lint       # project self-check: full syntax check + conventions (zero deps / no XSS APIs / adapter contracts)
npm run smoke      # live smoke test: real requests to every online source, verifying field consistency
npm run fixtures   # re-capture test fixtures (run after a site redesign)
npm run check      # per-source connectivity self-check
```

Layers: pure functions → parsing (real fixtures) → aggregation (injected fake sources covering
filtering/cache/sorting) → network (local HTTP + a self-hosted CONNECT proxy) → BT engine
(**a local fake swarm**: a self-implemented tracker and seeding peer, verifying magnet → metadata →
pieces → verification → files on disk end to end) → server (a real HTTP server covering validation and
status codes) → live smoke test (the only layer that needs the internet).

CI (`.github/workflows/ci.yml`) runs the unit tests on Node 20/22/24 across Ubuntu and Windows;
the live smoke test runs as a separate non-blocking job (GitHub's cloud IPs get HTTP 403 from some sources).

---

## Project layout

```
bin/magnet-search.mjs   CLI entry point (search + download)
src/
  ├── aggregate / server / http / cache / models / magnet / size / format / xml / rss / categories
  ├── bt/               minimal BT engine (bencode, tracker, peer, torrent, storage, engine)
  ├── download/         task manager (queueing, concurrency, progress events, persistence, qBittorrent bridge)
  └── env.mjs           runtime environment adaptation (native vs container defaults)
web/                    web UI (plain HTML/CSS/JS, no build step, includes the downloads panel)
test/                   offline tests + real response fixtures + a local fake swarm
tools/                  fixture capture, live smoke test, project lint, screenshot generator
docs/                   requirements, source research, architecture and design decisions (Chinese)
.github/workflows/      CI
```

---

## Disclaimer

This tool only aggregates metadata that is already public on **public index sites** (titles, sizes,
info hashes, …). It does not host, cache, or distribute any copyrighted content. The built-in download
feature is standard BitTorrent client functionality; the tool itself provides and indexes no content.
Comply with the laws of your jurisdiction and with each site's terms of service, and use this tool only
for content you are entitled to obtain (for example open-source distributions or CC-licensed works).
