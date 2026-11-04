# BFA: website + console API + MCP gateway + demo seller in one image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r --filter "./packages/**" build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
RUN chmod +x /app/scripts/start-hosted.sh
EXPOSE 8787
CMD ["/app/scripts/start-hosted.sh"]
