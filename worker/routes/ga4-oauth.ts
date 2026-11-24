// ── GA4 OAuth route handler: /api/ga4/* ───────────────────────────────────────

import { Env, AuthUser } from '../types';
import { json, isOriginAllowed } from '../utils/http';
import { decryptToken, signState, verifyState } from '../utils/crypto';
import {
  storeOAuthTokens,
  getOAuthAccessToken,
  buildGoogleOAuthUrl,
  ga4OAuthResultPage,
} from '../services/ga4/oauth';
import { ga4RestGet, GA4_ADMIN_API_BASE } from '../services/ga4/api';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ACCOUNT_SUMMARY_PAGES = 20;

interface OAuthStatePayload {
  userId: string;
  ts: number;
  nonce: string;
  origin?: string;
}

function resolvePublicOrigin(request: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const xfProto = request.headers.get('X-Forwarded-Proto')?.split(',')[0]?.trim();
  const xfHost =
    request.headers.get('X-Forwarded-Host')?.split(',')[0]?.trim() ||
    request.headers.get('Host')?.trim();
  if (xfProto && xfHost && /^(https?)$/i.test(xfProto)) {
    return `${xfProto.toLowerCase()}://${xfHost}`;
  }
  return new URL(request.url).origin;
}

function resolveAllowedPostMessageOrigin(
  candidateOrigin: string | undefined,
  allowedOriginsEnv?: string,
): string | undefined {
  if (!candidateOrigin) return undefined;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(candidateOrigin)) {
    return candidateOrigin;
  }
  if (allowedOriginsEnv && isOriginAllowed(candidateOrigin, allowedOriginsEnv)) {
    return candidateOrigin;
  }
  return undefined;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// ── Unauthenticated: OAuth callback (Google redirects here) ──────────────────

export async function handleGa4OAuthCallback(
  request: Request,
  env: Env,
  url: URL,
  _parts: string[],
): Promise<Response> {
  try {
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    const db = env.gtm_chat_history;

    if (!env.TOKEN_ENCRYPTION_KEY) {
      return htmlResponse(ga4OAuthResultPage(false, 'Server encryption key is not configured'), 500);
    }

    const stateData = stateParam
      ? await verifyState<OAuthStatePayload>(stateParam, env.TOKEN_ENCRYPTION_KEY)
      : null;

    const safeOrigin = resolveAllowedPostMessageOrigin(stateData?.origin, env.ALLOWED_ORIGINS);

    if (oauthError) {
      return htmlResponse(
        ga4OAuthResultPage(false, `Google authorization error: ${oauthError}`, safeOrigin),
        200,
      );
    }

    if (!code || !stateParam) {
      return htmlResponse(
        ga4OAuthResultPage(false, 'Missing authorization code or state parameter', safeOrigin),
        400,
      );
    }

    if (!stateData || !stateData.userId || typeof stateData.ts !== 'number') {
      return htmlResponse(
        ga4OAuthResultPage(false, 'Invalid or tampered OAuth state', safeOrigin),
        400,
      );
    }

    const age = Date.now() - stateData.ts;
    if (age > OAUTH_STATE_TTL_MS || age < -60_000) {
      return htmlResponse(
        ga4OAuthResultPage(false, 'OAuth session expired. Please try connecting again.', safeOrigin),
        400,
      );
    }

    const origin = resolvePublicOrigin(request, env);
    const redirectUri = `${origin}/api/ga4/oauth/callback`;

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('OAuth token exchange failed:', tokenRes.status, errText);
      return htmlResponse(ga4OAuthResultPage(false, 'Token exchange failed', safeOrigin), 200);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    // Get the Google user's email for display
    let googleEmail: string | null = null;
    try {
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (userInfoRes.ok) {
        const userInfo = (await userInfoRes.json()) as { email?: string };
        googleEmail = userInfo.email || null;
      }
    } catch {
      /* best-effort */
    }

    await storeOAuthTokens(db, stateData.userId, tokens, googleEmail, env.TOKEN_ENCRYPTION_KEY);

    return htmlResponse(ga4OAuthResultPage(true, undefined, safeOrigin), 200);
  } catch (err: any) {
    console.error('OAuth callback error:', err);
    return htmlResponse(
      ga4OAuthResultPage(false, 'An unexpected error occurred while connecting GA4.'),
      200,
    );
  }
}

