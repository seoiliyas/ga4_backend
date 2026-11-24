// ── File helpers for AI multimodal handling ───────────────────────────────────
// Utilities to fetch attachments from R2/GCS, extract text/office content,
// and build model-specific content parts for Google Gemini.

import { Env } from '../types';

export interface AttachmentMeta {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
}

// ── MIME helpers ─────────────────────────────────────────────────────────────

export function isImage(mime: string): boolean {
  // Exclude SVG since Gemini inlineData rejects image/svg+xml (handled as text/XML instead)
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

export function isPdf(mime: string): boolean {
  return mime === 'application/pdf' || mime === 'application/x-pdf';
}

export function isTextLike(mime: string, filename: string): boolean {
  const textMimes = [
    'text/plain',
    'text/csv',
    'text/markdown',
    'text/html',
    'image/svg+xml',
    'application/json',
    'application/xml',
    'text/xml',
    'application/csv',
  ];
  if (textMimes.includes(mime)) return true;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['csv', 'txt', 'md', 'json', 'xml', 'log', 'tsv', 'html', 'htm', 'svg'].includes(ext);
}

export function isExcel(mime: string, filename: string): boolean {
  const excelMimes = [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
  ];
  if (excelMimes.includes(mime)) return true;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['xls', 'xlsx', 'xlsm', 'xlsb'].includes(ext);
}

export function isWord(mime: string, filename: string): boolean {
  const wordMimes = [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  if (wordMimes.includes(mime)) return true;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['doc', 'docx'].includes(ext);
}

// ── R2/GCS fetch & base64 conversion ─────────────────────────────────────────

export async function fetchAttachmentAsBase64(
  env: Env,
  meta: AttachmentMeta,
): Promise<{ base64: string; bytes: ArrayBuffer; mime: string }> {
  if (!env.CHAT_FILES) {
    throw new Error('File storage (R2) is not configured on this deployment');
  }
  const obj = await env.CHAT_FILES.get(meta.r2_key);
  if (!obj) throw new Error(`File not found in storage: ${meta.filename}`);
  const bytes = await obj.arrayBuffer();
  const base64 = arrayBufferToBase64(bytes);
  return { base64, bytes, mime: meta.mime_type };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// ── Text & Office (OOXML ZIP) Extraction ──────────────────────────────────────

const MAX_CONTEXT_CHARS = 100_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 2 * 1024 * 1024; // 2MB zip-bomb guard

export function tryExtractText(bytes: ArrayBuffer): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
    const text = decoder.decode(bytes);
    // Heuristic: if > 30% is replacement char, likely binary => skip
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad / Math.max(text.length, 1) > 0.3) return null;
    if (text.length > MAX_CONTEXT_CHARS) {
      return (
        text.slice(0, MAX_CONTEXT_CHARS) +
        `\n\n[... truncated: ${text.length - MAX_CONTEXT_CHARS} more characters omitted ...]`
      );
    }
    return text;
  } catch {
    return null;
  }
}

