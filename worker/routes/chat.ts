// routes/chat.ts
// ── Chat route handler: /api/chat (Google Gemini only) ─────────────────────────

import { Env, AuthUser, GEMINI_MODEL } from '../types';
import { json } from '../utils/http';
import { createGeminiClient } from '../utils/genai-client';
import { checkRateLimit } from '../utils/rate-limit';
import { runGA4Chat as runGA4ChatGemini, streamGtmChat as streamGtmChatGemini } from '../services/gemini-chat';
import { loadAttachments, buildGeminiFileParts, AttachmentMeta } from '../utils/file-helpers';

const MODEL_ID_REGEX = /^gemini-[a-z0-9.-]+$/i;
const CHAT_RATE_LIMIT = 30;
const CHAT_RATE_WINDOW_MS = 60_000;

function isSafeUserFacingError(message: string): boolean {
  return (
    message.includes('Invalid GA4 property ID') ||
    message.includes('GA4 not connected') ||
    message.includes('GA4 response was blocked') ||
    message.includes('GA4 response was cut off') ||
    message.includes('GA4 chat exhausted')
  );
}

export async function handleChat(
  request: Request,
  env: Env,
  _url: URL,
  _parts: string[],
  currentUser: AuthUser,
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Not Found' }, 404);
  }

  const rl = checkRateLimit(`chat:${currentUser.id}`, CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_MS);
  if (!rl.allowed) {
    return json({ error: 'Too many chat requests. Please wait a moment and try again.' }, 429);
  }

  const db = env.gtm_chat_history;

  try {
    const body = (await request.json().catch(() => null)) as {
      question?: string;
      sessionId?: string;
      chatMode?: 'gtm' | 'ga4';
      model?: string;
      attachmentIds?: string[];
    } | null;

    if (!body) {
      return json({ error: 'Invalid JSON request body' }, 400);
    }

    const trimmedQuestion = typeof body.question === 'string' ? body.question.trim() : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined;
    const chatMode = body.chatMode;
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds : [];

    if (!trimmedQuestion && attachmentIds.length === 0) {
      return json({ error: 'Question or attachment is required' }, 400);
    }

    // ── Resolve & validate Model (Gemini only) ───────────────────────────────
    const resolvedModel =
      typeof body.model === 'string' && MODEL_ID_REGEX.test(body.model.trim())
        ? body.model.trim()
        : GEMINI_MODEL;

    // ── Verify session ownership once & retrieve GA4 property ID ─────────────
    let sessionRow: { id: string; ga4_property_id: string | null } | null = null;
    if (sessionId) {
      sessionRow = await db
        .prepare('SELECT id, ga4_property_id FROM sessions WHERE id = ? AND user_id = ?')
        .bind(sessionId, currentUser.id)
        .first<{ id: string; ga4_property_id: string | null }>();
      if (!sessionRow) return json({ error: 'Session not found' }, 404);
    }

    // ── Load & authorize attachments (scoped to user + session) ──────────────
    let attachmentMetas: AttachmentMeta[] = [];
    let geminiFileParts: any[] = [];
    if (attachmentIds.length > 0) {
      if (!sessionId) return json({ error: 'Attachments require a sessionId' }, 400);
      if (attachmentIds.length > 10) return json({ error: 'Too many attachments (max 10)' }, 400);
      attachmentMetas = await loadAttachments(db, attachmentIds, currentUser.id, sessionId);
      if (attachmentMetas.length !== attachmentIds.length) {
        return json({ error: 'One or more attachments not found or not accessible in this session' }, 400);
      }
      geminiFileParts = await buildGeminiFileParts(env, attachmentMetas);
    }

    // ── Build Conversation History (Gemini format) ───────────────────────────
    const geminiHistory: { role: string; parts: any[] }[] = [];
    if (sessionId) {
      const { results: dbMessages } = await db
        .prepare('SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .bind(sessionId)
        .all<{ role: string; text: string }>();

      for (const msg of dbMessages) {
        const geminiRole = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
        geminiHistory.push({ role: geminiRole, parts: [{ text: msg.text }] });
      }
    }

    const effectiveQuestion =
      trimmedQuestion ||
      (attachmentMetas.length
        ? `[${attachmentMetas.map((m) => m.filename).join(', ')} attached] Please analyze these files.`
        : trimmedQuestion);

    // ─────────────────────────────────────────────────────────────────────────
    // GA4 Mode - function calling with tools (user OAuth)
    // ─────────────────────────────────────────────────────────────────────────
    if (chatMode === 'ga4') {
      if (!sessionId || !sessionRow) {
        return json({ error: 'GA4 mode requires a valid session ID' }, 400);
      }

      const resolvedGa4Pid = sessionRow.ga4_property_id;
      if (!resolvedGa4Pid) {
        return json({ error: 'No GA4 property configured for this session.' }, 400);
      }

      const geminiAi = createGeminiClient(env);
      const result = await runGA4ChatGemini(
        geminiAi,
        geminiHistory,
        effectiveQuestion,
        resolvedGa4Pid,
        db,
        currentUser.id,
        env,
        resolvedModel,
        geminiFileParts,
        sessionId,
      );
      const answer = result.answer;
      const charts = result.charts;

      if (answer) {
        try {
          const now = Date.now();
          const attachmentsJson = attachmentMetas.length ? JSON.stringify(attachmentIds) : null;
          const chartsJson = charts.length > 0 ? JSON.stringify(charts) : null;

          const userRes: any = await db
            .prepare('INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)')
            .bind(sessionId, 'user', effectiveQuestion, now)
            .run();
          const userMsgId = (userRes as any)?.meta?.last_row_id;

          if (userMsgId && attachmentIds.length) {
            try {
              const placeholders = attachmentIds.map(() => '?').join(',');
              await db
                .prepare(
                  `UPDATE attachments SET message_id = ? WHERE id IN (${placeholders}) AND user_id = ? AND session_id = ?`,
                )
                .bind(userMsgId, ...attachmentIds, currentUser.id, sessionId)
                .run();
            } catch {
              /* ignore if schema doesn't support message_id */
            }
            try {
              await db
                .prepare('UPDATE messages SET attachments = ? WHERE id = ?')
                .bind(attachmentsJson, userMsgId)
                .run();
            } catch {
              /* ignore if column unavailable */
            }
          }

          try {
            await db
              .prepare('INSERT INTO messages (session_id, role, text, charts, created_at) VALUES (?, ?, ?, ?, ?)')
              .bind(sessionId, 'model', answer, chartsJson, now + 1)
              .run();
          } catch {
            await db
              .prepare('INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)')
              .bind(sessionId, 'model', answer, now + 1)
              .run();
          }

          await db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').bind(now, sessionId).run();
        } catch (dbErr) {
          console.error('Failed to persist GA4 chat to DB:', dbErr);
        }
      }

      return json({ answer, charts });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GTM Mode - SSE streaming
    // ─────────────────────────────────────────────────────────────────────────
    const containerJsonString = await env.GTM_CONTAINER.get('container', { cacheTtl: 3600 });
    if (!containerJsonString) {
      return json({ error: 'Container data not found' }, 500);
    }

    const geminiAi = createGeminiClient(env);
    return await streamGtmChatGemini(
      geminiAi,
      geminiHistory,
      effectiveQuestion,
      containerJsonString,
      env.GTM_CONTAINER,
      db,
      sessionId,
      resolvedModel,
      geminiFileParts,
      attachmentIds,
      effectiveQuestion,
      currentUser.id,
    );
  } catch (error: any) {
    console.error('Chat API Error:', error);
    const msg = String(error?.message ?? '');
    if (msg.includes('GA4_TOKEN_EXPIRED')) {
      return json(
        {
          error: 'Your Google Analytics session has expired. Please reconnect your GA4 account.',
          code: 'GA4_TOKEN_EXPIRED',
        },
        401,
      );
    }
    if (isSafeUserFacingError(msg)) {
      return json({ error: msg }, 400);
    }
    return json({ error: 'Error processing chat request' }, 500);
  }
}
