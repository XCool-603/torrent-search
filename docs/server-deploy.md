# 服务器部署与端口配置（torrent-search v1.3.0）

> **读者**：刚 `git clone` 完仓库、要在**一台 Linux 服务器**上把它跑起来的人。
> **目标**：照着抄命令就能跑起来，并且知道**端口 / 绑定地址 / 防火墙 / 安全组**怎么改、怎么验证。
> **适用版本**：v1.3.0（`package.json` 里的 `version`）。

---

## 0. 先读这一条：部署脚本已经全部删除（v1.3.0 破坏性变更）

v1.3.0 删掉了 `scripts/docker.sh`、`scripts/docker.ps1`、`tools/remote-deploy.mjs`。
**仓库里已经不存在这三个文件**，所有部署/升级/诊断都改用**原生 `docker compose` 命令**。

如果你从旧文档、旧笔记或某个 AI 的回答里抄到下面这种命令：

```bash
sh scripts/docker.sh deploy        # ❌ v1.3.0 起不存在，会直接报 No such file or directory
```

请换成第 3 节和第 10 节的命令。

删掉脚本不只是"换个写法"，它顺手修掉了一个真实故障：旧脚本**只 `build` + `up`，不会 `git pull`**，
于是"升级"实际上是在**反复构建旧代码**。现在升级必须显式 `git pull`（见第 10 节）。

---

## 1. 前置条件

| 需要 | 说明 |
| --- | --- |
| Linux 服务器 | x86_64 / arm64 均可 |
| Docker Engine | 24+（需要 BuildKit，`Dockerfile` 用了 `COPY --chown`） |
| Docker Compose | **v2 插件**（命令是 `docker compose`，不是 `docker-compose`） |
| 磁盘 | 镜像本身很小（项目**零运行时依赖**，镜像里没有 `npm install`、没有 `node_modules`）；空间主要给下载目录 |
| 端口 | 默认 `8787` |

确认环境：

```bash
docker --version
docker compose version      # 必须能输出 v2.x；报 "unknown command" 说明只有旧的 docker-compose
```

> 本项目的镜像**不需要联网装依赖**，构建只是把源码拷进去，所以国内服务器不需要配 npm 镜像。

---

## 2. 拿到代码，生成 `.env`

```bash
git clone https://github.com/XCool-603/torrent-search.git /opt/torrent-search
cd /opt/torrent-search

cp .env.example .env
```

`/opt/torrent-search` 只是本文档的示例路径，换成你自己的目录即可（下文所有命令都在这个目录里执行）。

`.env` 已被 `.gitignore` 忽略，**不会进版本库**，可以放心写本机路径和端口。

`.env.example` 里每一项的含义：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `TORRENT_SEARCH_PORT` | `8787` | **宿主机对外端口**（容器内始终是 8787，见第 4 节） |
| `TORRENT_SEARCH_BIND` | `127.0.0.1` | 把端口发布到哪个宿主地址。默认只有服务器本机能访问（见第 5 节） |
| `TORRENT_SEARCH_DOWNLOADS` | `./downloads` | 宿主机上存下载文件的目录；NAS 上可写 `/volume1/downloads` |
| `APP_UID` / `APP_GID` | `10001` | 构建镜像时用的 UID/GID，用来对齐 `./downloads` 的属主（见第 3 节） |
| `TORRENT_SEARCH_BACKEND` | `auto` | `auto` / `builtin` / `qbittorrent` |
| `TORRENT_SEARCH_QBITTORRENT` | `http://host.docker.internal:8080` | 宿主机上的 qBittorrent WebUI |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 注释掉了 | 让**搜索请求**走宿主机代理；BT 的 P2P 是 TCP/UDP，代理帮不上 |

> ⚠️ **一个容易踩的坑**：`docker-compose.yml` 没有写 `env_file:`。`.env` 里的变量只有在
> `docker-compose.yml` 里被 `${...}` **引用过**，才会真正传进容器。上面这张表里的变量都已接好；
> 但你自己往 `.env` 里加一个新变量（比如 `FOO=1`）是**不会**进容器的 —— 需要同时在
> `docker-compose.yml` 的 `environment:` 里加上 `FOO: ${FOO:-}`。

---