function decodeXmlEntities(xmlText: string): string {
  return xmlText
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function inflateRawBounded(compressed: Uint8Array, expectedSize: number): Promise<Uint8Array | null> {
  if (expectedSize > MAX_ZIP_UNCOMPRESSED_BYTES) return null;
  if (typeof DecompressionStream === 'undefined') return null;

  try {
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    const ds = new DecompressionStream('deflate-raw' as any);
    const stream = new Blob([copy]).stream().pipeThrough(ds as any);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      total += chunk.byteLength;
      if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Lightweight zero-dependency ZIP reader for OOXML files (.docx, .xlsx, .xlsm).
 * Uses Central Directory (EOCD) so data descriptors work reliably.
 */
async function extractZipXmlEntries(
  bytes: ArrayBuffer,
  predicate: (name: string) => boolean,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const data = new Uint8Array(bytes);
  const view = new DataView(bytes);
  if (data.length < 22) return result;

  // Locate End of Central Directory (PK\x05\x06) scanning backwards up to 64KB
  const minOffset = Math.max(0, data.length - 65_557);
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return result;

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  let ptr = cdOffset;
  const utf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

  for (let idx = 0; idx < entryCount && ptr + 46 <= eocdOffset; idx++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const name = utf8.decode(data.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!predicate(name)) continue;
    if (uncompSize > MAX_ZIP_UNCOMPRESSED_BYTES) continue;
    if (localHeaderOffset + 30 > data.length) continue;
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue;

    const lhNameLen = view.getUint16(localHeaderOffset + 26, true);
    const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const compStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    if (compStart + compSize > data.length) continue;

    const compressedSlice = data.subarray(compStart, compStart + compSize);
    let plainBytes: Uint8Array | null = null;
    if (method === 0) {
      plainBytes = compressedSlice;
    } else if (method === 8) {
      plainBytes = await inflateRawBounded(compressedSlice, uncompSize);
    }

    if (plainBytes) {
      result.set(name, utf8.decode(plainBytes));
    }
  }

  return result;
}

function parseDocxXml(xml: string): string {
  // Replace paragraph/line breaks with newlines, then extract text nodes
  const withBreaks = xml
    .replace(/<w:p\b[^>]*>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return decodeXmlEntities(stripped)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseSharedStringsXml(xml: string): string[] {
  const strings: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const inner = siMatch[1];
    const tParts: string[] = [];
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(inner)) !== null) {
      tParts.push(decodeXmlEntities(tMatch[1]));
    }
    strings.push(tParts.join(''));
  }
  return strings;
}

function parseWorksheetXml(xml: string, sharedStrings: string[]): string {
  const rows: string[] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = typeMatch ? typeMatch[1] : '';

      if (cellType === 'inlineStr') {
        const isMatch = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        cells.push(isMatch ? decodeXmlEntities(isMatch[1]) : '');
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
        const rawVal = vMatch ? vMatch[1] : '';
        if (cellType === 's') {
          const idx = Number(rawVal);
          cells.push(Number.isInteger(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : rawVal);
        } else {
          cells.push(decodeXmlEntities(rawVal));
        }
      }
    }

    if (cells.some((c) => c !== '')) {
      rows.push(cells.join('\t'));
    }
  }
  return rows.join('\n');
}

export async function extractOfficeText(bytes: ArrayBuffer, filename: string): Promise<string | null> {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (ext === 'docx') {
    const entries = await extractZipXmlEntries(bytes, (name) => name === 'word/document.xml');
    const docXml = entries.get('word/document.xml');
    if (!docXml) return null;
    const text = parseDocxXml(docXml);
    return text ? text.slice(0, MAX_CONTEXT_CHARS) : null;
  }

  if (ext === 'xlsx' || ext === 'xlsm') {
    const entries = await extractZipXmlEntries(
      bytes,
      (name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name),
    );
    const sharedXml = entries.get('xl/sharedStrings.xml');
    const sharedStrings = sharedXml ? parseSharedStringsXml(sharedXml) : [];
    const sheetNames = [...entries.keys()]
      .filter((k) => k.startsWith('xl/worksheets/'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (sheetNames.length === 0) return null;

    const sections: string[] = [];
    for (const sName of sheetNames) {
      const sheetLabel = sName.split('/').pop()?.replace(/\.xml$/i, '') || sName;
      const tsv = parseWorksheetXml(entries.get(sName)!, sharedStrings);
      if (tsv) sections.push(`[${sheetLabel}]\n${tsv}`);
    }
    const combined = sections.join('\n\n');
    if (!combined) return null;
    return combined.length > MAX_CONTEXT_CHARS
      ? combined.slice(0, MAX_CONTEXT_CHARS) + '\n\n[... truncated ...]'
      : combined;
  }

  return null;
}

// ── Load attachments metadata from D1/Postgres ────────────────────────────────

export async function loadAttachments(
  db: D1Database,
  ids: string[],
  userId: string,
  sessionId?: string,
): Promise<AttachmentMeta[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const sql = sessionId
    ? `SELECT id, filename, mime_type, size, r2_key FROM attachments WHERE id IN (${placeholders}) AND user_id = ? AND session_id = ?`
    : `SELECT id, filename, mime_type, size, r2_key FROM attachments WHERE id IN (${placeholders}) AND user_id = ?`;
  const params = sessionId ? [...ids, userId, sessionId] : [...ids, userId];

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<AttachmentMeta>();

  const map = new Map(results.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id)).filter(Boolean) as AttachmentMeta[];
}

// ── Gemini content parts ─────────────────────────────────────────────────────

export async function buildGeminiFileParts(
  env: Env,
  metas: AttachmentMeta[],
): Promise<any[]> {
  const parts: any[] = [];
  for (const meta of metas) {
    try {
      const { base64, bytes, mime } = await fetchAttachmentAsBase64(env, meta);

      if (isImage(mime) || isPdf(mime)) {
        parts.push({
          inlineData: { mimeType: mime, data: base64 },
        });
        parts.push({ text: `[File: ${meta.filename} (${mime})]` });
      } else if (isTextLike(mime, meta.filename)) {
        const text = tryExtractText(bytes);
        if (text) {
          parts.push({
            text: `\n\n[Attached file: ${meta.filename} (${mime})]\n\`\`\`\n${text}\n\`\`\``,
          });
        } else {
          parts.push({
            text: `\n\n[Attached file: ${meta.filename} (${mime}) — could not extract readable UTF-8 text]`,
          });
        }
      } else if (isExcel(mime, meta.filename) || isWord(mime, meta.filename)) {
        const officeText = await extractOfficeText(bytes, meta.filename).catch(() => null);
        const text = officeText || tryExtractText(bytes);
        if (text && text.trim().length > 0) {
          parts.push({
            text: `\n\n[Attached file: ${meta.filename} (${mime}) — extracted text:]\n\`\`\`\n${text}\n\`\`\``,
          });
        } else {
          parts.push({
            text: `\n\n[Attached file: ${meta.filename} (${mime}, ${(meta.size / 1024).toFixed(1)}KB) — legacy binary ${isExcel(mime, meta.filename) ? 'spreadsheet' : 'document'}. Only .docx/.xlsx/.csv/PDF/text formats support automatic content extraction. Inform the user if you need them to export it as CSV, PDF, or .xlsx/.docx.]`,
          });
        }
      } else {
        const text = tryExtractText(bytes);
        if (text && text.trim().length > 10) {
          parts.push({
            text: `\n\n[Attached file: ${meta.filename} (${mime})]\n\`\`\`\n${text}\n\`\`\``,
          });
        } else {
          parts.push({
            text: `\n\n[Attached file: ${meta.filename} (${mime}, ${(meta.size / 1024).toFixed(1)}KB) — binary file. Acknowledge receipt.]`,
          });
        }
      }
    } catch (err: any) {
      console.error(`Failed to process Gemini attachment ${meta.filename}:`, err);
      parts.push({ text: `\n\n[Attached file: ${meta.filename} — failed to load]` });
    }
  }
  return parts;
}
