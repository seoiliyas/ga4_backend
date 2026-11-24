// ── Sessions route handler: /api/sessions/* ───────────────────────────────────

import { Env, AuthUser } from '../types';
import { json } from '../utils/http';
import { cleanPropertyId } from '../services/ga4/api';

const VALID_MODES = new Set(['gtm', 'ga4']);

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
      const rawMode = url.searchParams.get('mode') || 'gtm';
      if (!VALID_MODES.has(rawMode)) {
        return json({ error: 'Invalid mode parameter' }, 400);
      }
      const { results } = await db
        .prepare(
          'SELECT id, title, mode, ga4_property_id, created_at, updated_at FROM sessions WHERE user_id = ? AND mode = ? ORDER BY updated_at DESC',
        )
        .bind(currentUser.id, rawMode)
        .all();
      return json(results);
    }

    // POST /api/sessions — create a session
    if (method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        id?: string;
        title?: string;
        mode?: string;
        ga4_property_id?: string | null;
      } | null;
      if (!body) return json({ error: 'Invalid JSON request body' }, 400);

      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id || id.length > 128) {
        return json({ error: 'Valid session id is required' }, 400);
      }

      const sessionMode = body.mode || 'gtm';
      if (!VALID_MODES.has(sessionMode)) {
        return json({ error: 'Invalid session mode' }, 400);
      }

      const title =
        typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'New Chat';

      let pid: string | null = null;
      if (body.ga4_property_id) {
        pid = cleanPropertyId(String(body.ga4_property_id).trim());
        if (!pid || !/^\d+$/.test(pid)) return json({ error: 'Invalid property ID' }, 400);
      }

      const now = Date.now();
      try {
        await db
          .prepare(
            'INSERT INTO sessions (id, title, mode, ga4_property_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(id, title, sessionMode, pid, currentUser.id, now, now)
          .run();
      } catch (err: any) {
        if (err?.code === '23505' || /unique/i.test(String(err?.message ?? ''))) {
          return json({ error: 'Session ID already exists' }, 409);
        }
        throw err;
      }

      return json(
        { id, title, mode: sessionMode, ga4_property_id: pid, created_at: now, updated_at: now },
        201,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // /api/sessions/:id  (single session) and /api/sessions/:id/property
  // ────────────────────────────────────────────────────────────────────────
  if (parts.length === 3 || (parts.length === 4 && parts[3] === 'property')) {
    const sessionId = parts[2];

    const session = await db
      .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
      .bind(sessionId, currentUser.id)
      .first();
    if (!session) return json({ error: 'Session not found' }, 404);

    // PATCH /api/sessions/:id — rename
    if (method === 'PATCH' && parts.length === 3) {
      const body = (await request.json().catch(() => null)) as { title?: string } | null;
      const cleanTitle = typeof body?.title === 'string' ? body.title.trim().slice(0, 200) : '';
      if (!cleanTitle) return json({ error: 'Title is required' }, 400);

      await db
        .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
        .bind(cleanTitle, Date.now(), sessionId)
        .run();
      return json({ success: true });
    }

    // PUT /api/sessions/:id/property — set GA4 property for this session
    if (method === 'PUT' && parts.length === 4 && parts[3] === 'property') {
      const body = (await request.json().catch(() => null)) as {
        ga4_property_id?: string | null;
      } | null;
      if (!body) return json({ error: 'Invalid JSON request body' }, 400);

      let pid: string | null = null;
      if (body.ga4_property_id) {
        pid = cleanPropertyId(String(body.ga4_property_id).trim());
        if (!pid || !/^\d+$/.test(pid)) return json({ error: 'Invalid property ID' }, 400);
      }

      await db
        .prepare('UPDATE sessions SET ga4_property_id = ?, updated_at = ? WHERE id = ?')
        .bind(pid, Date.now(), sessionId)
        .run();
      return json({ success: true, ga4_property_id: pid });
    }

    // DELETE /api/sessions/:id — clean up stored files, then delete session + messages
    if (method === 'DELETE' && parts.length === 3) {
      try {
        const { results: attRows } = await db
          .prepare('SELECT r2_key FROM attachments WHERE session_id = ? AND user_id = ?')
          .bind(sessionId, currentUser.id)
          .all<{ r2_key: string }>();

        if (attRows.length > 0 && env.CHAT_FILES) {
          const bucket = env.CHAT_FILES;
          await Promise.allSettled(attRows.map((a) => bucket.delete(a.r2_key)));
        }
      } catch {
        /* ignore if attachments table does not exist yet */
      }

      await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      return json({ success: true });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/sessions/:id/messages
  // ────────────────────────────────────────────────────────────────────────
  if (parts.length === 4 && parts[3] === 'messages' && method === 'GET') {
    const sessionId = parts[2];

    const session = await db
      .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
      .bind(sessionId, currentUser.id)
      .first();
    if (!session) return json({ error: 'Session not found' }, 404);

    let results: any[] = [];
    try {
      const res = await db
        .prepare('SELECT id, role, text, charts, attachments FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .bind(sessionId)
        .all<{ id: number; role: string; text: string; charts: string | null; attachments: string | null }>();
      results = res.results as any[];
    } catch {
      const res = await db
        .prepare('SELECT id, role, text, charts FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .bind(sessionId)
        .all<{ id: number; role: string; text: string; charts: string | null }>();
      results = (res.results as any[]).map((r: any) => ({ ...r, attachments: null }));
    }

    // Single query for all attachments in this session, indexed by both ID and message_id
    const attachmentsById = new Map<string, any>();
    const attachmentsByMsgId = new Map<number, any[]>();
    try {
      const { results: attResults } = await db
        .prepare(
          'SELECT id, filename, mime_type, size, created_at, message_id FROM attachments WHERE session_id = ? ORDER BY created_at ASC',
        )
        .bind(sessionId)
        .all<{
          id: string;
          filename: string;
          mime_type: string;
          size: number;
          created_at: number;
          message_id: number | null;
        }>();

      for (const a of attResults) {
        const dto = {
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size: a.size,
          created_at: a.created_at,
          url: `/api/files/${a.id}`,
        };
        attachmentsById.set(a.id, dto);
        if (a.message_id != null) {
          const list = attachmentsByMsgId.get(a.message_id) || [];
          list.push(dto);
          attachmentsByMsgId.set(a.message_id, list);
        }
      }
    } catch {
      /* ignore if attachments table does not exist */
    }

    const mapped = results.map((msg: any) => {
      const attIds = parseJsonStringArray(msg.attachments);
      let atts = attIds.map((id) => attachmentsById.get(id)).filter(Boolean);
      if (atts.length === 0 && msg.id != null) {
        atts = attachmentsByMsgId.get(Number(msg.id)) ?? [];
      }

      return {
        role: msg.role,
        text: msg.text,
        charts: parseJsonStringArray(msg.charts),
        attachments: atts,
        id: `msg-${msg.id}`,
      };
    });

    return json(mapped);
  }

  return json({ error: 'Not Found' }, 404);
}
