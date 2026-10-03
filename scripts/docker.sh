#!/usr/bin/env sh
#
# 种子搜索 —— Docker 一键部署 / 一键升级
#
#   sh scripts/docker.sh deploy              首次部署（构建并启动，等待健康检查）
#   sh scripts/docker.sh upgrade             升级到最新 main（失败自动回滚）
#   sh scripts/docker.sh upgrade --ref v1.1.0 升级到指定 tag/分支
#   sh scripts/docker.sh upgrade --no-cache  不使用构建缓存
#   sh scripts/docker.sh status              容器状态 + 健康检查
#   sh scripts/docker.sh logs                跟随日志（Ctrl+C 退出）
#   sh scripts/docker.sh down                停止并移除容器（下载文件保留）
#
# 下载文件与任务记录都在 ./downloads（或 .env 里的 TORRENT_SEARCH_DOWNLOADS）卷里，
# 升级、重建、删除容器都不会动它们。

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

SERVICE=torrent-search
DEFAULT_PORT=8787
# 健康检查的等待次数与间隔（慢机器可以调大）
HEALTH_ATTEMPTS=${TORRENT_SEARCH_HEALTH_ATTEMPTS:-30}
HEALTH_INTERVAL=${TORRENT_SEARCH_HEALTH_INTERVAL:-2}

die() {
  printf '\n✗ %s\n' "$1" >&2
  exit 1
}

info() {
  printf '  %s\n' "$1"
}

# ---------------------------------------------------------------- 环境检查

# docker compose（v2 插件）优先，找不到时回退到老式的 docker-compose
COMPOSE=""
detect_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    die "找不到 docker 命令。Windows/macOS 请安装 Docker Desktop，Linux 请安装 docker engine 与 compose 插件。"
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    info "提示：用的是老式 docker-compose，建议升级到 docker compose（v2）"
  else
    die "docker compose 不可用。请安装 compose 插件，或升级 Docker。"
  fi
}

compose() {
  # shellcheck disable=SC2086
  $COMPOSE "$@"
}

