// ── Auth route handler: /api/auth/* ───────────────────────────────────────────

import { Env } from '../types';
import { json } from '../utils/http';
import { hashPassword, verifyPassword, generateUserId, generateInviteKey } from '../utils/crypto';
import { authenticate, createAuthToken } from '../middleware/auth';

export async function handleAuth(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const action = parts[2]; // 'bootstrap' | 'signup' | 'login' | 'logout' | 'me' | 'invite' | 'invite-keys'
  const db = env.gtm_chat_history;

  // POST /api/auth/bootstrap — create the very first user (no invite key)
  if (action === 'bootstrap' && method === 'POST') {
    try {
      // Check if any users already exist
      const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
      if (countRow && countRow.cnt > 0) {
        return json({ error: 'A user already exists. Use an invite key to sign up.' }, 403);
      }

      const { username, email, password, app } = await request.json() as {
        username: string; email: string; password: string; app?: string;
      };
      const targetApp = app || request.headers.get('X-BrightHorizon-App') || 'gtm';

      if (!username?.trim() || !email?.trim() || !password) {
        return json({ error: 'Username, email, and password are required' }, 400);
      }
      if (password.length < 6) {
        return json({ error: 'Password must be at least 6 characters' }, 400);
      }

      const userId = generateUserId();
      const hashedPw = await hashPassword(password);
      const now = Date.now();

      await db
        .prepare('INSERT INTO users (id, username, email, password, app, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, username.trim(), email.trim().toLowerCase(), hashedPw, targetApp, now, now)
        .run();

      const token = await createAuthToken(db, userId);

      return json({
        token,
        user: { id: userId, username: username.trim(), email: email.trim().toLowerCase(), app: targetApp, created_at: now },
      }, 201);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return json({ error: 'Username or email already taken' }, 409);
      }
      console.error('Bootstrap error:', err);
      return json({ error: err.message || 'Failed to create account' }, 500);
    }
  }

  // POST /api/auth/signup — register with an invite key
  if (action === 'signup' && method === 'POST') {
    try {
      const { username, email, password, inviteKey, app } = await request.json() as {
        username: string; email: string; password: string; inviteKey: string; app?: string;
      };

      if (!username?.trim() || !email?.trim() || !password || !inviteKey?.trim()) {
        return json({ error: 'All fields including invite key are required' }, 400);
      }
      if (password.length < 6) {
        return json({ error: 'Password must be at least 6 characters' }, 400);
      }

      // Validate invite key
      const invite = await db
        .prepare('SELECT invite_key, used_by, app FROM invite_keys WHERE invite_key = ?')
        .bind(inviteKey.trim())
        .first<{ invite_key: string; used_by: string | null; app: string | null }>();

      if (!invite) {
        return json({ error: 'Invalid invite key' }, 400);
      }
      if (invite.used_by) {
        return json({ error: 'This invite key has already been used' }, 400);
      }

      // Frontend app wins; fall back to header, then invite key's app, then 'gtm'
      const targetApp = app || request.headers.get('X-BrightHorizon-App') || invite.app || 'gtm';

      const userId = generateUserId();
      const hashedPw = await hashPassword(password);
      const now = Date.now();

      await db.batch([
        db.prepare('INSERT INTO users (id, username, email, password, app, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(userId, username.trim(), email.trim().toLowerCase(), hashedPw, targetApp, now, now),
        db.prepare('UPDATE invite_keys SET used_by = ?, used_at = ? WHERE invite_key = ?')
          .bind(userId, now, inviteKey.trim()),
      ]);

      const token = await createAuthToken(db, userId);

      return json({
        token,
        user: { id: userId, username: username.trim(), email: email.trim().toLowerCase(), app: targetApp, created_at: now },
      }, 201);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return json({ error: 'Username or email already taken' }, 409);
      }
      console.error('Signup error:', err);
      return json({ error: err.message || 'Failed to create account' }, 500);
    }
  }

  // POST /api/auth/login — authenticate with email + password (app-scoped)
  if (action === 'login' && method === 'POST') {
    try {
      const { email, password, app } = await request.json() as { email: string; password: string; app?: string };
      const targetApp = app || request.headers.get('X-BrightHorizon-App') || 'gtm';

      if (!email?.trim() || !password) {
        return json({ error: 'Email and password are required' }, 400);
      }

      const user = await db
        .prepare('SELECT id, username, email, password, app, created_at FROM users WHERE email = ? AND app = ?')
        .bind(email.trim().toLowerCase(), targetApp)
        .first<{ id: string; username: string; email: string; password: string; app: string; created_at: number }>();

      if (!user) {
        return json({ error: 'Invalid email or password' }, 401);
      }

      const valid = await verifyPassword(password, user.password);
      if (!valid) {
        return json({ error: 'Invalid email or password' }, 401);
      }

      const token = await createAuthToken(db, user.id);

      return json({
        token,
        user: { id: user.id, username: user.username, email: user.email, app: user.app || 'gtm', created_at: user.created_at },
      });
    } catch (err: any) {
      console.error('Login error:', err);
      return json({ error: err.message || 'Login failed' }, 500);
    }
  }

  // POST /api/auth/logout — invalidate the current token
  if (action === 'logout' && method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      await db.prepare('DELETE FROM auth_tokens WHERE token = ?').bind(token).run();
    }
    return json({ success: true });
  }

  // GET /api/auth/me — get current user info
  if (action === 'me' && method === 'GET') {
    const user = await authenticate(request, db);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    return json({ user });
  }

  // POST /api/auth/invite — generate a new invite key
  if (action === 'invite' && method === 'POST') {
    const user = await authenticate(request, db);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const { app } = await request.json().catch(() => ({})) as { app?: string };
    const targetApp = app || request.headers.get('X-BrightHorizon-App') || user.app || 'gtm';
    const key = generateInviteKey();
    const now = Date.now();
    await db
      .prepare('INSERT INTO invite_keys (invite_key, app, created_by, created_at) VALUES (?, ?, ?, ?)')
      .bind(key, targetApp, user.id, now)
      .run();

    return json({ invite_key: key }, 201);
  }

  // GET /api/auth/invite-keys — list invite keys for current user
  if (action === 'invite-keys' && method === 'GET') {
    const user = await authenticate(request, db);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const { results } = await db
      .prepare('SELECT invite_key, app, created_by, used_by, used_at, created_at FROM invite_keys WHERE created_by = ? ORDER BY created_at DESC')
      .bind(user.id)
      .all();

    return json(results);
  }

  return json({ error: 'Not Found' }, 404);
}
