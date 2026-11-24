// ── Auth route handler: /api/auth/* ───────────────────────────────────────────

import { Env } from '../types';
import { json } from '../utils/http';
import { hashPassword, verifyPassword, generateUserId, generateInviteKey } from '../utils/crypto';
import { authenticate, createAuthToken, purgeExpiredTokens } from '../middleware/auth';
import { checkRateLimit } from '../utils/rate-limit';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_APPS = new Set(['gtm', 'ga4']);
const AUTH_RATE_LIMIT = 20;
const AUTH_RATE_WINDOW_MS = 60_000;

function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function isUniqueConstraintError(err: any): boolean {
  if (!err) return false;
  if (err.code === '23505') return true;
  return /unique/i.test(String(err.message ?? ''));
}

function resolveApp(bodyApp: unknown, headerApp: string | null): 'gtm' | 'ga4' | null {
  const candidate = (typeof bodyApp === 'string' && bodyApp) || headerApp || 'gtm';
  return VALID_APPS.has(candidate) ? (candidate as 'gtm' | 'ga4') : null;
}

export async function handleAuth(
  request: Request,
  env: Env,
  _url: URL,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const action = parts[2]; // 'bootstrap' | 'signup' | 'login' | 'logout' | 'me' | 'invite' | 'invite-keys'
  const db = env.gtm_chat_history;
  const ip = getClientIp(request);

  // POST /api/auth/bootstrap — create the very first user (no invite key)
  if (action === 'bootstrap' && method === 'POST') {
    const rl = checkRateLimit(`auth:bootstrap:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!rl.allowed) return json({ error: 'Too many requests. Please try again shortly.' }, 429);

    try {
      const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
      if (countRow && Number(countRow.cnt) > 0) {
        return json({ error: 'A user already exists. Use an invite key to sign up.' }, 403);
      }

      const body = (await request.json().catch(() => null)) as {
        username?: string;
        email?: string;
        password?: string;
        app?: string;
      } | null;
      if (!body) return json({ error: 'Invalid JSON request body' }, 400);

      const targetApp = resolveApp(body.app, request.headers.get('X-BrightHorizon-App'));
      if (!targetApp) return json({ error: 'Invalid app scope' }, 400);

      const cleanUsername = body.username?.trim() || '';
      const cleanEmail = body.email?.trim().toLowerCase() || '';
      const password = body.password || '';

      if (!cleanUsername || !cleanEmail || !password) {
        return json({ error: 'Username, email, and password are required' }, 400);
      }
      if (!EMAIL_REGEX.test(cleanEmail)) {
        return json({ error: 'Please enter a valid email address' }, 400);
      }
      if (password.length < 6 || password.length > 128) {
        return json({ error: 'Password must be between 6 and 128 characters' }, 400);
      }

      const userId = generateUserId();
      const hashedPw = await hashPassword(password);
      const now = Date.now();

      await db
        .prepare('INSERT INTO users (id, username, email, password, app, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, cleanUsername, cleanEmail, hashedPw, targetApp, now, now)
        .run();

      const token = await createAuthToken(db, userId);

      return json(
        {
          token,
          user: { id: userId, username: cleanUsername, email: cleanEmail, app: targetApp, created_at: now },
        },
        201,
      );
    } catch (err: any) {
      if (isUniqueConstraintError(err)) {
        return json({ error: 'Username or email already taken' }, 409);
      }
      console.error('Bootstrap error:', err);
      return json({ error: 'Failed to create account' }, 500);
    }
  }

  // POST /api/auth/signup — register with an invite key
  if (action === 'signup' && method === 'POST') {
    const rl = checkRateLimit(`auth:signup:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!rl.allowed) return json({ error: 'Too many requests. Please try again shortly.' }, 429);

    try {
      const body = (await request.json().catch(() => null)) as {
        username?: string;
        email?: string;
        password?: string;
        inviteKey?: string;
        app?: string;
      } | null;
      if (!body) return json({ error: 'Invalid JSON request body' }, 400);

      const cleanUsername = body.username?.trim() || '';
      const cleanEmail = body.email?.trim().toLowerCase() || '';
      const password = body.password || '';
      const cleanInviteKey = body.inviteKey?.trim() || '';

      if (!cleanUsername || !cleanEmail || !password || !cleanInviteKey) {
        return json({ error: 'All fields including invite key are required' }, 400);
      }
      if (!EMAIL_REGEX.test(cleanEmail)) {
        return json({ error: 'Please enter a valid email address' }, 400);
      }
      if (password.length < 6 || password.length > 128) {
        return json({ error: 'Password must be between 6 and 128 characters' }, 400);
      }

      const invite = await db
        .prepare('SELECT invite_key, used_by, app FROM invite_keys WHERE invite_key = ?')
        .bind(cleanInviteKey)
        .first<{ invite_key: string; used_by: string | null; app: string | null }>();

      if (!invite) {
        return json({ error: 'Invalid invite key' }, 400);
      }
      if (invite.used_by) {
        return json({ error: 'This invite key has already been used' }, 400);
      }

      const targetApp = resolveApp(
        body.app || request.headers.get('X-BrightHorizon-App') || invite.app || 'gtm',
        null,
      );
      if (!targetApp) return json({ error: 'Invalid app scope' }, 400);

      if (invite.app && invite.app !== targetApp) {
        return json(
          { error: `This invite key is scoped to the ${invite.app.toUpperCase()} app` },
          400,
        );
      }

      const userId = generateUserId();
      const hashedPw = await hashPassword(password);
      const now = Date.now();

      const batchResults = await db.batch([
        db
          .prepare('INSERT INTO users (id, username, email, password, app, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(userId, cleanUsername, cleanEmail, hashedPw, targetApp, now, now),
        db
          .prepare('UPDATE invite_keys SET used_by = ?, used_at = ? WHERE invite_key = ? AND used_by IS NULL')
          .bind(userId, now, cleanInviteKey),
      ]);

      // Atomic race guard: if another concurrent signup claimed the invite key first, roll back user
      const updateChanges = batchResults[1]?.meta?.changes ?? 0;
      if (updateChanges !== 1) {
        await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run().catch(() => {});
        return json({ error: 'This invite key has already been used' }, 400);
      }

      const token = await createAuthToken(db, userId);

      return json(
        {
          token,
          user: { id: userId, username: cleanUsername, email: cleanEmail, app: targetApp, created_at: now },
        },
        201,
      );
    } catch (err: any) {
      if (isUniqueConstraintError(err)) {
        return json({ error: 'Username or email already taken' }, 409);
      }
      console.error('Signup error:', err);
      return json({ error: 'Failed to create account' }, 500);
    }
  }

  // POST /api/auth/login — authenticate with email + password (app-scoped)
  if (action === 'login' && method === 'POST') {
    const rl = checkRateLimit(`auth:login:${ip}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!rl.allowed) return json({ error: 'Too many login attempts. Please wait a minute.' }, 429);

    try {
      const body = (await request.json().catch(() => null)) as {
        email?: string;
        password?: string;
        app?: string;
      } | null;
      if (!body) return json({ error: 'Invalid JSON request body' }, 400);

      const targetApp = resolveApp(body.app, request.headers.get('X-BrightHorizon-App'));
      if (!targetApp) return json({ error: 'Invalid app scope' }, 400);

      const cleanEmail = body.email?.trim().toLowerCase() || '';
      const password = body.password || '';

      if (!cleanEmail || !password) {
        return json({ error: 'Email and password are required' }, 400);
      }

      const user = await db
        .prepare('SELECT id, username, email, password, app, created_at FROM users WHERE email = ? AND app = ?')
        .bind(cleanEmail, targetApp)
        .first<{ id: string; username: string; email: string; password: string; app: string; created_at: number }>();

      if (!user) {
        return json({ error: 'Invalid email or password' }, 401);
      }

      const valid = await verifyPassword(password, user.password);
      if (!valid) {
        return json({ error: 'Invalid email or password' }, 401);
      }

      purgeExpiredTokens(db).catch(() => {});
      const token = await createAuthToken(db, user.id);

      return json({
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          app: user.app || 'gtm',
          created_at: user.created_at,
        },
      });
    } catch (err: any) {
      console.error('Login error:', err);
      return json({ error: 'Login failed' }, 500);
    }
  }

  // POST /api/auth/logout — invalidate the current token
  if (action === 'logout' && method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        await db.prepare('DELETE FROM auth_tokens WHERE token = ?').bind(token).run();
      }
    }
    purgeExpiredTokens(db).catch(() => {});
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

    const { app } = (await request.json().catch(() => ({}))) as { app?: string };
    const targetApp = resolveApp(app, request.headers.get('X-BrightHorizon-App') || user.app);
    if (!targetApp) return json({ error: 'Invalid app scope' }, 400);

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
