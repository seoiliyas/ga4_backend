# Backend is a Cloudflare Worker (KV + D1 bindings). On Cloud Run it runs through
# wrangler's local runtime (workerd/miniflare) with local KV/D1 persistence.
FROM node:22-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm-workspace.yaml has no members; it only carries allowBuilds (install-script approvals)
RUN pnpm install --frozen-lockfile

COPY wrangler.toml tsconfig.json schema.sql ./
COPY worker ./worker
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV PORT=8080 \
    PERSIST_DIR=/data \
    CI=true \
    WRANGLER_SEND_METRICS=false \
    CLOUDFLARE_INCLUDE_PROCESS_ENV=true
EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
