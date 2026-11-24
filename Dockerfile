# ── Stage 1: Install production-only dependencies for Cloud Run ─────────────
FROM node:22-slim AS deps
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /app

COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=node:node server/package.json ./server/package.json
COPY --chown=node:node frontend/apps/gtm/package.json ./frontend/apps/gtm/package.json
COPY --chown=node:node frontend/apps/ga4/package.json ./frontend/apps/ga4/package.json
COPY --chown=node:node frontend/packages/shared/package.json ./frontend/packages/shared/package.json

# Install only root + @gtm-auditor/server production dependencies
RUN pnpm install --frozen-lockfile --prod --filter . --filter @gtm-auditor/server...

# ── Stage 2: Minimal hardened Cloud Run runtime image ─────────────────────────
FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules (root @google/genai + server deps incl. tsx)
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/server/node_modules ./server/node_modules

# Copy runtime source, Postgres schema, bundled GTM container fallback, and entrypoint
COPY --chown=node:node package.json ./
COPY --chown=node:node worker ./worker
COPY --chown=node:node server ./server
COPY --chown=node:node schema-postgres.sql ./
COPY --chown=node:node data/container-minified.json ./data/container-minified.json
COPY --chown=node:node docker-entrypoint.sh ./

RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod 755 /app/docker-entrypoint.sh

WORKDIR /app/server
USER node

EXPOSE 8080

# Safe Cloud Run defaults (override via env vars / Secret Manager as needed)
ENV NODE_ENV=production \
    PORT=8080 \
    GCP_LOCATION=us-central1 \
    AUTO_INIT_DB=true \
    AUTO_SEED_CONTAINER=true \
    AUTO_CREATE_BUCKETS=false \
    X_ACCEL_BUFFERING=no

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]
