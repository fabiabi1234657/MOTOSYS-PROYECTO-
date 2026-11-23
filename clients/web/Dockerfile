FROM node:22.18.0-bookworm-slim AS build
WORKDIR /clients/web
COPY web/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY shared /clients/shared
COPY web/ .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28.0-alpine
COPY --from=build /clients/web/dist /usr/share/nginx/html
USER 101
