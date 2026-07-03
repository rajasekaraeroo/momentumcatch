# MomentumScan engine image. Build from the REPO ROOT:
#   docker compose build engine
# Runs the NestJS engine via tsx. If the MarketDataFeedV3.proto contract is
# missing at start, the entrypoint downloads it (packages/shared/proto is
# volume-mounted in docker-compose.yml so the file persists on the host).
FROM node:20-alpine

RUN corepack enable && apk add --no-cache bash curl
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# manifests first (layer caching: reinstall only when dependencies change)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/engine/package.json apps/engine/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter engine...

# sources + runtime assets
COPY packages/shared packages/shared
COPY apps/engine apps/engine
COPY config config
COPY scripts scripts

EXPOSE 3001
CMD ["bash", "-c", "\
  if [ ! -f packages/shared/proto/MarketDataFeedV3.proto ]; then \
    echo 'proto missing — downloading from Upstox docs...'; \
    bash scripts/fetch-proto.sh || echo 'WARNING: proto download failed; feed will not start (replay/API still work)'; \
  fi; \
  cd apps/engine && exec pnpm exec tsx src/main.ts"]
