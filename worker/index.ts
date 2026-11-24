// ── GTM Auditor Worker — Entrypoint Router ────────────────────────────────────
//
// Thin router that dispatches to domain-specific route handlers.
// All business logic lives in routes/ and services/.

import { Env } from './types';
import { applyCors, getCorsHeaders, json } from './utils/http';
import { authenticate, purgeExpiredTokens } from './middleware/auth';
import { handleAuth } from './routes/auth';
import { handleSessions } from './routes/sessions';
import { handleGa4OAuthCallback, handleGa4 } from './routes/ga4-oauth';
import { handleChat } from './routes/chat';
import { handleModels } from './routes/models';
import { handleFiles } from './routes/files';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request, env.ALLOWED_ORIGINS),
      });
    }

    let response: Response;
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);

      // /api/<resource>/...
      if (parts[0] !== 'api') {
        response = new Response('Not Found', { status: 404 });
        return applyCors(response, request, env.ALLOWED_ORIGINS);
      }

      const resource = parts[1]; // 'sessions' | 'chat' | 'auth' | 'ga4' | 'files' | 'models'

      // ────────────────────────────────────────────────────────────────────
      // Unauthenticated routes
      // ────────────────────────────────────────────────────────────────────

      // /api/auth/* — authentication (handles its own auth for protected sub-routes)
      if (resource === 'auth') {
        response = await handleAuth(request, env, url, parts);
        return applyCors(response, request, env.ALLOWED_ORIGINS);
      }

      // /api/ga4/oauth/callback — Google redirects here (signed state verified inside)
      if (resource === 'ga4' && parts[2] === 'oauth' && parts[3] === 'callback' && request.method === 'GET') {
        response = await handleGa4OAuthCallback(request, env, url, parts);
        return applyCors(response, request, env.ALLOWED_ORIGINS);
      }

      // ────────────────────────────────────────────────────────────────────
      // Auth wall — all routes below require Bearer authentication
      // ────────────────────────────────────────────────────────────────────
      const currentUser = await authenticate(request, env.gtm_chat_history);
      if (!currentUser) {
        response = json({ error: 'Unauthorized' }, 401);
        return applyCors(response, request, env.ALLOWED_ORIGINS);
      }

      if (resource === 'ga4') {
        response = await handleGa4(request, env, url, parts, currentUser);
      } else if (resource === 'sessions') {
        response = await handleSessions(request, env, url, parts, currentUser);
      } else if (resource === 'files') {
        response = await handleFiles(request, env, url, parts, currentUser);
      } else if (resource === 'chat') {
        response = await handleChat(request, env, url, parts, currentUser);
      } else if (resource === 'models') {
        response = await handleModels(request, env, url, parts, currentUser);
      } else {
        response = new Response('Not Found', { status: 404 });
      }
    } catch (err: any) {
      console.error('Unhandled worker error:', err);
      response = json({ error: 'Internal Server Error' }, 500);
    }

    return applyCors(response, request, env.ALLOWED_ORIGINS);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeExpiredTokens(env.gtm_chat_history));
  },
};
