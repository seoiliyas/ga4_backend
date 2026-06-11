// ── Sessions route handler: /api/sessions/* ───────────────────────────────────

import { Env, AuthUser } from '../types';
import { json } from '../utils/http';
import { cleanPropertyId } from '../services/ga4/api';

export async function handleSessions(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
  currentUser: AuthUser,
): Promise<Response> {
  const method = request.method;
  const db = env.gtm_chat_history;

  // ────────────────────────────────────────────────────────────────────────
  // /api/sessions  (collection)
  // ────────────────────────────────────────────────────────────────────────
  if (parts.length === 2) {

    // GET /api/sessions — list all sessions for current user
    if (method === 'GET') {
      const mode = url.searchParams.get('mode') || 'gtm';
      const { results } = await db
        .prepare('SELECT id, title, mode, ga4_property_id, created_at, updated_at FROM sessions WHERE user_id = ? AND mode = ? ORDER BY updated_at DESC')
        .bind(currentUser.id, mode)
        .all();
      return json(results);
    }

    // POST /api/sessions — create a session
    if (method === 'POST') {
      const { id, title, mode, ga4_property_id } = await request.json() as { id: string; title?: string; mode?: string; ga4_property_id?: string | null };
      const sessionMode = mode || 'gtm';
      let pid = null;
      if (ga4_property_id) {
        pid = cleanPropertyId(ga4_property_id.trim());
        if (!pid || !/^\d+$/.test(pid)) return json({ error: 'Invalid property ID' }, 400);
      }
      const now = Date.now();
      await db
        .prepare('INSERT INTO sessions (id, title, mode, ga4_property_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, title ?? 'New Chat', sessionMode, pid, currentUser.id, now, now)
        .run();
      return json({ id, title: title ?? 'New Chat', mode: sessionMode, ga4_property_id: pid, created_at: now, updated_at: now }, 201);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // /api/sessions/:id  (single session) and /api/sessions/:id/property
  // ────────────────────────────────────────────────────────────────────────
  if (parts.length === 3 || (parts.length === 4 && parts[3] === 'property')) {
    const sessionId = parts[2];

    // Verify session belongs to current user
    const session = await db
      .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
      .bind(sessionId, currentUser.id)
      .first();
    if (!session) return json({ error: 'Session not found' }, 404);

    // PATCH /api/sessions/:id — rename
    if (method === 'PATCH' && parts.length === 3) {
      const { title } = await request.json() as { title: string };
      await db
        .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
        .bind(title, Date.now(), sessionId)
        .run();
      return json({ success: true });
    }

    // PUT /api/sessions/:id/property — set GA4 property for this session
    if (method === 'PUT' && parts.length === 4 && parts[3] === 'property') {
      const { ga4_property_id } = await request.json() as { ga4_property_id: string | null };
      let pid = null;
      if (ga4_property_id) {
        pid = cleanPropertyId(ga4_property_id.trim());
        if (!pid || !/^\d+$/.test(pid)) return json({ error: 'Invalid property ID' }, 400);
      }
      await db
        .prepare('UPDATE sessions SET ga4_property_id = ?, updated_at = ? WHERE id = ?')
        .bind(pid, Date.now(), sessionId)
        .run();
      return json({ success: true, ga4_property_id: pid });
    }

    // DELETE /api/sessions/:id — remove session + its messages
    if (method === 'DELETE' && parts.length === 3) {
      await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      return json({ success: true });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/sessions/:id/messages
  // ────────────────────────────────────────────────────────────────────────
  if (parts.length === 4 && parts[3] === 'messages') {
    const sessionId = parts[2];

    // Verify session belongs to current user
    const session = await db
      .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
      .bind(sessionId, currentUser.id)
      .first();
    if (!session) return json({ error: 'Session not found' }, 404);

    if (method === 'GET') {
      const { results } = await db
        .prepare('SELECT role, text, charts FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .bind(sessionId)
        .all<{ role: string; text: string; charts: string | null }>();

      const mapped = results.map((msg) => ({
        ...msg,
        charts: msg.charts ? JSON.parse(msg.charts) : [],
      }));

      return json(mapped);
    }
  }

  return json({ error: 'Not Found' }, 404);
}