# 读取 .env 里的端口（没有就用默认值）
resolve_port() {
  if [ -f .env ]; then
    PORT=$(grep -E '^TORRENT_SEARCH_PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d ' \r')
  fi
  [ -n "${PORT:-}" ] || PORT=$DEFAULT_PORT
  printf '%s' "$PORT"
}

# 等容器内的健康检查通过（默认最多约 60 秒）
#
# 用容器自带的 wget（alpine 的 busybox 有）而不是 `node -e "<一段 JS>"`：
# 后者含有 > 与 || 这类字符，一旦调用链里经过 cmd.exe（例如用 .cmd 包装的 docker），
# 就会被当成重定向/命令分隔符而解析错乱。wget 只有普通参数，任何外壳都安全。
wait_healthy() {
  i=0
  while [ "$i" -lt "$HEALTH_ATTEMPTS" ]; do
    if compose exec -T "$SERVICE" wget -q -O /dev/null "http://127.0.0.1:8787/api/health" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

ensure_env_file() {
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      info "已从 .env.example 生成 .env（可修改端口、下载目录、下载后端）"
    fi
  fi
}

# 绑定挂载的目录属主由宿主机决定，容器里的属主会被盖掉：
#   - Docker 在宿主机上以 root 创建缺失的挂载源目录（例如 ./downloads）；
#   - 容器以非 root（镜像里的 UID/GID 10001）运行 → 写不进去 → 下载报权限错误。
# 解法是让两边 UID/GID 一致：在 Linux 上按当前用户重建镜像。
# （Docker Desktop 的绑定挂载是模拟的、宽松的，不需要也不该传这些参数。）
build_args() {
  if [ "${TORRENT_SEARCH_FIX_OWNER:-1}" = "0" ]; then
    return 0
  fi
  if [ "$(uname -s 2>/dev/null)" = "Linux" ] && command -v id >/dev/null 2>&1; then
    printf -- '--build-arg UID=%s --build-arg GID=%s' "$(id -u)" "$(id -g)"
  fi
}

# 准备好宿主机上的下载目录（存在就不动），避免 Docker 用 root 创建
prepare_downloads_dir() {
  DIR=$(resolve_downloads_dir)
  case "$DIR" in
    /*) TARGET="$DIR" ;;
    *) TARGET="./${DIR#./}" ;;
  esac
  [ -d "$TARGET" ] || mkdir -p "$TARGET" 2>/dev/null || true
}

# 构建镜像（带上属主对齐参数）
build_image() {
  # shellcheck disable=SC2086
  compose build $(build_args)
}

print_url() {
  PORT=$(resolve_port)
  printf '\n  Web UI   http://127.0.0.1:%s/\n' "$PORT"
  printf '  JSON API http://127.0.0.1:%s/api/search?q=ubuntu\n' "$PORT"
  printf '  下载目录 %s（宿主机）\n' "$(resolve_downloads_dir)"

  BIND=$(resolve_bind)
  if [ "$BIND" != "127.0.0.1" ]; then
    # 绑到了非回环：提示局域网地址与"没有鉴权"这件事
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$LAN_IP" ] || LAN_IP=$(ipconfig getifaddr en0 2>/dev/null)
    printf '\n  监听 %s：局域网内可通过 http://%s:%s/ 访问\n' "$BIND" "${LAN_IP:-<服务器IP>}" "$PORT"
    printf '  注意：本服务没有鉴权，请确保防火墙/安全组只放行可信网段\n'
  fi
}

# 读取 .env 里的监听地址（没有就用默认值：只绑回环）
resolve_bind() {
  BIND=""
  if [ -f .env ]; then
    BIND=$(grep -E '^TORRENT_SEARCH_BIND=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d ' \r')
  fi
  [ -n "$BIND" ] || BIND=127.0.0.1
  printf '%s' "$BIND"
}

resolve_downloads_dir() {
  DIR=""
  if [ -f .env ]; then
    DIR=$(grep -E '^TORRENT_SEARCH_DOWNLOADS=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d ' \r')
  fi
  [ -n "$DIR" ] || DIR=./downloads
  printf '%s' "$DIR"
}

# ---------------------------------------------------------------- 命令

cmd_deploy() {
  detect_compose
  ensure_env_file
  prepare_downloads_dir

  printf '\n▸ 构建并启动容器（首次构建需要几分钟）\n'
  build_image
  compose up -d

  printf '\n▸ 等待健康检查通过\n'
  if wait_healthy; then
    printf '\n✓ 部署完成\n'
    print_url
    printf '\n  后续升级：sh scripts/docker.sh upgrade\n'
  else
    printf '\n✗ 容器已启动但健康检查未通过。看日志：\n' >&2
    compose logs --tail 50 "$SERVICE" >&2 || true
    exit 1
  fi
}

cmd_upgrade() {
  detect_compose
  ensure_env_file

  REF=""
  NO_CACHE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref)
        [ $# -ge 2 ] || die "--ref 需要一个参数（tag 或分支名）"
        REF="$2"
        shift 2
        ;;
      --no-cache)
        NO_CACHE="--no-cache"
        shift
        ;;
      *)
        die "upgrade 不支持这个参数：$1"
        ;;
    esac
  done

  # 用 git 管理的部署才能一键升级；tarball 安装的只能重新构建
  if [ ! -d .git ]; then
    info "这不是 git 仓库（可能来自 tarball），跳过代码更新，直接重建镜像"
  else
    command -v git >/dev/null 2>&1 || die "需要 git 才能升级代码"

    if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      printf '\n✗ 检测到本地未提交的改动，已中止以免丢失你的修改：\n\n' >&2
      git status --short --untracked-files=no >&2
      printf '\n  先提交（git commit）或暂存（git stash）后再升级。\n' >&2
      exit 1
    fi

    BEFORE=$(git rev-parse --short HEAD)
    printf '\n▸ 拉取代码（当前 %s）\n' "$BEFORE"
    git fetch --tags --prune

    if [ -n "$REF" ]; then
      git checkout --quiet "$REF"
    elif [ -n "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" ]; then
      git pull --ff-only
    else
      # detached HEAD（通常是上次用 --ref 升级留下的）：先切回默认分支再拉取，
      # 否则 git pull 会直接报错
      DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
      [ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH=main
      info "当前不在分支上（detached HEAD），切回 $DEFAULT_BRANCH"
      git checkout --quiet "$DEFAULT_BRANCH" || die "切回 $DEFAULT_BRANCH 失败，请手动处理"
      git pull --ff-only
    fi

    AFTER=$(git rev-parse --short HEAD)
    if [ "$BEFORE" = "$AFTER" ]; then
      info "代码已是最新（$AFTER），继续重建镜像以确保一致"
    else
      info "代码：$BEFORE → $AFTER"
    fi
  fi

  printf '\n▸ 重建并重启容器（下载文件与任务记录不受影响）\n'
  prepare_downloads_dir
  if [ -n "$NO_CACHE" ]; then
    # shellcheck disable=SC2086
    compose build --no-cache $(build_args)
  else
    build_image
  fi
  compose up -d

  printf '\n▸ 等待健康检查通过\n'
  if wait_healthy; then
    printf '\n✓ 升级完成\n'
    print_url
    return 0
  fi

  # 健康检查失败 → 回滚到升级前的提交
  printf '\n✗ 升级后健康检查未通过\n' >&2
  compose logs --tail 50 "$SERVICE" >&2 || true

  if [ -d .git ] && [ -n "${BEFORE:-}" ]; then
    printf '\n▸ 回滚到 %s\n' "$BEFORE" >&2
    git checkout --quiet "$BEFORE" || true
    build_image || true
    compose up -d || true
    printf '  已回滚。请把上面的日志作为 issue 反馈。\n' >&2
  else
    printf '  无法自动回滚（不是 git 仓库或没有记录升级前版本）。\n' >&2
  fi
  exit 1
}

cmd_status() {
  detect_compose
  compose ps
  printf '\n▸ 健康检查\n'
  if wait_healthy; then
    printf '✓ 服务正常\n'
    print_url
  else
    printf '✗ 健康检查未通过\n' >&2
    exit 1
  fi
}

cmd_logs() {
  detect_compose
  compose logs -f --tail 100 "$SERVICE"
}

cmd_down() {
  detect_compose
  compose down
  printf '\n✓ 已停止并移除容器。下载文件仍在 %s（未被删除）。\n' "$(resolve_downloads_dir)"
}

usage() {
  cat <<'EOF'
种子搜索 —— Docker 一键部署 / 一键升级

用法：sh scripts/docker.sh <命令> [参数]

命令：
  deploy                 首次部署：构建镜像并启动，等待健康检查通过
  upgrade [参数]         升级：拉取最新代码 → 重建镜像 → 重启 → 健康检查（失败自动回滚）
                         --ref <tag|分支>   升级到指定版本，例如 --ref v1.1.0
                         --no-cache         不使用构建缓存
  status                 查看容器状态与健康检查
  logs                   跟随日志
  down                   停止并移除容器（下载文件保留）

说明：
  下载文件与任务记录保存在 ./downloads 卷（可用 .env 的 TORRENT_SEARCH_DOWNLOADS 改），
  升级、重建、删容器都不会影响它们；重启后未完成的下载会自动续传。
EOF
}

COMMAND="${1:-}"
[ $# -gt 0 ] && shift

case "$COMMAND" in
  deploy) cmd_deploy "$@" ;;
  upgrade) cmd_upgrade "$@" ;;
  status) cmd_status "$@" ;;
  logs) cmd_logs "$@" ;;
  down) cmd_down "$@" ;;
  '' | help | -h | --help) usage ;;
  *) usage; die "未知命令：$COMMAND" ;;
esac
