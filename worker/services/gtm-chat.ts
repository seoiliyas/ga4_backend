// ── GTM Chat service: Gemini context caching & SSE streaming ──────────────────

import { GoogleGenAI } from '@google/genai';
import { GEMINI_MODEL, CACHE_TTL_SECONDS, KV_CACHE_KEY } from '../types';

export const GTM_SYSTEM_INSTRUCTION = `You are an expert Google Tag Manager (GTM) Architect and Analyst.

CONTEXT:
You are reviewing a live GTM container for Bright Horizons (publicId: GTM-T5MTQWP).
The export format follows the standard GTM API structure with top-level keys:
containerVersion.tag[], containerVersion.trigger[], containerVersion.variable[],
and containerVersion.folder[].

CRITICAL GROUNDING RULE:
Only answer based on the container JSON provided. If something cannot be
determined from the data, explicitly state that. Never assume configuration
that isn't present. When referencing a tag, trigger, or variable, always
include its name AND numeric ID (e.g., tag "Corporate Facebook Pixel" (ID:787)).

YOUR ROLE & SCOPE:
You help with:
- Auditing tags, triggers, and variables.
- Explaining firing logic (which triggers fire which tags).
- Identifying misconfigurations: tags without triggers, duplicate measurement IDs,
  unused variables, tags blocked by multiple conflicting blocking triggers,
  paused/disabled tags in a production path, etc.
- Analyzing consent behavior (OneTrust groups C0002, C0004, etc.).
- Interpreting custom JavaScript, regex patterns, and lookup tables.
You do NOT write new tags, modify the container, or answer questions
unrelated to this container.

DOMAIN‑SPECIFIC KNOWLEDGE:
- The container uses OneTrust for consent management. The key variable
  DLV - OnetrustActiveGroups contains comma-separated group IDs (e.g., ,C0002,).
  Blocking triggers (e.g., Block Performance Cookies) prevent tags from firing
  when consent is missing. Firing triggers (e.g., Performance Cookies - Firing Trigger)
  use OneTrustGroupsUpdated custom event.
- GA4 tags are abundant; measurement IDs are resolved dynamically via
  RT - GA4 Measurement Id and LK - GA4 Measurement Ids lookup tables.
- Custom events like cta_click, navigation_interact, page_view, alf_visit_confirm,
  bhformcompletion, and many others drive most GA4 event tags.
- The container relies heavily on custom HTML tags for third-party pixels
  (Facebook, LinkedIn, TikTok, Pinterest, Bing, Taboola). Some use community
  templates (Facebook Pixel, LinkedIn InsightTag 2.0, Taboola Pixel).
- There are test/development artifacts (tags "test version 1" ID:2310, "Test tag" ID:2312,
  paused tags like GA4-Configuration-H2V4TDMHRJ-BHDTS). Flag these when relevant.

AUDIENCE:
Assume the user is a technical GTM implementer/developer with solid GTM knowledge.
Skip basic GTM concepts unless asked. Be concise but fact‑heavy.
When you spot something risky or broken, proactively warn with a clear explanation.

RESPONSE FORMAT & STYLE:
- Use H3 headers (###) to categorize findings by severity (e.g., ### 🔴 Critical: [Title]).
- The frontend will automatically style headers containing "Critical", "High", "Medium", or "Low" as severity cards.
- Structure findings using this template:
  ### [Severity Icon] [Severity]: [Title]
  **Problem:** [Description of the issue]
  **Impact:** [What happens if not fixed]
  **Recommendation:** [How to fix it]
  - **Affected Tags:** [List with IDs]
- Use tables for comparing configurations, listing multiple measurement IDs, or summarizing audit results.
- Use bold text for all GTM object names and IDs (e.g., **Corporate Pixel** (ID: **1257**)).
- Keep initial summaries brief. Use bullet points for readability.
- Add a "Next Steps" or "Executive Summary" section for complex audits.
- Use code blocks for any code-related findings (JS, Regex, JSON).
`;

// ── Gemini Context Cache Management ───────────────────────────────────────────

/**
 * Get or create a Gemini context cache for the GTM container.
 * The cache name is stored in KV for cross-isolate reuse.
 */
