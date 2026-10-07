# 种子搜索 —— 容器镜像
#
# 这个项目是**零运行时依赖**的（只用 Node 内置模块），所以镜像里没有 npm install、
# 没有 node_modules，构建只需要拷贝源码。这也是为什么容器化的收益主要体现在
# 「部署到 Linux 服务器/NAS 常驻」和「配合 VPN 容器」，而不是环境一致性。

FROM node:22-alpine

# 运行期用户的 UID/GID。
#
# 为什么要可配：绑定挂载会盖掉镜像里的属主，若容器用户和宿主目录属主不一致，
# 非 root 进程就写不进下载目录。需要对齐时重新构建：
#   docker compose build --build-arg UID=$(id -u) --build-arg GID=$(id -g)
#
# ⚠ 这里必须容忍冲突：官方 node 镜像**自带 node 用户，UID/GID 就是 1000**，
# 而 Linux 上 `id -u` 通常正好是 1000 —— 直接 adduser 会因 UID 已占用而构建失败。
# 所以下面先探测，已存在就复用；全程用**数字 ID**，不依赖用户叫什么名字。
ARG UID=10001
ARG GID=10001

RUN set -eux; \
    # 拒绝以 root 运行：否则 --build-arg UID=0 会悄悄产出 root 容器。
    # 本镜像不需要 root（监听 8787，只写 /downloads 与缓存目录）。
    if [ "${UID}" = "0" ]; then \
      echo "拒绝 UID=0：本镜像设计为非 root 运行（若确实需要，请改这里）" >&2; exit 1; \
    fi; \
    # 组：GID 空闲才建，否则复用现有组名（adduser -G 需要名字）
    if ! grep -qE ":${GID}:" /etc/group; then addgroup -g "${GID}" app; fi; \
    # 用户：UID 空闲才建；已被占用（例如 node:1000）就跳过，直接用那个身份
    if ! grep -qE ":${UID}:" /etc/passwd; then \
      GROUP_NAME="$(awk -F: -v gid="${GID}" '$3 == gid { print $1 }' /etc/group)"; \
      adduser -u "${UID}" -G "${GROUP_NAME}" -h /home/app -s /sbin/nologin -D app; \
    fi; \
    # 运行期要写的目录：-h 之外还得真建出来，否则写缓存会失败且报错位置离根因很远。
    # 用 chown 数字 ID，不用 install -d -o <用户名>——复用已有用户时名字不是 app。
    mkdir -p /downloads /home/app/.cache; \
    chown "${UID}:${GID}" /downloads /home/app/.cache

WORKDIR /app

# 源码（零依赖：不需要 package-lock / npm ci）。
# 用 --chown 直接固化属主，避免再叠一层 chown -R（那会让镜像多一个数据层）。
COPY --chown=${UID}:${GID} package.json README.md ./
COPY --chown=${UID}:${GID} bin ./bin
COPY --chown=${UID}:${GID} src ./src
COPY --chown=${UID}:${GID} web ./web
COPY --chown=${UID}:${GID} test ./test
COPY --chown=${UID}:${GID} tools ./tools
COPY --chown=${UID}:${GID} docs ./docs

# USER 只出现一次，放在所有需要 root 的步骤之后；用数字 ID，避免依赖用户名
USER ${UID}:${GID}

# 容器内必须绑 0.0.0.0，否则宿主机的端口映射进不来（代码里的容器检测也会给出同样的默认值，
# 这里显式写出来是为了让 `docker inspect` 一眼能看清）
ENV HOME=/home/app \
    TORRENT_SEARCH_HOST=0.0.0.0 \
    TORRENT_SEARCH_PORT=8787 \
    TORRENT_SEARCH_DOWNLOAD_DIR=/downloads \
    TORRENT_SEARCH_CACHE=/home/app/.cache/torrent-search

EXPOSE 8787

# 下载目录挂卷，否则文件会留在容器里（容器一删就没了）
VOLUME ["/downloads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.TORRENT_SEARCH_PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 信号处理交给 compose 的 init: true（等价于 tini），这里直接跑 Node
CMD ["node", "bin/magnet-search.mjs", "serve"]
