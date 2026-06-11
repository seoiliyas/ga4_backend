// ── GTM Auditor Worker — Entrypoint Router ────────────────────────────────────
//
// Thin router that dispatches to domain-specific route handlers.
// All business logic lives in routes/ and services/.

import { Env } from './types';
import { CORS, json } from './utils/http';
import { authenticate } from './middleware/auth';
import { handleAuth } from './routes/auth';
import { handleSessions } from './routes/sessions';
import { handleGa4OAuthCallback, handleGa4 } from './routes/ga4-oauth';
import { handleChat } from './routes/chat';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Make secrets available to helper modules (e.g. createChart → ImgBB upload)
    (globalThis as any).IMG_BB_API_KEY = env.IMG_BB_API_KEY;

    try {
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);

      // /api/<resource>/...
      if (parts[0] !== 'api') {
        return new Response('Not Found', { status: 404, headers: CORS });
      }

      const resource = parts[1]; // 'sessions' | 'chat' | 'auth' | 'ga4'

      // ────────────────────────────────────────────────────────────────────
      // Unauthenticated routes
      // ────────────────────────────────────────────────────────────────────

      // /api/auth/* — authentication (handles its own auth for protected sub-routes)
      if (resource === 'auth') {
        return handleAuth(request, env, url, parts);
      }

      // /api/ga4/oauth/callback — Google redirects here (no auth required)
      if (resource === 'ga4' && parts[2] === 'oauth' && parts[3] === 'callback' && request.method === 'GET') {
        return handleGa4OAuthCallback(request, env, url, parts);
      }

      // ────────────────────────────────────────────────────────────────────
      // Auth wall — all routes below require authentication
      // ────────────────────────────────────────────────────────────────────
      const currentUser = await authenticate(request, env.gtm_chat_history);
      if (!currentUser) {
        return json({ error: 'Unauthorized' }, 401);
      }

      // /api/ga4/* — GA4 OAuth actions + property listing
      if (resource === 'ga4') {
        return handleGa4(request, env, url, parts, currentUser);
      }

      // /api/sessions/* — session CRUD + messages
      if (resource === 'sessions') {
        return handleSessions(request, env, url, parts, currentUser);
      }

      // /api/chat — GTM streaming + GA4 function-calling
      if (resource === 'chat') {
        return handleChat(request, env, url, parts, currentUser);
      }

      return new Response('Not Found', { status: 404, headers: CORS });

    } catch (err: any) {
      // Global catch — ensures CORS headers are always present, even on unexpected crashes
      console.error('Unhandled worker error:', err);
      return json({ error: err.message || 'Internal Server Error' }, 500);
    }
  },
};