## 3. 第一次启动

```bash
mkdir -p downloads

APP_UID=$(id -u) APP_GID=$(id -g) docker compose up -d --build

docker compose ps                                  # 状态：应该是 Up / healthy
docker compose logs -f --tail=50                   # 看日志，Ctrl+C 只退出日志，不停容器
```

第一次构建要拉 `node:22-alpine` 基础镜像，慢的话几分钟。

### 为什么要带 `APP_UID` / `APP_GID`

容器以**非 root** 用户运行，而 `./downloads` 是**绑定挂载** —— 挂载会盖掉镜像里的属主，
两边 UID 不一致就写不进下载目录（报 `EACCES`）。所以构建时把宿主的号传进去：

```bash
APP_UID=$(id -u) APP_GID=$(id -g) docker compose up -d --build
```

**不传也能跑**，此时用镜像默认的 `10001`，但要把下载目录交给它：

```bash
sudo chown -R 10001:10001 ./downloads
```

两个必须注意的点：

- **变量名是 `APP_UID` / `APP_GID`，不能写成 `UID=` / `GID=`。**
  bash 里 `UID` 是**只读内置变量**，`UID=$(id -u) ...` 会直接报 `UID: readonly variable`。
- 如果你把 `.env.example` 里的 `APP_UID=10001` 一起复制进了 `.env`，**命令行上的
  `APP_UID=$(id -u)` 仍然优先**（shell 环境变量优先于 `.env`），不用去改 `.env`。

启动后默认只能从服务器本机访问：<http://127.0.0.1:8787/>（怎么让外面访问见第 5～7 节）。

---

## 4. 端口配置：三种设法与优先级

优先级**从高到低**：

| 优先级 | 怎么设 | 例子 | 生效范围 |
| --- | --- | --- | --- |
| 1（最高） | 命令行 `--port` | `node bin/magnet-search.mjs serve --port 9000` | 只对**不走 Docker 直接跑**有效 |
| 2 | 环境变量 `TORRENT_SEARCH_PORT` | `TORRENT_SEARCH_PORT=9000 docker compose up -d` | Docker 与直接跑都有效 |
| 3（最低） | 项目根目录 `.env` 里的 `TORRENT_SEARCH_PORT` | `.env` 写 `TORRENT_SEARCH_PORT=9000` | Docker 与直接跑都有效 |
| — | 都不设 | 默认 `8787` | — |

v1.3.0 起，`.env` **本地直接跑也会读**（以前只在容器里生效，同一个 `.env` 在本地被静默忽略，
改端口时两种跑法行为不一致）。已有环境变量优先，所以临时覆盖照样有效。

### ⚠️ Docker 部署时，改的是"宿主机对外端口"，不是容器内端口

`docker-compose.yml` 里的端口映射是：

```yaml
ports:
  - "${TORRENT_SEARCH_BIND:-127.0.0.1}:${TORRENT_SEARCH_PORT:-8787}:8787"
#    └── 发布到哪个宿主地址 ──┘ └─ 宿主端口 ─┘ └─ 容器内端口（固定）
```

同时容器里的环境变量被显式钉成 `TORRENT_SEARCH_PORT: "8787"`，所以：

- **容器内应用永远监听 8787**（`EXPOSE 8787`、健康检查也都按 8787 走）；
- 你改 `TORRENT_SEARCH_PORT=9000`，得到的是 **宿主 9000 → 容器 8787**。

也就是说：改端口**不需要**动 `Dockerfile`、不需要改健康检查，只改 `.env` 或命令前加环境变量即可。

| 你想做的事 | 改哪里 |
| --- | --- |
| 换宿主机对外端口（永久） | `.env` 里 `TORRENT_SEARCH_PORT=9000`，然后 `docker compose up -d` |
| 临时换一次 | `TORRENT_SEARCH_PORT=9000 docker compose up -d` |
| 不走 Docker，改监听端口 | `--port 9000`，或 `TORRENT_SEARCH_PORT=9000`，或 `.env` |

> 💡 建议避开 `8080`：面板、代理、各种测试服务都爱用它，撞车概率高。`8787` 本身就是个冷门端口。

---

## 5. `TORRENT_SEARCH_BIND`：把端口发布到哪个地址

