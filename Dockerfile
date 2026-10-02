# 种子搜索 —— 容器镜像
#
# 这个项目是**零运行时依赖**的（只用 Node 内置模块），所以镜像里没有 npm install、
# 没有 node_modules，构建只需要拷贝源码。这也是为什么容器化的收益主要体现在
# 「部署到 Linux 服务器/NAS 常驻」和「配合 VPN 容器」，而不是环境一致性。

FROM node:22-alpine

WORKDIR /app

# 源码（零依赖：不需要 package-lock / npm ci）
COPY package.json README.md ./
COPY bin ./bin
COPY src ./src
COPY web ./web
COPY test ./test
COPY tools ./tools
COPY docs ./docs

# 以非 root 用户运行；准备好下载目录与缓存目录
RUN addgroup -S app && adduser -S app -G app \
 && mkdir -p /downloads /home/app/.cache \
 && chown -R app:app /app /downloads /home/app
USER app

# 容器内必须绑 0.0.0.0，否则宿主机的端口映射进不来（代码里的容器检测也会给出同样的默认值，
# 这里显式写出来是为了让 `docker inspect` 一眼能看清）
ENV TORRENT_SEARCH_HOST=0.0.0.0 \
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
