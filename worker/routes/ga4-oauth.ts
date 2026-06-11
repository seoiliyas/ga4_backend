// ── GA4 OAuth route handler: /api/ga4/* ───────────────────────────────────────

import { Env, AuthUser } from '../types';
import { json, CORS } from '../utils/http';
import { decryptToken } from '../utils/crypto';
import {
  storeOAuthTokens,
  getOAuthAccessToken,
  buildGoogleOAuthUrl,
  ga4OAuthResultPage,
} from '../services/ga4/oauth';
import { ga4RestGet, GA4_ADMIN_API_BASE } from '../services/ga4/api';

// ── Unauthenticated: OAuth callback (Google redirects here) ──────────────────

export async function handleGa4OAuthCallback(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response> {
  try {
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const db = env.gtm_chat_history;

    if (error) {
      return new Response(ga4OAuthResultPage(false, error), {
        status: 200,
        headers: { 'Content-Type': 'text/html', ...CORS },
      });
    }

    if (!code || !stateParam) {
      return new Response(ga4OAuthResultPage(false, 'Missing code or state parameter'), {
        status: 400,
        headers: { 'Content-Type': 'text/html', ...CORS },
      });
    }

    // Decode state to get userId
    let stateData: { userId: string; ts: number };
    try {
      stateData = JSON.parse(atob(stateParam));
    } catch {
      return new Response(ga4OAuthResultPage(false, 'Invalid state parameter'), {
        status: 400,
        headers: { 'Content-Type': 'text/html', ...CORS },
      });
    }

    const origin = new URL(request.url).origin;
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
      console.error('OAuth token exchange failed:', errText);
      return new Response(ga4OAuthResultPage(false, 'Token exchange failed'), {
        status: 200,
        headers: { 'Content-Type': 'text/html', ...CORS },
      });
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
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
    } catch { /* best-effort */ }

    // Store encrypted tokens
    await storeOAuthTokens(db, stateData.userId, tokens, googleEmail, env.TOKEN_ENCRYPTION_KEY);

    return new Response(ga4OAuthResultPage(true), {
      status: 200,
      headers: { 'Content-Type': 'text/html', ...CORS },
    });
  } catch (err: any) {
    console.error('OAuth callback error:', err);
    return new Response(ga4OAuthResultPage(false, err.message || 'Unexpected error'), {
      status: 200,
      headers: { 'Content-Type': 'text/html', ...CORS },
    });
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
      const origin = new URL(request.url).origin;
      const redirectUri = `${origin}/api/ga4/oauth/callback`;
      const state = btoa(JSON.stringify({ userId: currentUser.id, ts: Date.now() }));
      return new Response(null, {
        status: 302,
        headers: { Location: buildGoogleOAuthUrl(env, state, redirectUri), ...CORS },
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
          } catch { /* best-effort */ }

          await db.prepare('DELETE FROM ga4_oauth_tokens WHERE user_id = ?').bind(currentUser.id).run();
        }

        // Also clear stored property
        await env.GTM_CONTAINER.delete(`ga4_property:${currentUser.id}`);

        return json({ success: true });
      } catch (err: any) {
        return json({ error: err.message || 'Failed to disconnect' }, 500);
      }
    }
  }

  // ── /api/ga4/properties — list available GA4 properties ─────────────
  if (parts.length === 3 && parts[2] === 'properties') {
    if (method === 'GET') {
      try {
        const accessToken = await getOAuthAccessToken(db, currentUser.id, env);
        const data = await ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/accountSummaries`);

        // Flatten into a simple list of properties
        const properties: { account: string; accountName: string; propertyId: string; propertyName: string }[] = [];
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
        return json({ properties });
      } catch (err: any) {
        return json({ error: err.message || 'Failed to list properties' }, 500);
      }
    }
  }

  return json({ error: 'Not Found' }, 404);
}