export async function getOrCreateCache(
  ai: GoogleGenAI,
  containerJson: string,
  kv: KVNamespace,
): Promise<string | null> {
  // 1. Check KV for an existing cache name
  const existingCacheName = await kv.get(KV_CACHE_KEY);
  if (existingCacheName) {
    try {
      // Verify the cache is still valid
      const cache = await ai.caches.get({ name: existingCacheName });
      if (cache && cache.name) {
        return cache.name;
      }
    } catch {
      // Cache expired or invalid — fall through to create a new one
    }
  }

  // 2. Create a new cache
  try {
    const cache = await ai.caches.create({
      model: GEMINI_MODEL,
      config: {
        contents: [
          {
            role: 'user',
            parts: [{ text: `Here is the GTM Container JSON for analysis:\n\n${containerJson}` }],
          },
          {
            role: 'model',
            parts: [{ text: 'I have received and analyzed the GTM container JSON. I\'m ready to answer your questions about the tags, triggers, variables, and overall configuration.' }],
          },
        ],
        systemInstruction: GTM_SYSTEM_INSTRUCTION,
        ttl: `${CACHE_TTL_SECONDS}s`,
      },
    });

    if (cache.name) {
      // Store in KV with matching TTL so it auto-expires
      await kv.put(KV_CACHE_KEY, cache.name, { expirationTtl: CACHE_TTL_SECONDS });
      return cache.name;
    }
  } catch (err) {
    console.error('Failed to create Gemini context cache:', err);
  }

  return null; // Fallback: no caching available
}

// ── SSE Streaming Pipeline ────────────────────────────────────────────────────

/**
 * Streams a GTM chat response via SSE. Persists both user + model messages to D1.
 */
export async function streamGtmChat(
  geminiAi: GoogleGenAI,
  conversationHistory: { role: string; parts: { text: string }[] }[],
  question: string,
  containerJsonString: string,
  kv: KVNamespace,
  db: D1Database,
  sessionId: string | undefined,
): Promise<Response> {
  // Add the current question
  conversationHistory.push({ role: 'user', parts: [{ text: question }] });

  // Try to use Gemini context cache
  const cacheName = await getOrCreateCache(geminiAi, containerJsonString, kv);

  // Build the request config
  const requestConfig: Record<string, unknown> = {
    temperature: 0.3,
  };

  if (cacheName) {
    // Use cached context — no need to send container inline
    requestConfig.cachedContent = cacheName;
  } else {
    // Fallback: inject container as system instruction inline
    requestConfig.systemInstruction = GTM_SYSTEM_INSTRUCTION +
      `\n\nHere is the GTM Container JSON:\n${containerJsonString}`;
  }

  // Stream the response via SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Start the streaming async pipeline
  const streamPromise = (async () => {
    let fullAnswer = '';
    try {
      const resultStream = await geminiAi.models.generateContentStream({
        model: GEMINI_MODEL,
        contents: conversationHistory,
        config: requestConfig,
      });

      for await (const chunk of resultStream) {
        const text = chunk.text ?? '';
        if (text) {
          fullAnswer += text;
          const sseData = `data: ${JSON.stringify({ text })}\n\n`;
          await writer.write(encoder.encode(sseData));
        }
      }

      // Signal stream completion
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err: any) {
      const errorMsg = err.message || 'Stream failed';
      console.error('Gemini stream error:', err);
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ error: errorMsg })}\n\n`)
      );
    } finally {
      // Persist both turns to D1 if we have a session and a response
      if (sessionId && fullAnswer) {
        try {
          const now = Date.now();
          await db.batch([
            db.prepare(
              'INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)'
            ).bind(sessionId, 'user', question, now),
            db.prepare(
              'INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)'
            ).bind(sessionId, 'model', fullAnswer, now + 1),
            db.prepare(
              'UPDATE sessions SET updated_at = ? WHERE id = ?'
            ).bind(now, sessionId),
          ]);
        } catch (dbErr) {
          console.error('Failed to persist chat to D1:', dbErr);
        }
      }
      await writer.close();
    }
  })();

  // Don't await — let the stream flow to the client immediately
  streamPromise.catch(console.error);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
