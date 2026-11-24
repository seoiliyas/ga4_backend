// ── Cloud Run startup bootstrapper ────────────────────────────────────────────
// Resolves GCP metadata project ID, applies idempotent Postgres schema with
// advisory locking, verifies GCS buckets, and seeds container.json if missing.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Storage } from '@google-cloud/storage';
import type { Pool as PoolType } from 'pg';
import {
  getAuthMode,
  getResolvedProjectId,
  getStorage,
  resolveBucketNames,
  resolveProjectId,
  resolveServiceAccountCredentials,
  setResolvedProjectId,
} from './env.js';
import { buildPgPoolConfig, closePool, getPool } from './db.js';
import { resolveLocalContainerPath } from './kv.js';

export const BOOTSTRAP_ADVISORY_LOCK_ID = 84729103;

export interface BootstrapStatus {
  ready: boolean;
  dbReady: boolean;
  gcsReady: boolean;
  projectId: string;
  authMode: string;
  dbMode: string;
  containerSeeded: boolean;
  warnings: string[];
  error?: string;
}

const IDEMPOTENT_COLUMN_MIGRATIONS = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS charts TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments TEXT;
ALTER TABLE invite_keys ADD COLUMN IF NOT EXISTS app TEXT;
`.trim();

function resolveSchemaPath(): string | null {
  const candidates = [
    process.env.SCHEMA_PATH?.trim(),
    '/app/schema-postgres.sql',
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schema-postgres.sql'),
    path.resolve(process.cwd(), '../schema-postgres.sql'),
    path.resolve(process.cwd(), 'schema-postgres.sql'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function detectGcpProjectIdFromMetadata(
  timeoutMs = 1500,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/project/project-id',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return undefined;
    const projectId = (await res.text()).trim();
    return projectId || undefined;
  } catch {
    return undefined;
  }
}

export async function applyPostgresSchema(pool: PoolType, schemaSql: string): Promise<void> {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query(`SELECT pg_advisory_lock(${BOOTSTRAP_ADVISORY_LOCK_ID})`);
    lockAcquired = true;
    await client.query('BEGIN');
    try {
      await client.query(schemaSql);
      await client.query(IDEMPOTENT_COLUMN_MIGRATIONS);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    if (lockAcquired) {
      await client
        .query(`SELECT pg_advisory_unlock(${BOOTSTRAP_ADVISORY_LOCK_ID})`)
        .catch(() => {});
    }
    client.release();
  }
}

export async function initDatabaseWithRetry(
  pool: PoolType,
  schemaPath: string,
  retries = Number(process.env.DB_CONNECT_RETRIES || 5),
): Promise<void> {
  const schemaSql = await readFile(schemaPath, 'utf-8');
  const maxAttempts = Math.max(1, Number.isFinite(retries) ? Math.floor(retries) : 5);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await applyPostgresSchema(pool, schemaSql);
      return;
    } catch (err: any) {
      if (attempt === maxAttempts - 1) throw err;
      const delayMs = Math.min(1000 * 2 ** attempt, 10_000);
      console.warn(
        `[bootstrap] DB init attempt ${attempt + 1}/${maxAttempts} failed (${err?.message ?? err}); retrying in ${delayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function ensureGcsSetup(
  storage: Storage,
  containerBucket: string,
  filesBucket: string | undefined,
  localContainerPath: string | null,
): Promise<{ gcsReady: boolean; containerSeeded: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  let gcsReady = false;
  let containerSeeded = false;
  const autoCreateBuckets = process.env.AUTO_CREATE_BUCKETS === 'true';
  const autoSeedContainer = process.env.AUTO_SEED_CONTAINER !== 'false';
  const rawLocation =
    process.env.GCS_BUCKET_LOCATION?.trim() || process.env.GCP_LOCATION?.trim() || 'US';
  const location = rawLocation.toLowerCase() === 'global' ? 'US' : rawLocation;

  const maybeCreateBucket = async (bucketName: string, label: string): Promise<void> => {
    if (!autoCreateBuckets) return;
    try {
      const [exists] = await storage.bucket(bucketName).exists();
      if (!exists) {
        await storage.createBucket(bucketName, {
          location,
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: true },
          },
        });
        console.log(`[bootstrap] Created GCS ${label} bucket gs://${bucketName} (${location})`);
      }
    } catch (err: any) {
      // roles/storage.objectAdmin lacks storage.buckets.get; fall through to object-level verification.
      const msg = String(err?.message ?? '');
      if (err?.code === 403 || msg.includes('storage.buckets.get')) {
        return;
      }
      throw err;
    }
  };

  try {
    await maybeCreateBucket(containerBucket, 'container');

    // Verify container bucket using object-level APIs covered by roles/storage.objectAdmin
    const cBucket = storage.bucket(containerBucket);
    const containerFile = cBucket.file('container.json');
    const [hasContainer] = await containerFile.exists();
    let containerOk = false;

    if (hasContainer) {
      containerOk = true;
      containerSeeded = true;
    } else if (autoSeedContainer && localContainerPath && existsSync(localContainerPath)) {
      const containerJson = await readFile(localContainerPath, 'utf-8');
      await containerFile.save(containerJson, {
        contentType: 'application/json',
        resumable: false,
      });
      containerOk = true;
      containerSeeded = true;
      console.log(
        `[bootstrap] Seeded gs://${containerBucket}/container.json from bundled ${localContainerPath}`,
      );
    } else {
      await cBucket.getFiles({ maxResults: 1 });
      containerOk = true;
      warnings.push(
        `gs://${containerBucket}/container.json not found; GTM mode will use bundled fallback if available.`,
      );
    }

    let filesOk = true;
    if (filesBucket) {
      await maybeCreateBucket(filesBucket, 'files');
      await storage.bucket(filesBucket).getFiles({ maxResults: 1 });
      filesOk = true;
    }

    gcsReady = containerOk && filesOk;
  } catch (err: any) {
    warnings.push(
      `GCS verification degraded (${err?.message ?? 'unknown error'}). Check GCP credentials and IAM permissions.`,
    );
    gcsReady = false;
  }

  return { gcsReady, containerSeeded, warnings };
}

