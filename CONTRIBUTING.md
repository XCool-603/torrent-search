# Contributing

Thanks for taking a look! This document covers what this project deliberately is, the hard
constraints that keep it that way, and how to get a change merged.

Issues and pull requests are welcome in **Chinese or English**.

---

## The constraints that define this project

These are not preferences — they are the project's identity, and `npm run lint` enforces most of them.

### 1. Zero runtime dependencies

Only Node built-ins (`node:`-prefixed imports). No `dependencies`, `optionalDependencies`, or
`peerDependencies` in `package.json`, no `npm install` step, no bundler, no build output.

This is why the project can be cloned and run with a single `node` command, and why the Docker image
needs no `npm ci`. If a change seems to need a library, open an issue first — usually the built-in
covers it (the screenshot tool, for example, talks to the browser's DevTools Protocol directly).

### 2. Node ≥ 20, on Windows, Linux and macOS

Avoid APIs newer than Node 20. CI runs Node 20/22/24 on Ubuntu and Windows, so anything newer will be
caught — but it costs a round trip. Two real examples of this biting us:

- `--test-timeout` and directory arguments to `node --test` behave differently across versions;
- unref'd timers can let the process exit while work is still pending (see `SpeedLimiter`).

If you need a version-specific API, feature-detect it and degrade gracefully.

### 3. The frontend stays plain and safe

`web/` is hand-written HTML/CSS/JS with no framework and no build step. The lint forbids:

- `innerHTML =`, `outerHTML =`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` —
  results come from third-party sites, so everything must go through `textContent` / `createElement`;
- external resources (`src=`/`href=`/`@import` pointing off-host) — the UI must not phone home or leak
  the queries you run.

### 4. Tests are offline by default

Unit tests must not touch the network. Use the existing helpers:

- `test/helpers/fake-swarm.mjs` — a local tracker plus a seeding peer, for end-to-end BT engine tests;
- `test/helpers/fake-qbit.mjs` — a fake qBittorrent Web API, for the download-bridge tests;
- `test/fixtures/` — real captured responses from each source (see `npm run fixtures`);
- `withTempDir` / `withFakeQbit` style wrappers so cleanup always runs, even when an assertion throws.

Only `npm run smoke` is allowed to hit the internet, and it runs as a non-blocking CI job.

### 5. Honesty in the data model

If a site does not provide a field, it stays `null` — never `0`, never a guess. `adult` comes only from
the site's own category tags, never from guessing at titles. Failures are surfaced with the reason
(a source error, a peer error class, a blocked port) instead of a vague "failed".

---

## Getting started

```bash
git clone https://github.com/XCool-603/torrent-search.git
cd torrent-search
node --version        # must be >= 20

npm test              # 232 offline tests
npm run lint          # syntax + project conventions
npm run check         # per-source connectivity (needs network)
npm run smoke         # live end-to-end smoke test (needs network)
```

There is nothing to install and nothing to build.

Useful during development:

```bash
node bin/magnet-search.mjs "ubuntu" --demo -v     # offline demo source, verbose
node bin/magnet-search.mjs serve --port 9000      # web UI on a custom port
node bin/magnet-search.mjs doctor                 # P2P environment diagnosis
node bin/magnet-search.mjs downloads              # task history
```

---

## Adding a data source

A source adapter is roughly 60 lines. Implement this contract in `src/sources/<id>.mjs`:

```js
export default {
  id: 'example',                  // stable id, used by --sources and the API
  name: 'Example Tracker',        // display name
  description: '一句话说明这个源的特点',   // shown by `magnet-search sources`
  kinds: ['general'],             // 'general' | 'anime' | 'academic' | ...
  defaultEnabled: true,
  homepage: 'https://example.org',

  /**
   * @param {string} query
   * @param {{fetchText: Function, fetchJson: Function, timeoutMs: number, proxy: string|null}} ctx
   * @returns {Promise<Array<object>>}
   */
  async search(query, ctx) {
    const xml = await ctx.fetchText(`https://example.org/search?q=${encodeURIComponent(query)}`, {
      timeoutMs: ctx.timeoutMs,
    });
    return parse(xml); // → [{ title, infoHash, magnet, size, seeders, leechers, publishedAt, category, adult }]
  },
};
```

Then register it in `src/sources/index.mjs`. `npm run lint` checks that every adapter file is
registered and that all required fields exist, so a forgotten registration fails the build rather
than silently doing nothing.

Rules of thumb:

- **Never invent data.** Unknown → `null`.
- **Normalise the info hash** to lowercase hex. Base32 magnets (dmhy) are handled by the shared helper.
- **Throw on failure** — the aggregator catches per-source errors and reports them; do not return `[]`
  to hide a broken source.
- **Add a fixture**: run `npm run fixtures` and add a test in `test/sources.test.mjs` covering the
  parser against the captured response.

---

## Code style

- ESM only, 2-space indent, single quotes, semicolons.
- JSDoc type annotations on exported functions (the project is plain JS, no TypeScript).
- Comments explain **why**, not what. Non-obvious workarounds should name the failure they prevent —
  there are several of those in this codebase, and they are the most valuable comments in it.
- Keep user-facing CLI/UI strings in Chinese, matching the existing tone. When you add a feature,
  update **both** `README.md` and `README.en.md`.
- Prefer small, focused modules. `src/bt/` is split by protocol layer for a reason: each file is
  testable on its own.

---

## Commits and pull requests

- Commit messages follow the common `type: summary` form (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `refactor:`). Explain the *reason* in the body when it is not obvious.
- One concern per pull request. A drive-by refactor mixed with a fix is hard to review.
- Before opening a PR:

  ```bash
  npm test && npm run lint
  ```

  Both must pass. CI additionally runs the matrix (Node 20/22/24 × Ubuntu/Windows) and the
  non-blocking live smoke test.

- Fill in the pull request template — the checklist exists because each item has broken a real
  release at least once.

---

## Reporting a bug

A useful bug report for this project usually contains:

1. **What you ran** and what you expected.
2. **`node bin/magnet-search.mjs doctor` output** — for anything download-related this is the single
   most useful thing you can paste. It distinguishes "the source is down" from "your network blocks P2P".
3. **Environment**: OS, Node version (`node --version`), and whether a proxy/VPN/TUN is active.
4. **Which source** misbehaved (`--sources <id>` isolates it), plus the raw response if a parser is at
   fault (`npm run check`, or `curl` the endpoint).

Please **redact** anything personal (IP addresses, proxy credentials, magnet links you would rather not
publish) before pasting.

---

## Deployment scripts

`scripts/docker.sh` (POSIX sh) and `scripts/docker.ps1` (Windows PowerShell) implement the documented
one-command deploy/upgrade: `deploy`, `upgrade [--ref <tag>] [--no-cache]`, `status`, `logs`, `down`.
Both must stay behaviourally identical — when you change one, change the other.

Rules that came out of real breakage:

- **`.ps1` files containing non-ASCII text must be saved as UTF-8 *with* a BOM.** Windows PowerShell 5.1
  reads scripts as ANSI without a BOM, so Chinese messages get mangled and can even swallow string
  terminators into syntax errors. `.sh` files are the opposite: **never** add a BOM, it breaks the shebang.
- **Don't treat untracked files as local modifications** when deciding whether an upgrade is safe.
  `deploy` creates `.env`, so a `git status --porcelain` check would block every upgrade. Use
  `--untracked-files=no` and keep `.env` in `.gitignore`.
- **Handle detached HEAD.** After `upgrade --ref v1.0.0` the checkout is detached, and a later plain
  `upgrade` would fail on `git pull`; switch back to the default branch first.
- **Record the current commit before rebuilding** so a failed health check can roll back.
- In PowerShell, `$Args` is an automatic variable (don't use it as a parameter name), and `& docker @($a + $b)`
  passes the whole array as *one* argument — build the array and splat it as `@var`.

Both scripts are verified without Docker by putting a stub `docker` (and `docker.cmd`) first on `PATH`
that logs its arguments and can simulate a failing health check; that covers deploy, upgrade,
the dirty-tree refusal, the detached-HEAD path and the rollback.

## Frontend performance and cover images

Two things worth knowing before touching `web/`:

**Rendering is chunked on purpose.** `renderRows()` builds rows detached, then inserts them in chunks of
`ROW_CHUNK_SIZE` (first chunk immediately, the rest via `requestIdleCallback`). Inserting 100 rows in one
go costs ~200ms of layout — a visible hitch. Keep the chunking, and keep per-row node count low.

Measure before and after with `npm run perf` (CDP-based, zero dependencies). It reports script/style/layout
time, long tasks and scroll frame rate, and separates render cost from network time. A regression shows up
as a new long task (>50ms) or dropped frames.

```bash
npm run perf -- --url "http://127.0.0.1:8787/?q=ubuntu" --page-size 100
```

**Covers are server-side and lazy.** `src/covers.mjs` cleans a torrent title into a searchable name
(`cleanTitle`), picks the most likely provider (`providersFor`), verifies the returned title actually
matches (`titleMatches` — a wrong cover is worse than none), and caches both metadata and image bytes.
The frontend only asks for rows that enter the viewport, in small batches, so a 100-row page never fires
100 lookups. If you add a provider: it must be keyless and GET-only (the HTTP client sends no request body),
and it needs tests for its parser plus a `matches()` heuristic.

Two traps found the hard way: `appendChild(fragment)` empties the fragment, so query the inserted rows
instead; and the batch response is all-or-nothing, so keep `MAX_COVER_BATCH` small for progressive display.

## The bundled AI-agent skill

`skills/torrent-search/` is a **DSH skill**: `SKILL.md` (frontmatter `name` + routing `description`) plus a
wrapper script that gives an agent a compact JSON interface to this tool.

```bash
npm run install-skill      # junction into ~/.dsh/skills/torrent-search
npm run install-skill -- --copy        # copy instead (no live sync)
npm run install-skill -- --uninstall
```

Two rules when touching it:

- **Keep the wrapper in-process.** It imports `src/` modules rather than spawning the CLI: in confined
  sandboxes a child process with piped stdio can fail, and in-process is simply faster. The only
  exception is `doctor`, which reuses the CLI with `stdio: 'inherit'` (no pipes).
- **Update `SKILL.md` when behaviour changes.** It is the agent's contract — flag names, the JSON shape,
  and the failure interpretations (`status` is the only success criterion; peer handshake errors mean the
  network blocks P2P, not that the tool is broken). `test/skill.test.mjs` checks the frontmatter against
  DSH's loader rules, the wrapper's command surface, and one end-to-end download through a local fake swarm.

## Regenerating the README screenshots

```bash
npm run screenshots
```

This drives a headless Edge/Chrome over the DevTools Protocol (no Playwright/Puppeteer) against a
**temporary** server instance with its own port and download directory, creates a real download from a
local fake swarm, and writes `docs/screenshot-search.png` and `docs/screenshot-downloads.png`.
It prints pixel statistics and fails if the result is a blank page, so a broken screenshot cannot slip
into the docs unnoticed.

---

## Security

This tool runs on your machine and can write files, so the security-relevant surfaces are:

- `/api/downloads` only accepts a `dir` **inside** the configured download root, and mutation requests
  are rejected when the `Origin` header is present and not local;
- delete operations resolve paths and refuse anything outside the task directory;
- the frontend never renders third-party text as HTML.

Please report anything that weakens those guarantees as a regular issue (or privately to the maintainer
if you believe it is exploitable).

## License

By contributing, you agree that your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
