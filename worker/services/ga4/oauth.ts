// ── GA4 OAuth service: token storage, refresh, URL building, result page ──────

import { Env, StoredOAuthRow } from '../../types';
import { encryptToken, decryptToken } from '../../utils/crypto';

const GA4_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── OAuth Token Storage & Retrieval ───────────────────────────────────────────

export async function storeOAuthTokens(
  db: D1Database,
  userId: string,
  tokens: { access_token: string; refresh_token?: string; expires_in: number; scope?: string },
  email: string | null,
  encryptionKey: string,
): Promise<void> {
  const encAccess = await encryptToken(tokens.access_token, encryptionKey);
  const expiry = Date.now() + tokens.expires_in * 1000;
  const now = Date.now();
  const scope = tokens.scope || GA4_OAUTH_SCOPES;

  if (tokens.refresh_token) {
    const encRefresh = await encryptToken(tokens.refresh_token, encryptionKey);
    await db
      .prepare(
        `INSERT INTO ga4_oauth_tokens (user_id, access_token, refresh_token, token_expiry, scope, connected_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           token_expiry = excluded.token_expiry,
           scope = excluded.scope,
           connected_email = COALESCE(excluded.connected_email, ga4_oauth_tokens.connected_email),
           updated_at = excluded.updated_at`,
      )
      .bind(userId, encAccess, encRefresh, expiry, scope, email, now, now)
      .run();
    return;
  }

  // Google may omit refresh_token on subsequent re-authorizations; preserve existing one
  const existing = await db
    .prepare('SELECT user_id FROM ga4_oauth_tokens WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: string }>();

  if (!existing) {
    throw new Error('Missing Google refresh token. Please reconnect and grant offline access.');
  }

  await db
    .prepare(
      `UPDATE ga4_oauth_tokens
       SET access_token = ?,
           token_expiry = ?,
           scope = ?,
           connected_email = COALESCE(?, connected_email),
           updated_at = ?
       WHERE user_id = ?`,
    )
    .bind(encAccess, expiry, scope, email, now, userId)
    .run();
}

export async function refreshAccessToken(
  db: D1Database,
  userId: string,
  encRefreshTok: string,
  env: Env,
): Promise<string> {
  const refreshToken = await decryptToken(encRefreshTok, env.TOKEN_ENCRYPTION_KEY);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const e = await res.text();
    // Detect expired / revoked refresh token (invalid_grant)
    if (res.status === 400 && e.includes('invalid_grant')) {
      console.error(`[GA4] Refresh token expired/revoked for user ${userId}. Purging stale tokens.`);
      await db.prepare('DELETE FROM ga4_oauth_tokens WHERE user_id = ?').bind(userId).run();
      throw new Error(
        'GA4_TOKEN_EXPIRED: Your Google Analytics session has expired. Please reconnect your GA4 account.',
      );
    }
    throw new Error(`Token refresh failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number; scope: string };
  const encAccess = await encryptToken(data.access_token, env.TOKEN_ENCRYPTION_KEY);
  const expiry = Date.now() + data.expires_in * 1000;
  await db
    .prepare('UPDATE ga4_oauth_tokens SET access_token = ?, token_expiry = ?, updated_at = ? WHERE user_id = ?')
    .bind(encAccess, expiry, Date.now(), userId)
    .run();
  return data.access_token;
}

export async function getOAuthAccessToken(db: D1Database, userId: string, env: Env): Promise<string> {
  const row = await db
    .prepare('SELECT access_token, refresh_token, token_expiry FROM ga4_oauth_tokens WHERE user_id = ?')
    .bind(userId)
    .first<StoredOAuthRow>();
  if (!row) throw new Error('GA4 not connected. Please connect your Google Analytics account first.');
  if (Date.now() > row.token_expiry - 120_000) {
    return refreshAccessToken(db, userId, row.refresh_token, env);
  }
  return decryptToken(row.access_token, env.TOKEN_ENCRYPTION_KEY);
}

export function buildGoogleOAuthUrl(env: Env, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GA4_OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function ga4OAuthResultPage(
  success: boolean,
  errorMsg?: string,
  targetOrigin?: string,
): string {
  const rawTitle = success ? 'GA4 Connected!' : 'Connection Failed';
  const rawMsg = success
    ? 'Your Google Analytics account has been connected. You can close this window.'
    : `Failed to connect: ${errorMsg || 'Unknown error'}. Please try again.`;

  const safeTitle = escapeHtml(rawTitle);
  const safeMsg = escapeHtml(rawMsg);
  const color = success ? '#10b981' : '#ef4444';

  const payload = success
    ? { type: 'ga4_oauth_success' }
    : { type: 'ga4_oauth_error', error: errorMsg || 'Unknown error' };
  const serializedPayload = JSON.stringify(payload).replace(/</g, '\\u003c');
  const safeOrigin =
    targetOrigin && /^https?:\/\/[^\s/]+$/i.test(targetOrigin) ? targetOrigin : '*';
  const serializedOrigin = JSON.stringify(safeOrigin).replace(/</g, '\\u003c');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8}
.card{background:#fff;border-radius:16px;padding:40px;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:${color};margin:0 0 12px;font-size:24px}p{color:#6b7d8e;line-height:1.6;margin:0 0 24px}
button{background:${color};color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:14px;cursor:pointer;font-weight:600}</style></head>
<body><div class="card"><div style="font-size:48px;margin-bottom:16px">${success ? '&#x2705;' : '&#x274C;'}</div>
<h1>${safeTitle}</h1><p>${safeMsg}</p>
<button onclick="window.close();if(!window.closed)window.location.href='/'">Close Window</button></div>
<script>if(window.opener){window.opener.postMessage(${serializedPayload},${serializedOrigin});}</script>
</body></html>`;
}
