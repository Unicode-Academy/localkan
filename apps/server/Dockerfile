# syntax=docker/dockerfile:1
# Localkan server (API + WebSocket hub). Build from the repo root:
#   docker build -f apps/server/Dockerfile -t localkan-server .
# Node runs the TypeScript sources directly (type stripping), so there is no build step.

FROM node:26-alpine AS deps
RUN npm install -g pnpm@12.16.1 && npm cache clean --force
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/bridge/package.json apps/bridge/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile --prod --filter "@localkan/server..."

FROM node:26-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/no-web
WORKDIR /app
COPY --from=deps /app ./
COPY packages/protocol/src packages/protocol/src
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/apps/server
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/index.ts"]
