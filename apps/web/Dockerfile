# MomentumScan dashboard image. Build from the REPO ROOT:
#   docker compose build web
# NEXT_PUBLIC_ENGINE_URL is baked in at build time (browser code); the
# default http://localhost:3001 is correct for running on your own machine
# because docker-compose publishes the engine on that port.
FROM node:20-alpine

RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/engine/package.json apps/engine/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter web...

COPY packages/shared packages/shared
COPY apps/web apps/web

ARG NEXT_PUBLIC_ENGINE_URL=http://localhost:3001
ENV NEXT_PUBLIC_ENGINE_URL=$NEXT_PUBLIC_ENGINE_URL
RUN cd apps/web && pnpm exec next build

EXPOSE 3000
CMD ["sh", "-c", "cd apps/web && exec pnpm exec next start -p 3000"]
