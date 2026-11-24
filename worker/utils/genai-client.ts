// utils/genai-client.ts
// ── Google Gemini client factory (Cloudflare Workers + GCP Cloud Run) ─────────

import { GoogleGenAI } from '@google/genai/node';
import { Env } from '../types';

/**
 * Parses a GCP service account JSON payload provided either as raw JSON or Base64-encoded JSON.
 * Uses Web-standard APIs so it remains compatible with both Cloudflare Workers and Node 22.
 */
export function parseServiceAccountJson(raw: string): Record<string, any> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Empty service account JSON');
  }

  let jsonText = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(normalized);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      jsonText = new TextDecoder().decode(bytes);
    } catch {
      throw new Error('Invalid service account JSON (expected JSON object or Base64-encoded JSON)');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Invalid service account JSON (failed to parse JSON payload)');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid service account JSON (payload must be a JSON object)');
  }

  return parsed as Record<string, any>;
}

export function createGeminiClient(env: Env): GoogleGenAI {
  const saJson = env.GEMINI_SERVICE_ACCOUNT_JSON || env.GCP_SERVICE_ACCOUNT_JSON;
  const location = env.GCP_LOCATION || 'global';

  // Cloudflare Workers / inline SA deployments: service account JSON passed via env/secret.
  if (saJson) {
    const sa = parseServiceAccountJson(saJson);
    const project =
      env.GCP_PROJECT_ID || (typeof sa.project_id === 'string' ? sa.project_id : undefined);
    if (!project) {
      throw new Error('Missing GCP_PROJECT_ID in env and project_id in service account JSON');
    }
    return new GoogleGenAI({
      vertexai: true,
      project,
      location,
      googleAuthOptions: {
        credentials: sa,
      },
    });
  }

  // GCP Cloud Run / local ADC: use Application Default Credentials
  const project = env.GCP_PROJECT_ID || 'gen-lang-client-0120793460';
  return new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });
}
