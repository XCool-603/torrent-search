# 种子搜索 —— 容器镜像
#
# 这个项目是**零运行时依赖**的（只用 Node 内置模块），所以镜像里没有 npm install、
# 没有 node_modules，构建只需要拷贝源码。这也是为什么容器化的收益主要体现在
# 「部署到 Linux 服务器/NAS 常驻」和「配合 VPN 容器」，而不是环境一致性。

FROM node:22-alpine

# 固定 UID/GID：绑定挂载会盖掉镜像里的属主，非 root 进程可能因此写不进下载目录。
# 需要和宿主对齐时重新构建：docker compose build --build-arg UID=$(id -u) --build-arg GID=$(id -g)
ARG UID=10001
ARG GID=10001

# 先建用户——后面的 COPY --chown 需要它已存在。
# -h 必须给：用户没有 HOME 时，很多工具写 ~/.cache 会失败，而且报错位置离根因很远。
RUN addgroup -g "${GID}" app \
 && adduser -u "${UID}" -G app -h /home/app -s /sbin/nologin -D app

WORKDIR /app

# 源码（零依赖：不需要 package-lock / npm ci）。
# 用 --chown 直接固化属主，避免再叠一层 chown -R（那会让镜像多一个数据层）。
COPY --chown=app:app package.json README.md ./
COPY --chown=app:app bin ./bin
COPY --chown=app:app src ./src
COPY --chown=app:app web ./web
COPY --chown=app:app test ./test
COPY --chown=app:app tools ./tools
COPY --chown=app:app docs ./docs

# 运行期要写的目录：镜像里新建的目录不受 COPY --chown 影响，必须显式建好并交给 app
RUN install -d -o app -g app /downloads /home/app/.cache

# USER 只出现一次，放在所有需要 root 的步骤之后
USER app

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
