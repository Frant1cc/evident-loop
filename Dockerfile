# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine

FROM ${NODE_IMAGE} AS dependencies
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.11.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY packages/stream-protocol/package.json ./packages/stream-protocol/package.json
RUN --mount=type=cache,id=evident-loop-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM dependencies AS backend-build
COPY packages/stream-protocol/ ./packages/stream-protocol/
COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/src/ ./backend/src/
RUN pnpm --filter @evident-loop/stream-protocol build \
    && pnpm --filter backend build \
    && pnpm --filter backend deploy --prod --legacy /out/backend \
    && test -f /out/backend/node_modules/@evident-loop/stream-protocol/dist/index.js

FROM dependencies AS frontend-build
COPY packages/stream-protocol/ ./packages/stream-protocol/
COPY frontend/ ./frontend/
RUN pnpm --filter @evident-loop/stream-protocol build \
    && pnpm --filter frontend build

FROM ${NODE_IMAGE} AS backend
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=backend-build --chown=node:node /out/backend/package.json ./package.json
COPY --from=backend-build --chown=node:node /out/backend/node_modules/ ./node_modules/
RUN node ./node_modules/playwright/cli.js install --with-deps --only-shell chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend-build --chown=node:node /out/backend/dist/ ./dist/
COPY --chown=node:node deploy/backend/healthcheck.mjs deploy/backend/seed-demo.mjs ./
COPY --chown=node:node deploy/knowledge/ ./demo-knowledge/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "healthcheck.mjs"]
CMD ["node", "dist/index.js"]

FROM ${NGINX_IMAGE} AS nginx
ENV NGINX_ENVSUBST_FILTER=SITE_HOST
COPY --from=frontend-build /workspace/frontend/dist/ /usr/share/nginx/html/
COPY deploy/nginx/application.conf /etc/nginx/snippets/application.conf
COPY deploy/nginx/health.conf /etc/nginx/conf.d/health.conf
RUN rm -f /etc/nginx/conf.d/default.conf
EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8081/_health || exit 1
