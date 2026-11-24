// ── Auth middleware: token validation, creation & token cleanup ───────────────

import { generateToken } from '../utils/crypto';
import { AuthUser, TOKEN_EXPIRY_MS } from '../types';

export async function authenticate(request: Request, db: D1Database): Promise<AuthUser | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.email, u.app, u.created_at
       FROM auth_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token = ? AND t.expires_at > ?`,
    )
    .bind(token, Date.now())
    .first<AuthUser>();

  return row ?? null;
}

export async function createAuthToken(db: D1Database, userId: string): Promise<string> {
  const token = generateToken();
  const now = Date.now();
  await db
    .prepare('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, now, now + TOKEN_EXPIRY_MS)
    .run();
  return token;
}

export async function purgeExpiredTokens(db: D1Database): Promise<void> {
  try {
    await db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').bind(Date.now()).run();
  } catch (err) {
    console.warn('[Auth] Failed to purge expired tokens:', err);
  }
}