export async function bootstrapServer(): Promise<BootstrapStatus> {
  const warnings: string[] = [];

  // 1. Resolve GCP project ID & inspect credential configuration
  const explicitProject =
    process.env.GCP_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCLOUD_PROJECT?.trim();

  let saProject: string | undefined;
  let saError: string | undefined;
  try {
    const sa = resolveServiceAccountCredentials();
    if (typeof sa?.project_id === 'string' && sa.project_id.trim()) {
      saProject = sa.project_id.trim();
    }
  } catch (err: any) {
    saError = err?.message ?? 'Invalid inline GCP service account JSON';
    warnings.push(saError);
  }

  if (!explicitProject && !saProject && !getResolvedProjectId()) {
    const detected = await detectGcpProjectIdFromMetadata();
    if (detected) {
      setResolvedProjectId(detected);
    }
  }

  const projectId = saError
    ? explicitProject || getResolvedProjectId() || 'gen-lang-client-0120793460'
    : resolveProjectId();
  const authMode = getAuthMode();

  // 2. Validate required & optional runtime secrets (without logging values)
  const encKey = process.env.TOKEN_ENCRYPTION_KEY?.trim() || '';
  if (encKey.length < 32) {
    warnings.push(
      'TOKEN_ENCRYPTION_KEY is missing or shorter than 32 characters (GA4 OAuth token encryption/signing requires >= 32 chars).',
    );
  }
  if (!process.env.GOOGLE_CLIENT_ID?.trim() || !process.env.GOOGLE_CLIENT_SECRET?.trim()) {
    warnings.push(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set (GA4 OAuth account connection will be unavailable).',
    );
  }

  // 3. Connect & initialize Cloud SQL / Postgres schema
  let dbReady = false;
  let dbMode = 'unconfigured';
  let dbTarget = 'none';
  let error: string | undefined;

  try {
    const { summary } = buildPgPoolConfig();
    dbMode = summary.mode;
    dbTarget = summary.target;

    const pool = getPool();
    if (process.env.AUTO_INIT_DB !== 'false') {
      const schemaPath = resolveSchemaPath();
      if (!schemaPath) {
        throw new Error('Could not locate schema-postgres.sql for automatic DB initialization');
      }
      await initDatabaseWithRetry(pool, schemaPath);
    } else {
      await pool.query('SELECT 1');
    }
    dbReady = true;
  } catch (err: any) {
    error = err?.message ?? 'Failed to initialize PostgreSQL connection/schema';
    console.error('[bootstrap] Database setup failed:', error);
  }

  // 4. Verify GCS buckets & auto-seed container.json if missing (non-fatal)
  let gcsReady = false;
  let containerSeeded = false;
  const localContainerPath = resolveLocalContainerPath();

  if (!saError) {
    const { containerBucket, filesBucket } = resolveBucketNames();
    const gcs = await ensureGcsSetup(getStorage(), containerBucket, filesBucket, localContainerPath);
    gcsReady = gcs.gcsReady;
    containerSeeded = gcs.containerSeeded;
    warnings.push(...gcs.warnings);
  } else if (localContainerPath) {
    warnings.push('GCS skipped due to invalid inline service account JSON; using local fallback.');
  }

  const ready = dbReady;
  console.log(
    JSON.stringify({
      event: 'bootstrap_complete',
      ready,
      dbReady,
      gcsReady,
      containerSeeded,
      projectId,
      authMode,
      dbMode,
      dbTarget,
      warningsCount: warnings.length,
    }),
  );
  for (const w of warnings) {
    console.warn(`[bootstrap] WARNING: ${w}`);
  }

  return {
    ready,
    dbReady,
    gcsReady,
    projectId,
    authMode,
    dbMode,
    containerSeeded,
    warnings,
    ...(error ? { error } : {}),
  };
}

let isDirectRun = false;
try {
  if (typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv[1]) {
    isDirectRun =
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  }
} catch {
  isDirectRun = false;
}

if (isDirectRun) {
  bootstrapServer()
    .then(async (status) => {
      await closePool().catch(() => {});
      process.exit(status.dbReady ? 0 : 1);
    })
    .catch(async (err) => {
      console.error('[bootstrap] Fatal error:', err);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