它决定 `docker compose` 的 `ports:` **左侧**绑到哪个宿主地址：

| 取值 | 含义 | 谁能访问 |
| --- | --- | --- |
| `127.0.0.1`（默认） | 只绑回环 | **只有服务器本机**（以及 SSH 隧道，见第 6 节） |
| `0.0.0.0` | 绑所有网卡 | 局域网 / 公网（还要过第 7 节的两道门） |

```bash
# .env
TORRENT_SEARCH_BIND=0.0.0.0
```

然后重启让映射生效：

```bash
docker compose up -d
```

**为什么默认是 `127.0.0.1`：本服务没有鉴权。** 任何能访问到它的人都能创建下载任务
（也就是往你的下载目录写文件）。在服务器上，推荐保持默认 + SSH 隧道。

> ⚠️ `TORRENT_SEARCH_BIND` 和 `TORRENT_SEARCH_DOWNLOADS` **只被 `docker-compose.yml` 使用**，
> 应用代码根本不读它们。所以**不走 Docker 直接跑**的时候，这两个变量写进 `.env` 是**没有效果**的，
> 要分别用 `TORRENT_SEARCH_HOST`（监听地址，本机默认 `127.0.0.1`、容器里默认 `0.0.0.0`）
> 和 `TORRENT_SEARCH_DOWNLOAD_DIR`（下载目录）。

---

## 6. 访问方式一：SSH 隧道（推荐）

服务器上保持 `TORRENT_SEARCH_BIND=127.0.0.1`，在**你自己的电脑**上开一条隧道：

```bash
ssh -N -L 8787:127.0.0.1:8787 user@你的服务器IP
```

- `-N` = 不执行远程命令，只做端口转发；
- 这条命令会一直挂着，**别关这个窗口**；
- 然后本地浏览器打开 <http://127.0.0.1:8787/>（Windows 上用系统自带 OpenSSH 的 `ssh` 一样可以）。

**改了端口，隧道两边都要同步改**（左边是本地端口，右边是服务器上的对外端口）：

```bash
# 服务器上 .env 写了 TORRENT_SEARCH_PORT=9000
ssh -N -L 9000:127.0.0.1:9000 user@你的服务器IP
# 然后本地浏览器打开 http://127.0.0.1:9000/
```

这样端口完全不对外暴露，不需要碰防火墙，也不需要碰云安全组。

---

## 7. 访问方式二：对局域网 / 公网开放（两道门都要开）

**先想清楚**：本服务没有鉴权。下面这条路意味着"能连到这个端口的人就能往你服务器写文件"。

1. 服务器上改 `.env`：

   ```bash
   TORRENT_SEARCH_BIND=0.0.0.0
   TORRENT_SEARCH_PORT=8787        # 想换端口就一起改
   ```

2. 重启并确认端口已经发布到 `0.0.0.0`：

   ```bash
   docker compose up -d
   docker compose config | grep -A3 ports      # 期望看到 host_ip: 0.0.0.0 和 published: "8787"
   ```

3. **门一：宿主防火墙**（按你系统上装的那个选一条）：

   ```bash
   # ufw（Ubuntu / Debian 常见）
   sudo ufw allow 8787/tcp
   sudo ufw status

   # firewalld（CentOS / RHEL / Rocky 常见）
   sudo firewall-cmd --permanent --add-port=8787/tcp
   sudo firewall-cmd --reload

   # 只有 iptables 时（临时规则，重启后失效，记得持久化）
   sudo iptables -I INPUT -p tcp --dport 8787 -j ACCEPT
   ```

4. **门二：云厂商安全组**（阿里云 / 腾讯云 / AWS / Oracle … 的入站规则）：
   放行 **TCP 8787**。**这一步在服务器里查不出来**，但它是"本机 curl 通、外面连不上"的头号原因。

5. 从**另一台机器**验证（不是服务器自己）：

   ```bash
   curl -fsS http://服务器IP:8787/api/health
   ```

### 两个必须知道的事实

- **两道门缺一不可**：宿主防火墙放行 ≠ 云安全组放行。症状完全一样，都是"服务器上 `curl 127.0.0.1` 通，
  外面连不上"。