// ── Authenticated: GA4 OAuth actions + property listing ──────────────────────

export async function handleGa4(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
  currentUser: AuthUser,
): Promise<Response> {
  const method = request.method;
  const db = env.gtm_chat_history;

  // ── /api/ga4/oauth/* ──────────────────────────────────────────────────
  if (parts[2] === 'oauth') {
    const oauthAction = parts[3];

    if (oauthAction === 'authorize' && method === 'GET') {
      if (!env.TOKEN_ENCRYPTION_KEY) {
        return json({ error: 'Server encryption key not configured' }, 500);
      }
      const origin = resolvePublicOrigin(request, env);
      const redirectUri = `${origin}/api/ga4/oauth/callback`;
      const state = await signState(
        {
          userId: currentUser.id,
          ts: Date.now(),
          nonce: crypto.randomUUID(),
          origin: request.headers.get('Origin') || '',
        },
        env.TOKEN_ENCRYPTION_KEY,
      );
      const authUrl = buildGoogleOAuthUrl(env, state, redirectUri);

      if (
        request.headers.get('Accept')?.includes('application/json') ||
        url.searchParams.get('format') === 'json'
      ) {
        return json({ url: authUrl });
      }

      return new Response(null, {
        status: 302,
        headers: { Location: authUrl },
      });
    }

    if (oauthAction === 'status' && method === 'GET') {
      const row = await db
        .prepare('SELECT connected_email, token_expiry FROM ga4_oauth_tokens WHERE user_id = ?')
        .bind(currentUser.id)
        .first<{ connected_email: string | null; token_expiry: number }>();

      if (!row) return json({ connected: false });
      return json({ connected: true, email: row.connected_email });
    }

    if (oauthAction === 'disconnect' && method === 'POST') {
      try {
        const row = await db
          .prepare('SELECT access_token FROM ga4_oauth_tokens WHERE user_id = ?')
          .bind(currentUser.id)
          .first<{ access_token: string }>();

        if (row) {
          // Best-effort revoke at Google
          try {
            const token = await decryptToken(row.access_token, env.TOKEN_ENCRYPTION_KEY);
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
          } catch {
            /* best-effort */
          }

          await db.prepare('DELETE FROM ga4_oauth_tokens WHERE user_id = ?').bind(currentUser.id).run();
        }

        // Also clear legacy stored property
        await env.GTM_CONTAINER.delete(`ga4_property:${currentUser.id}`);

        return json({ success: true });
      } catch (err: any) {
        console.error('GA4 disconnect error:', err);
        return json({ error: 'Failed to disconnect GA4 account' }, 500);
      }
    }
  }

  // ── /api/ga4/properties — list available GA4 properties (paginated) ───
  if (parts.length === 3 && parts[2] === 'properties' && method === 'GET') {
    try {
      const accessToken = await getOAuthAccessToken(db, currentUser.id, env);
      const properties: {
        account: string;
        accountName: string;
        propertyId: string;
        propertyName: string;
      }[] = [];

      let pageToken: string | undefined;
      for (let page = 0; page < MAX_ACCOUNT_SUMMARY_PAGES; page++) {
        const endpoint = pageToken
          ? `${GA4_ADMIN_API_BASE}/accountSummaries?pageToken=${encodeURIComponent(pageToken)}`
          : `${GA4_ADMIN_API_BASE}/accountSummaries`;
        const data = await ga4RestGet(accessToken, endpoint);

        for (const acct of data.accountSummaries || []) {
          for (const prop of acct.propertySummaries || []) {
            properties.push({
              account: acct.account || '',
              accountName: acct.displayName || '',
              propertyId: (prop.property || '').replace('properties/', ''),
              propertyName: prop.displayName || '',
            });
          }
        }

        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }

      return json({ properties });
    } catch (err: any) {
      if (err.message?.includes('GA4_TOKEN_EXPIRED')) {
        return json(
          {
            error: 'Your Google Analytics session has expired. Please reconnect your GA4 account.',
            code: 'GA4_TOKEN_EXPIRED',
          },
          401,
        );
      }
      if (err.message?.includes('GA4 not connected')) {
        return json({ error: err.message }, 400);
      }
      console.error('Failed to list GA4 properties:', err);
      return json({ error: 'Failed to list properties' }, 500);
    }
  }

  return json({ error: 'Not Found' }, 404);
}
