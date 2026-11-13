# syntax=docker/dockerfile:1
# Localkan web UI (frontend): the built app served as static files by nginx on port 80.
# Put your own reverse proxy in front: "/" -> this container, "/api" -> the server container.
#   docker build -f apps/web/Dockerfile -t localkan-web .

FROM node:26-alpine AS build
RUN npm install -g pnpm@12.16.1 && npm cache clean --force
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/bridge/package.json apps/bridge/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile --filter "@localkan/web..."
COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN pnpm --filter @localkan/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/healthz || exit 1
