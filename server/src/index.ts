// ── GTM Auditor API on Cloud Run (Hono) — reuses worker/routes + worker/services ──
import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { buildEnv } from './env.js';
import { checkDbHealth, closePool } from './db.js';
import { bootstrapServer, type BootstrapStatus } from './bootstrap.js';

// Reuse existing handlers (Web-standard Request/Response — no rewrite needed)
import { handleAuth } from '../../worker/routes/auth.js';
import { handleSessions } from '../../worker/routes/sessions.js';
import { handleGa4OAuthCallback, handleGa4 } from '../../worker/routes/ga4-oauth.js';
import { handleChat } from '../../worker/routes/chat.js';
import { handleModels } from '../../worker/routes/models.js';
import { handleFiles } from '../../worker/routes/files.js';
import { authenticate, purgeExpiredTokens } from '../../worker/middleware/auth.js';

const app = new Hono();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

app.use(
  '*',
  cors({
    origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-BrightHorizon-App'],
  }),
);

// ── Startup bootstrap state (runs immediately without blocking HTTP bind) ────
let latestBootstrapStatus: BootstrapStatus | null = null;
let inFlightBootstrap: Promise<BootstrapStatus> | null = null;

function runBootstrap(): Promise<BootstrapStatus> {
  if (inFlightBootstrap) return inFlightBootstrap;
  inFlightBootstrap = bootstrapServer()
    .then((status) => {
      latestBootstrapStatus = status;
      return status;
    })
    .finally(() => {
      inFlightBootstrap = null;
    });
  return inFlightBootstrap;
}

async function ensureBootstrapped(): Promise<BootstrapStatus> {
  if (latestBootstrapStatus?.dbReady) {
    return latestBootstrapStatus;
  }
  return runBootstrap();
}

void runBootstrap();

// Fast liveness probe for Cloud Run (/health) & local Docker (/healthz — reserved by GFE on run.app)
const livenessResponse = (c: any) =>
  c.json({
    ok: true,
    ready: latestBootstrapStatus?.ready ?? false,
    db: latestBootstrapStatus?.dbReady ?? false,
    gcs: latestBootstrapStatus?.gcsReady ?? false,
    time: Date.now(),
  });

app.get('/health', livenessResponse);
app.get('/healthz', livenessResponse);

// Deep readiness probe verifying Postgres schema + SELECT 1
app.get('/readyz', async (c) => {
  const status = await ensureBootstrapped();
  const db = await checkDbHealth();
  const ok = status.ready && db.ok;
  return c.json(
    {
      ok,
      ready: status.ready,
      db: db.ok,
      gcs: status.gcsReady,
      containerSeeded: status.containerSeeded,
      projectId: status.projectId,
      authMode: status.authMode,
      dbMode: status.dbMode,
      latencyMs: db.latencyMs,
      warnings: status.warnings,
      ...(db.error ? { error: db.error } : status.error ? { error: status.error } : {}),
    },
    ok ? 200 : 503,
  );
});

app.all('/api/*', async (c) => {
  const request = c.req.raw as Request;
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') return c.text('Not Found', 404);
  const resource = parts[1];

  const status = await ensureBootstrapped();
  if (!status.dbReady) {
    return c.json({ error: 'Database is initializing or unavailable' }, 503);
  }

  const env = buildEnv();

  try {
    // Unauthenticated
    if (resource === 'auth') {
      return handleAuth(request, env, url, parts);
    }
    if (resource === 'ga4' && parts[2] === 'oauth' && parts[3] === 'callback' && request.method === 'GET') {
      return handleGa4OAuthCallback(request, env, url, parts);
    }

    // Auth wall
    const currentUser = await authenticate(request, env.gtm_chat_history);
    if (!currentUser) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (resource === 'ga4') return handleGa4(request, env, url, parts, currentUser);
    if (resource === 'sessions') return handleSessions(request, env, url, parts, currentUser);
    if (resource === 'files') return handleFiles(request, env, url, parts, currentUser);
    if (resource === 'chat') return handleChat(request, env, url, parts, currentUser);
    if (resource === 'models') return handleModels(request, env, url, parts, currentUser);

    return c.text('Not Found', 404);
  } catch (err: any) {
    console.error('Unhandled server error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// Periodic cleanup of expired Bearer tokens (matches Worker daily Cron)
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  if (!latestBootstrapStatus?.dbReady) return;
  void purgeExpiredTokens(buildEnv().gtm_chat_history).catch((err) =>
    console.warn('[server] Token cleanup failed:', err),
  );
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

const port = Number(process.env.PORT ?? 8080);
console.log(`[server] listening on 0.0.0.0:${port}`);
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });

const shutdown = async (signal: string) => {
  console.log(`[server] ${signal} received, shutting down gracefully...`);
  clearInterval(cleanupTimer);
  server.close();
  await closePool().catch((err) => console.error('[server] Error closing DB pool:', err));
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
