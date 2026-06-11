// routes/chat.ts
// ── Chat route handler: /api/chat (GTM streaming + GA4 function-calling) ──────

import { Env, AuthUser } from '../types';
import { json, CORS } from '../utils/http';
import { createGenAIClient } from '../utils/genai-client';
import { runGA4Chat } from '../services/ga4/chat';
import { streamGtmChat } from '../services/gtm-chat';

export async function handleChat(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
  currentUser: AuthUser,
): Promise<Response> {
  const method = request.method;
  const db = env.gtm_chat_history;

  if (method !== 'POST') {
    return json({ error: 'Not Found' }, 404);
  }

  try {
    const { question, sessionId, chatMode } = await request.json() as {
      question: string;
      sessionId?: string;
      chatMode?: 'gtm' | 'ga4';
    };

    if (!question) return json({ error: 'Question is required' }, 400);

    // If sessionId is given, verify it belongs to the current user
    if (sessionId) {
      const session = await db
        .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
        .bind(sessionId, currentUser.id)
        .first();
      if (!session) return json({ error: 'Session not found' }, 404);
    }

    // ── Build GenAI client (Vertex AI or fallback) ───────────────────────
    const geminiAi = createGenAIClient(env);

    // ── Build conversation history from D1 ───────────────────────────
    const conversationHistory: { role: string; parts: { text: string }[] }[] = [];

    if (sessionId) {
      const { results: dbMessages } = await db
        .prepare('SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .bind(sessionId)
        .all<{ role: string; text: string }>();

      for (const msg of dbMessages) {
        conversationHistory.push({ role: msg.role, parts: [{ text: msg.text }] });
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // GA4 Mode - function calling with tools (user OAuth)
    // ──────────────────────────────────────────────────────────────────
    if (chatMode === 'ga4') {
      if (!sessionId) {
        return json({ error: 'GA4 mode requires a valid session ID' }, 400);
      }

      const sessionRow = await db
        .prepare('SELECT ga4_property_id FROM sessions WHERE id = ?')
        .bind(sessionId)
        .first<{ ga4_property_id: string }>();

      const resolvedGa4Pid = sessionRow?.ga4_property_id;
      if (!resolvedGa4Pid) {
        return json({ error: 'No GA4 property configured for this session.' }, 400);
      }

      // ✅ FIX: destructure the result object — don't treat it as a string
      const { answer, charts } = await runGA4Chat(
        geminiAi, conversationHistory, question,
        resolvedGa4Pid, db, currentUser.id, env,
      );

      if (answer) {
        try {
          const now = Date.now();
          await db.batch([
            db.prepare('INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)')
              .bind(sessionId, 'user', question, now),
            // ✅ FIX: persist answer (string), not the whole result object
            db.prepare('INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)')
              .bind(sessionId, 'model', answer, now + 1),
            db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
              .bind(now, sessionId),
          ]);
        } catch (dbErr) {
          console.error('Failed to persist GA4 chat to D1:', dbErr);
        }
      }

      // ✅ FIX: return answer (string) + charts array to the client
      return json({ answer, charts });
    }

    // ──────────────────────────────────────────────────────────────────
    // GTM Mode - SSE streaming with context cache
    // ──────────────────────────────────────────────────────────────────
    const containerJsonString = await env.GTM_CONTAINER.get('container', { cacheTtl: 3600 });
    if (!containerJsonString) return json({ error: 'Container data not found' }, 500);

    const sseResponse = await streamGtmChat(
      geminiAi,
      conversationHistory,
      question,
      containerJsonString,
      env.GTM_CONTAINER,
      db,
      sessionId,
    );

    // Add CORS headers to the SSE response
    const headers = new Headers(sseResponse.headers);
    for (const [k, v] of Object.entries(CORS)) {
      headers.set(k, v);
    }

    return new Response(sseResponse.body, { headers });
  } catch (error: any) {
    console.error('Chat API Error:', error);
    return json({ error: error.message || 'Error processing request' }, 500);
  }
}