- **别只依赖 ufw**：Docker 发布端口时会自己写 iptables 的 NAT/DOCKER 链，某些配置下会**绕过 ufw 的
  INPUT 规则**。所以"只开了 ufw 却已经暴露"是真事。**最可靠的闸门是绑定地址**（`TORRENT_SEARCH_BIND=127.0.0.1`），
  而不是防火墙规则。

没有鉴权还要对外开放时，**强烈建议**只放行可信来源 IP，并在前面套一层反向代理做认证
（Caddy / Nginx 的 basic auth 都够用）。

---

## 8. 改端口后的完整验证（从内到外，按顺序排除）

假设你把端口改成了 `9000`：

```bash
# ① compose 真的取到了新端口（这一步只解析配置，不启动容器）
docker compose config | grep -A3 ports
#   期望：
#     ports:
#       - mode: ingress
#         target: 8787          ← 容器内端口，永远是 8787
#         published: "9000"     ← 宿主对外端口，应该是你改的值
#         host_ip: 127.0.0.1    ← 或 0.0.0.0

# ② 容器在跑，且端口已发布
docker compose ps

# ③ 宿主真的在监听，并看清绑在哪个地址
ss -lntp | grep 9000
#   期望 0.0.0.0:9000（或 *:9000）才能被外部访问；
#   如果只有 127.0.0.1:9000，说明 TORRENT_SEARCH_BIND 还是 127.0.0.1

# ④ 本机通不通
curl -fsS http://127.0.0.1:9000/api/health

# ⑤ 外网仍不通 → 去查第 7 节的两道门（宿主防火墙 + 云安全组）
```

| 现象 | 根因 | 怎么修 |
| --- | --- | --- |
| ① 里 `published` 还是 `8787` | 改了 `.env` 但没生效（不在项目目录、或改的是别的文件） | 确认在仓库根目录、`docker compose config` 里能搜到你的值 |
| ③ 完全没有 LISTEN | 容器没起来，或端口映射写错 | 先看 `docker compose ps` 和 `docker compose logs --tail=50` |
| ③ 是 `127.0.0.1:9000` 而不是 `0.0.0.0:9000` | `TORRENT_SEARCH_BIND` 还是默认值 | 改成 `0.0.0.0` 后 `docker compose up -d` |
| ④ 通、⑤ 不通 | 宿主防火墙或云安全组没放行 | 第 7 节的两道门，**两处都要查** |
| `docker compose config` 报变量插值错 | `.env` 里有语法问题 | 逐行核对 `.env.example` 的写法 |

> 服务器上没装 `curl` 时，可用 `wget -qO- http://127.0.0.1:9000/api/health`，
> 或 `node -e "fetch('http://127.0.0.1:9000/api/health').then(r=>r.text()).then(console.log)"`。

---

## 9. 版本核对：确认跑起来的确实是 v1.3.0

这是 v1.3.0 特意补上的能力：版本号**从 `package.json` 读取**（`src/version.mjs`），
不再硬编码在源码里，所以 `/api/health` 返回的版本是真实版本，可以用来判断"我到底跑的是哪一版"。

```bash
curl -fsS http://127.0.0.1:8787/api/health
```

期望输出（节选）：

```json
{
  "ok": true,
  "version": "1.3.0",
  "uptimeSec": 15,
  "node": "v22.x.x",
  "proxy": null,
  "covers": { "enabled": true },
  "downloads": { "enabled": true, "dir": "/downloads", "active": 0, "backend": "auto", "qbit": { "configured": true } }
}
```

- 端口改成 9000 就换成 `http://127.0.0.1:9000/api/health`；
- 走 SSH 隧道时，在你**本地**跑同样的 `curl` 即可；
- 关注 `version` 字段：不是 `1.3.0` 就说明镜像/代码是旧的（见下面的排查）。

**容器内**核对（`node:22-alpine` 里**没有 `curl`**，所以用 `node`）：

```bash
# CLI 自己报的版本
docker compose exec torrent-search node bin/magnet-search.mjs --version
# → 1.3.0

# 容器内打健康检查（等价于镜像 HEALTHCHECK 的做法）
docker compose exec torrent-search node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(t=>console.log(t))"
```

