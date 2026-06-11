// ── Auth middleware: token validation & creation ──────────────────────────────

import { generateToken } from '../utils/crypto';
import { AuthUser, TOKEN_EXPIRY_MS } from '../types';

export async function authenticate(request: Request, db: D1Database): Promise<AuthUser | null> {
  let token = '';
  const authHeader = request.headers.get('Authorization');

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    const url = new URL(request.url);
    token = url.searchParams.get('token') || '';
  }

  if (!token) return null;

  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.email, u.app, u.created_at
       FROM auth_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token = ? AND t.expires_at > ?`
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
