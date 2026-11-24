// types.ts
// ── Shared types & constants for the worker ────────────────────────────────────

export interface Env {
  GTM_CONTAINER: KVNamespace;
  gtm_chat_history: D1Database;
  CHAT_FILES?: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  IMG_BB_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  PUBLIC_BASE_URL?: string;
  GEMINI_SERVICE_ACCOUNT_JSON?: string;
  GCP_SERVICE_ACCOUNT_JSON?: string;
  GCP_PROJECT_ID?: string;
  GCP_LOCATION?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  app: 'gtm' | 'ga4';
  created_at: number;
}

export interface StoredOAuthRow {
  access_token: string;
  refresh_token: string;
  token_expiry: number;
  scope: string;
  connected_email: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Gemini AI constants (Google AI / Vertex AI)
export const GEMINI_MODEL = 'gemini-2.5-flash';
export const CACHE_TTL_SECONDS = 3600; // 1 hour
export const KV_CACHE_KEY = 'gemini_gtm_context_cache';
