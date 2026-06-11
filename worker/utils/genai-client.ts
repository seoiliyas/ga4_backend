// utils/genai-client.ts
// ── GenAI client factory – Vertex AI (service account) for Cloudflare Workers ─

import { GoogleGenAI } from '@google/genai/node';  // ← THIS is the important change
import { Env } from '../types';

export function createGenAIClient(env: Env): GoogleGenAI {
    console.log('[GenAI] GCP_PROJECT_ID present:', !!env.GCP_PROJECT_ID);
    console.log('[GenAI] GCP_LOCATION present:', !!env.GCP_LOCATION);
    console.log('[GenAI] GCP_SERVICE_ACCOUNT_JSON present:', !!env.GCP_SERVICE_ACCOUNT_JSON);

    if (!env.GCP_PROJECT_ID || !env.GCP_LOCATION || !env.GCP_SERVICE_ACCOUNT_JSON) {
        throw new Error('Missing Vertex AI credentials: GCP_PROJECT_ID, GCP_LOCATION, and GCP_SERVICE_ACCOUNT_JSON are all required.');
    }

    const credentials = JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
    return new GoogleGenAI({
        vertexai: true,
        project: env.GCP_PROJECT_ID,
        location: env.GCP_LOCATION,
        googleAuthOptions: { credentials },
    });
}