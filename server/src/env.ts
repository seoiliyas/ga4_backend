// ── Build Cloudflare-compatible Env from GCP primitives (cached singletons) ───

import { Storage } from '@google-cloud/storage';
import { parseServiceAccountJson } from '../../worker/utils/genai-client.js';
import { getDb, PgD1Db } from './db.js';
import { GcsKv } from './kv.js';
import { GcsR2 } from './r2.js';

export type GcpAuthMode = 'inline-sa-json' | 'credentials-file' | 'adc';

let storage: Storage | null = null;
let cachedDb: PgD1Db | null = null;
let cachedKv: GcsKv | null = null;
let cachedR2: GcsR2 | null = null;
let resolvedProjectId: string | undefined;

export function setResolvedProjectId(id: string | undefined): void {
  const clean = id?.trim() || undefined;
  if (clean !== resolvedProjectId) {
    resolvedProjectId = clean;
    storage = null;
    cachedKv = null;
    cachedR2 = null;
  }
}

export function getResolvedProjectId(): string | undefined {
  return resolvedProjectId;
}

export function getAuthMode(env: NodeJS.ProcessEnv = process.env): GcpAuthMode {
  if (
    env.GCP_SERVICE_ACCOUNT_JSON?.trim() ||
    env.GCP_SERVICE_ACCOUNT_JSON_B64?.trim() ||
    env.GEMINI_SERVICE_ACCOUNT_JSON?.trim()
  ) {
    return 'inline-sa-json';
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    return 'credentials-file';
  }
  return 'adc';
}

export function resolveServiceAccountCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, any> | undefined {
  const raw =
    env.GCP_SERVICE_ACCOUNT_JSON?.trim() ||
    env.GCP_SERVICE_ACCOUNT_JSON_B64?.trim() ||
    env.GEMINI_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return undefined;
  return parseServiceAccountJson(raw);
}

export function resolveProjectId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv =
    env.GCP_PROJECT_ID?.trim() ||
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    env.GCLOUD_PROJECT?.trim();
  if (fromEnv) return fromEnv;

  const creds = resolveServiceAccountCredentials(env);
  if (typeof creds?.project_id === 'string' && creds.project_id.trim()) {
    return creds.project_id.trim();
  }

  return resolvedProjectId || 'gen-lang-client-0120793460';
}

export function resolveBucketNames(
  env: NodeJS.ProcessEnv = process.env,
): { containerBucket: string; filesBucket: string | undefined } {
  const projectId = resolveProjectId(env);
  const containerBucket = env.CONTAINER_BUCKET?.trim() || `${projectId}-gtm-container`;

  const rawFilesBucket = env.FILES_BUCKET?.trim();
  const filesDisabled =
    rawFilesBucket !== undefined &&
    ['none', 'disabled', 'false'].includes(rawFilesBucket.toLowerCase());
  const filesBucket = filesDisabled
    ? undefined
    : rawFilesBucket || `${projectId}-chat-files`;

  return { containerBucket, filesBucket };
}

export function getStorage(): Storage {
  if (storage) return storage;
  const creds = resolveServiceAccountCredentials();
  const projectId = resolveProjectId();
  if (creds) {
    storage = new Storage({ projectId, credentials: creds });
  } else {
    storage = new Storage(projectId ? { projectId } : undefined);
  }
  return storage;
}

export function buildEnv(): any {
  const projectId = resolveProjectId();
  const { containerBucket, filesBucket } = resolveBucketNames();

  if (!cachedDb) cachedDb = getDb();
  if (!cachedKv) cachedKv = new GcsKv(getStorage(), containerBucket);
  if (filesBucket && !cachedR2) cachedR2 = new GcsR2(getStorage(), filesBucket);

  return {
    GTM_CONTAINER: cachedKv,
    gtm_chat_history: cachedDb,
    CHAT_FILES: filesBucket ? cachedR2 : undefined,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY ?? '',
    IMG_BB_API_KEY: process.env.IMG_BB_API_KEY,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    GEMINI_SERVICE_ACCOUNT_JSON: process.env.GEMINI_SERVICE_ACCOUNT_JSON,
    GCP_SERVICE_ACCOUNT_JSON:
      process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON_B64,
    GCP_PROJECT_ID: projectId,
    GCP_LOCATION: process.env.GCP_LOCATION ?? 'us-central1',
  };
}