> **显示旧版本怎么办**：`docker compose build` / `up -d --build` **不会自动拉新代码**。
> 先 `git pull`，再 `docker compose up -d --build`。这正是旧部署脚本被删掉的原因之一。
> 容器状态也可以直接看：`docker compose ps` 的 STATUS 列会显示 `(healthy)`。

---

## 10. 升级

```bash
cd /opt/torrent-search

git pull                                                  # ← 不能省
APP_UID=$(id -u) APP_GID=$(id -g) docker compose up -d --build

docker compose ps
curl -fsS http://127.0.0.1:8787/api/health                # 确认 version 已是新版本
```

- 已下载的文件和未完成任务**不受影响**：`./downloads` 是绑定挂载，任务记录 `tasks.json` 就在同目录。
- **从 v1.2.x 升到 v1.3.0**：部署脚本被删除属于破坏性变更，把你 crontab / 运维手册 / 笔记里
  所有 `sh scripts/docker.sh ...` 换成上面的原生命令，否则会报 `No such file or directory`。

---

## 11. 另一条路：不走 Docker，直接在服务器上跑

项目**零运行时依赖**，只要能跑 Node 就够了。有些场景（比如服务器上不想装 Docker）这样更省事。

```bash
node --version                       # 需要 >= 20（package.json 的 engines 要求）
cd /opt/torrent-search
cp .env.example .env

node bin/magnet-search.mjs serve
# → Web UI http://127.0.0.1:8787/
```

要点：

- **v1.3.0 起本地直接跑也会读 `.env`**（`bin/magnet-search.mjs` 启动时调用 `loadEnvFile()`），
  和 `docker compose` 行为一致；
- 端口优先级同上：`--port` > 环境变量 > `.env`；
- **本机默认只绑 `127.0.0.1`**（容器里默认 `0.0.0.0`）。要对外就用 `TORRENT_SEARCH_HOST=0.0.0.0`
  或 `node bin/magnet-search.mjs serve --host 0.0.0.0`；
- `.env` 里的 `TORRENT_SEARCH_BIND` / `TORRENT_SEARCH_DOWNLOADS` **在这里不生效**（那是 compose 专用，
  见第 5 节），用 `TORRENT_SEARCH_HOST` / `TORRENT_SEARCH_DOWNLOAD_DIR` 代替；
- 常用诊断：`node bin/magnet-search.mjs doctor`。

---

## 12. 常见问题速查

| 现象 / 报错 | 根因 | 修法 |
| --- | --- | --- |
| `sh: scripts/docker.sh: No such file or directory` | 抄了 v1.2.x 的旧命令 | 部署脚本已在 v1.3.0 删除，改用第 3 / 10 节的 `docker compose` 命令 |
| `UID: readonly variable` | 用了 `UID=$(id -u)` | 改成 `APP_UID=$(id -u) APP_GID=$(id -g)` |
| 下载时报 `EACCES` / `permission denied` | 容器用户与 `./downloads` 属主不一致 | 带 `APP_UID=$(id -u) APP_GID=$(id -g)` 重新 `up -d --build`；或用默认 10001 时 `sudo chown -R 10001:10001 ./downloads` |
| `docker compose ps` 显示 `unhealthy` | 应用没起来 | `docker compose logs --tail=100`；`docker compose exec torrent-search node bin/magnet-search.mjs doctor` |
| 服务器本机 `curl` 通，外面连不上 | 两道门没开全，或 `BIND` 还是 `127.0.0.1` | 第 7 节：宿主防火墙 **和** 云安全组都要放行；`ss -lntp \| grep <端口>` 确认绑的是 `0.0.0.0` |
| `ss -lntp` 里根本没有该端口 | 容器没起来 / 端口映射写错 | `docker compose ps`、`docker compose config \| grep -A3 ports` |
| `/api/health` 里的 `version` 不是 1.3.0 | 没拉新代码就 build | `git pull` 后 `docker compose up -d --build` |
| 改 `.env` 里的自定义变量，容器里看不到 | compose 没引用该变量 | 在 `docker-compose.yml` 的 `environment:` 里加 `KEY: ${KEY:-}`（见第 2 节） |
| 容器里连不上宿主机的 qBittorrent | 容器里的 `127.0.0.1` 指容器自己 | 用 `http://host.docker.internal:8080`（compose 已配好 `extra_hosts`） |
| BT 下载完全没速度 | 网络封锁 P2P（代理/TUN 拦截） | 在**宿主机**上排查；或按 `docker-compose.yml` 末尾的注释，让容器走 gluetun 之类的 VPN 出口 |
| 端口想换但不确定改哪 | 分不清宿主端口与容器端口 | 第 4 节：只改 `.env` 的 `TORRENT_SEARCH_PORT`，容器内始终 8787 |

