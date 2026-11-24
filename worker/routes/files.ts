// ── Files route handler: /api/files/* ────────────────────────────────────────
// Handles file uploads to R2/GCS with DB metadata, serving, and deletion.
// Supports images, PDFs, Office files, text/CSV, and generic files (25MB limit).

import { Env, AuthUser } from '../types';
import { json } from '../utils/http';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_FILES_PER_REQUEST = 10;

// Only raster images & PDFs are safe to render inline; HTML/SVG/JS force download.
const SAFE_INLINE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export interface UploadedFileLike {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function isUploadedFile(value: unknown): value is UploadedFileLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as any).arrayBuffer === 'function' &&
    typeof (value as any).name === 'string' &&
    typeof (value as any).size === 'number'
  );
}

export function buildContentDisposition(mimeType: string, filename: string): string {
  const baseMime = mimeType.split(';')[0].trim().toLowerCase();
  const disposition = SAFE_INLINE_MIMES.has(baseMime) ? 'inline' : 'attachment';
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  const encodedUtf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function sanitizePathSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'file';
}

// ── POST /api/files/upload ───────────────────────────────────────────────────
async function handleUpload(request: Request, env: Env, currentUser: AuthUser): Promise<Response> {
  if (!env.CHAT_FILES) {
    return json({ error: 'File storage (R2) is not configured on this deployment' }, 503);
  }
  const bucket = env.CHAT_FILES;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await request.formData();
  const sessionIdRaw = formData.get('sessionId');
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) return json({ error: 'sessionId is required' }, 400);

  // Verify session belongs to user
  const session = await env.gtm_chat_history
    .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, currentUser.id)
    .first();
  if (!session) return json({ error: 'Session not found' }, 404);

  const files: UploadedFileLike[] = [];
  for (const [key, value] of formData.entries()) {
    if ((key === 'files' || key === 'file') && isUploadedFile(value)) {
      files.push(value);
    }
  }

  if (files.length === 0) return json({ error: 'No files provided (use field name "files")' }, 400);
  if (files.length > MAX_FILES_PER_REQUEST) {
    return json({ error: `Too many files (max ${MAX_FILES_PER_REQUEST})` }, 400);
  }

  // Validate ALL files up-front before writing any object to storage
  for (const file of files) {
    if (file.size === 0) return json({ error: `File "${file.name}" is empty` }, 400);
    if (file.size > MAX_FILE_SIZE) {
      return json(
        { error: `File "${file.name}" exceeds 25MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)` },
        400,
      );
    }
  }

  const safeSession = sanitizePathSegment(sessionId);
  const results: any[] = [];
  const now = Date.now();

  for (const file of files) {
    const id = generateId();
    const safeName = sanitizePathSegment(file.name);
    const r2Key = `${currentUser.id}/${safeSession}/${id}-${safeName}`;
    const mimeType = file.type || 'application/octet-stream';
    const buffer = await file.arrayBuffer();

    await bucket.put(r2Key, buffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalName: file.name, userId: currentUser.id },
    });

    try {
      await env.gtm_chat_history
        .prepare(
          'INSERT INTO attachments (id, session_id, user_id, filename, mime_type, size, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, sessionId, currentUser.id, file.name, mimeType, file.size, r2Key, now)
        .run();
    } catch (e: any) {
      await bucket.delete(r2Key).catch(() => {});
      if (e.message?.includes('no such table')) {
        return json({ error: 'Attachments table not initialized. Run schema migration.' }, 500);
      }
      throw e;
    }

    results.push({
      id,
      filename: file.name,
      mime_type: mimeType,
      size: file.size,
      url: `/api/files/${id}`,
      created_at: now,
    });
  }

  return json({ files: results }, 201);
}

// ── GET /api/files/:id ───────────────────────────────────────────────────────
async function handleGet(
  _request: Request,
  env: Env,
  id: string,
  currentUser: AuthUser,
): Promise<Response> {
  const row = await env.gtm_chat_history
    .prepare('SELECT id, user_id, filename, mime_type, r2_key FROM attachments WHERE id = ?')
    .bind(id)
    .first<{ id: string; user_id: string; filename: string; mime_type: string; r2_key: string }>();

  if (!row) return json({ error: 'File not found' }, 404);
  if (row.user_id !== currentUser.id) return json({ error: 'Forbidden' }, 403);
  if (!env.CHAT_FILES) {
    return json({ error: 'File storage (R2) is not configured on this deployment' }, 503);
  }

  const obj = await env.CHAT_FILES.get(row.r2_key);
  if (!obj) return json({ error: 'File not found in storage' }, 404);

  const contentType = row.mime_type || obj.httpMetadata?.contentType || 'application/octet-stream';
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', buildContentDisposition(contentType, row.filename));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', 'sandbox');
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

  return new Response(obj.body, { headers });
}

// ── DELETE /api/files/:id ────────────────────────────────────────────────────
async function handleDelete(
  _request: Request,
  env: Env,
  id: string,
  currentUser: AuthUser,
): Promise<Response> {
  const row = await env.gtm_chat_history
    .prepare('SELECT user_id, r2_key FROM attachments WHERE id = ?')
    .bind(id)
    .first<{ user_id: string; r2_key: string }>();

  if (!row) return json({ error: 'File not found' }, 404);
  if (row.user_id !== currentUser.id) return json({ error: 'Forbidden' }, 403);

  if (env.CHAT_FILES) {
    await env.CHAT_FILES.delete(row.r2_key).catch(() => {});
  }
  await env.gtm_chat_history.prepare('DELETE FROM attachments WHERE id = ?').bind(id).run();

  return json({ success: true });
}

// ── GET /api/files?sessionId=xxx ─ list files for a session ─────────────────
async function handleList(
  _request: Request,
  env: Env,
  url: URL,
  currentUser: AuthUser,
): Promise<Response> {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return json({ error: 'sessionId query param required' }, 400);

  const session = await env.gtm_chat_history
    .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, currentUser.id)
    .first();
  if (!session) return json({ error: 'Session not found' }, 404);

  const { results } = await env.gtm_chat_history
    .prepare('SELECT id, filename, mime_type, size, created_at FROM attachments WHERE session_id = ? ORDER BY created_at ASC')
    .bind(sessionId)
    .all();

  const files = (results as any[]).map((r) => ({ ...r, url: `/api/files/${r.id}` }));
  return json({ files });
}

// ── Main dispatcher ──────────────────────────────────────────────────────────
export async function handleFiles(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
  currentUser: AuthUser,
): Promise<Response> {
  const method = request.method;

  if (parts.length === 3 && parts[2] === 'upload' && method === 'POST') {
    return handleUpload(request, env, currentUser);
  }

  if (parts.length === 2 && method === 'GET') {
    return handleList(request, env, url, currentUser);
  }

  if (parts.length === 3 && parts[2] !== 'upload') {
    const id = parts[2];
    if (method === 'GET') return handleGet(request, env, id, currentUser);
    if (method === 'DELETE') return handleDelete(request, env, id, currentUser);
  }

  return json({ error: 'Not Found' }, 404);
}