---

## 附录 A：变量归属一览（谁读它）

| 变量 | 谁读 | 默认 | 说明 |
| --- | --- | --- | --- |
| `TORRENT_SEARCH_PORT` | compose（宿主端口）+ 应用（监听端口） | `8787` | Docker 下改的是**宿主对外端口**；直接跑时是**监听端口** |
| `TORRENT_SEARCH_BIND` | **只有 compose** | `127.0.0.1` | 端口发布到哪个宿主地址 |
| `TORRENT_SEARCH_DOWNLOADS` | **只有 compose** | `./downloads` | 宿主上下载目录（卷的左侧） |
| `APP_UID` / `APP_GID` | **只有 compose 的 build.args** | `10001` | 镜像内运行用户的 UID/GID |
| `TORRENT_SEARCH_HOST` | 应用 | 本机 `127.0.0.1` / 容器 `0.0.0.0` | 监听地址 |
| `TORRENT_SEARCH_DOWNLOAD_DIR` | 应用 | `~/Downloads/torrent-search` / `/downloads` | 下载目录（容器内路径） |
| `TORRENT_SEARCH_CACHE` | 应用 | 用户缓存目录 / `/home/app/.cache/torrent-search` | 磁盘缓存 |
| `TORRENT_SEARCH_BACKEND` | 应用 | `auto` | `auto` / `builtin` / `qbittorrent` |
| `TORRENT_SEARCH_QBITTORRENT` | 应用 | 本机 `127.0.0.1:8080` / 容器 `host.docker.internal:8080` | qBittorrent WebUI |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 应用（搜索请求） | 空 | 对 BT 的 P2P 流量无效 |

---

## 附录 B：本文档命令的验证状态（如实说明）

写这份文档的机器上**没有安装 Docker**，所以按"验过 / 没验过"分开列：

**已在本机（Windows，Node v26.8.1）实跑验证：**

| 命令 | 结果 |
| --- | --- |
| `node bin/magnet-search.mjs --version` | 输出 `1.3.0` |
| 临时目录放 `.env`（`TORRENT_SEARCH_PORT=9123`）后 `node bin/magnet-search.mjs serve` | 实际监听 `127.0.0.1:9123`，`curl http://127.0.0.1:9123/api/health` 返回 `"version": "1.3.0"` —— 证明**本地直接跑会读 `.env`**，且版本来自 `package.json` |
| `TORRENT_SEARCH_PORT=9124 node ... serve`（`.env` 里是 9123） | 实际监听 9124 —— 证明**环境变量优先于 `.env`** |
| `node ... serve --port 9125`（`.env` 里是 9123） | 实际监听 9125 —— 证明**命令行 `--port` 优先级最高** |
| `git ls-files` 过滤 `scripts/`、`remote-deploy` | 不存在 `scripts/docker.sh`、`scripts/docker.ps1`、`tools/remote-deploy.mjs`（只有 `skills/torrent-search/scripts/torrent-search.mjs`，与本项目部署无关） |

**未在本机验证（因为没有 Docker），需要你在有 Docker 的机器上执行：**

- 第 3、7、8、10 节里所有 `docker compose ...` 命令；
- 容器内 `docker compose exec ...` 两条命令；
- 宿主防火墙 / 云安全组的放行效果。

其中 compose 相关路径由 CI 的 `docker-verify` job 真实覆盖（`.github/workflows/ci.yml`）：
`docker compose config`、端口与绑定地址可被 `.env` 覆盖（断言 `published: "9000"` 与 `host_ip: 0.0.0.0`）、
三种 UID/GID 场景下真实构建镜像、非 root 运行、下载目录可写、容器启动并通过 `/api/health`。
