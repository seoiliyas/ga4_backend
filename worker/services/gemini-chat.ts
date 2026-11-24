// services/gemini-chat.ts
// ── GTM & GA4 Chat services: GoogleGenAI (Gemini) implementations ─────────────

import { GoogleGenAI } from '@google/genai/node';
import { Env, GEMINI_MODEL, CACHE_TTL_SECONDS, KV_CACHE_KEY } from '../types';
import { sha256Hex } from '../utils/crypto';
import { getOAuthAccessToken } from './ga4/oauth';
import { executeGA4Function, GA4_TOOL_DEFINITIONS } from './ga4/api';
import {
  createChart,
  CREATE_CHART_DECLARATION,
  CreateChartInput,
  ChartStorageContext,
} from './ga4/tools/charts';

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
 * Get or create a Gemini context cache scoped by model + container content hash.
 * The cache name is stored in KV for cross-isolate reuse.
 */
export async function getOrCreateCache(
  ai: GoogleGenAI,
  containerJson: string,
  kv: KVNamespace,
  modelName: string = GEMINI_MODEL,
): Promise<string | null> {
  const containerHash = await sha256Hex(containerJson, 16);
  const cacheKvKey = `${KV_CACHE_KEY}:${modelName}:${containerHash}`;

  // 1. Check KV for an existing cache name for this model + container hash
  const existingCacheName = await kv.get(cacheKvKey);
  if (existingCacheName) {
    try {
      const cache = await ai.caches.get({ name: existingCacheName });
      if (cache && cache.name) {
        return cache.name;
      }
    } catch {
      // Cache expired or invalid — fall through to create a new one
    }
  }

  // 2. Create a new cache with the exact model requested
  try {
    const cache = await ai.caches.create({
      model: modelName,
      config: {
        contents: [
          {
            role: 'user',
            parts: [{ text: `Here is the GTM Container JSON for analysis:\n\n${containerJson}` }],
          },
          {
            role: 'model',
            parts: [
              {
                text: "I have received and analyzed the GTM container JSON. I'm ready to answer your questions about the tags, triggers, variables, and overall configuration.",
              },
            ],
          },
        ],
        systemInstruction: GTM_SYSTEM_INSTRUCTION,
        ttl: `${CACHE_TTL_SECONDS}s`,
      },
    });

    if (cache.name) {
      await kv.put(cacheKvKey, cache.name, { expirationTtl: CACHE_TTL_SECONDS });
      return cache.name;
    }
  } catch (err) {
    console.warn(`Context cache unavailable for ${modelName}, falling back to inline context:`, err);
  }

  return null;
}

// ── SSE Streaming Pipeline ────────────────────────────────────────────────────

async function safeWrite(writer: WritableStreamDefaultWriter<Uint8Array>, data: Uint8Array): Promise<boolean> {
  try {
    await writer.write(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams a GTM chat response via SSE. Persists both user + model messages to D1/Postgres.
 */
export async function streamGtmChat(
  geminiAi: GoogleGenAI,
  conversationHistory: { role: string; parts: any[] }[],
  question: string,
  containerJsonString: string,
  kv: KVNamespace,
  db: D1Database,
  sessionId: string | undefined,
  model?: string,
  fileParts: any[] = [],
  attachmentIds: string[] = [],
  persistedText?: string,
  userId?: string,
): Promise<Response> {
  const resolvedModel = model || GEMINI_MODEL;
  const userParts: any[] = [{ text: question || 'Please analyze the attached files.' }];
  if (fileParts.length) userParts.push(...fileParts);
  conversationHistory.push({ role: 'user', parts: userParts });

  // Try to use Gemini context cache matched to resolvedModel
  const cacheName = await getOrCreateCache(geminiAi, containerJsonString, kv, resolvedModel);

  const requestConfig: Record<string, unknown> = {
    temperature: 0.3,
  };

  if (cacheName) {
    requestConfig.cachedContent = cacheName;
  } else {
    requestConfig.systemInstruction =
      GTM_SYSTEM_INSTRUCTION + `\n\nHere is the GTM Container JSON:\n${containerJsonString}`;
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamPromise = (async () => {
    let fullAnswer = '';
    let clientDisconnected = false;
    try {
      const resultStream = await geminiAi.models.generateContentStream({
        model: resolvedModel,
        contents: conversationHistory as any,
        config: requestConfig,
      });

      for await (const chunk of resultStream) {
        const text = chunk.text ?? '';
        if (text) {
          fullAnswer += text;
          const ok = await safeWrite(writer, encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          if (!ok) {
            clientDisconnected = true;
            break;
          }
        }
      }

      if (!clientDisconnected) {
        await safeWrite(writer, encoder.encode('data: [DONE]\n\n'));
      }
    } catch (err: any) {
      const errorMsg = err.message || 'Stream failed';
      console.error('Gemini stream error:', err);
      await safeWrite(writer, encoder.encode(`data: ${JSON.stringify({ error: errorMsg })}\n\n`));
    } finally {
      if (sessionId && fullAnswer) {
        try {
          const now = Date.now();
          const userText = persistedText || question || `[${fileParts.length} file(s) attached]`;
          const attachmentsJson = attachmentIds.length ? JSON.stringify(attachmentIds) : null;
          const userRes: any = await db
            .prepare('INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)')
            .bind(sessionId, 'user', userText, now)
            .run();
          const userMsgId = (userRes as any)?.meta?.last_row_id;

          if (userMsgId && attachmentIds.length) {
            try {
              const placeholders = attachmentIds.map(() => '?').join(',');
              const attSql = userId
                ? `UPDATE attachments SET message_id = ? WHERE id IN (${placeholders}) AND user_id = ? AND session_id = ?`
                : `UPDATE attachments SET message_id = ? WHERE id IN (${placeholders}) AND session_id = ?`;
              const attParams = userId
                ? [userMsgId, ...attachmentIds, userId, sessionId]
                : [userMsgId, ...attachmentIds, sessionId];
              await db.prepare(attSql).bind(...attParams).run();
            } catch {
              /* ignore if column unavailable */
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

          await db
            .prepare('INSERT INTO messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)')
            .bind(sessionId, 'model', fullAnswer, now + 1)
            .run();
          await db
            .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
            .bind(now, sessionId)
            .run();
        } catch (dbErr) {
          console.error('Failed to persist chat to D1:', dbErr);
        }
      }
      await writer.close().catch(() => {});
    }
  })();

  streamPromise.catch(console.error);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// ── Types ──────────────────────────────────────────────────────────────────────
export interface TextPart {
  text: string;
  thought?: boolean;
}

export interface FunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
}

export interface FunctionResponsePart {
  functionResponse: {
    id?: string;
    name: string;
    response: {
      name: string;
      content: string;
    };
  };
}

export type Part = TextPart | FunctionCallPart | FunctionResponsePart;

export interface Content {
  role: string;
  parts: Part[];
}

export interface GA4ChatResult {
  answer: string;
  updatedHistory: Content[];
  charts: string[];
}

// Helper to convert lowercase schema types to uppercase (standard Gemini format)
function mapTypesToUppercase(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  const result = { ...schema };
  if (typeof result.type === 'string') {
    result.type = result.type.toUpperCase();
  }

  if (result.properties) {
    const props: any = {};
    for (const [k, v] of Object.entries(result.properties)) {
      props[k] = mapTypesToUppercase(v);
    }
    result.properties = props;
  }

  if (result.items) {
    result.items = mapTypesToUppercase(result.items);
  }

  return result;
}

const ALL_FUNCTION_DECLARATIONS = [
  ...GA4_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: mapTypesToUppercase(tool.input_schema),
  })),
  {
    name: CREATE_CHART_DECLARATION.name,
    description: CREATE_CHART_DECLARATION.description,
    parameters: mapTypesToUppercase(CREATE_CHART_DECLARATION.input_schema),
  },
];

const PROPERTY_ID_REGEX = /^\d+$/;

function validatePropertyId(propertyId: string): void {
  if (propertyId && !PROPERTY_ID_REGEX.test(propertyId)) {
    throw new Error(
      `Invalid GA4 property ID format: "${propertyId}". Expected a numeric string.`,
    );
  }
}

export const GA4_SYSTEM_INSTRUCTION = `
You are an expert Google Analytics 4 (GA4) Analyst. You have access to GA4 tools
that can query live data from the user's Google Analytics property, and a
create_chart tool that renders charts as images shown directly in the chat.

When the user asks a question, use the available tools to fetch the relevant data,
then lead with the key numbers and offer to go deeper if it would be useful.
Adapt your language to the user: technical if they use analytics jargon,
plain-English if they don't.

── Date ranges ──────────────────────────────────────────────────────────────────
When the user does not specify a date range, default to the last 28 days
(startDate: "28daysAgo", endDate: "today"). Always tell the user which date
range you used.

── Tool routing ──────────────────────────────────────────────────────────────────
1. ALWAYS call the appropriate tool to fetch real data before answering.
   Never guess, estimate, or invent numbers.

2. Use run_report for most analytics queries: events, sessions, users,
   conversions, traffic sources, page views, etc.

3. Use run_realtime_report ONLY for truly real-time questions such as
   "how many users are on the site right now" or "what are active users doing".
   For "today so far" aggregated metrics prefer run_report with
   startDate: "today" and endDate: "today".

4. Use run_funnel_report for funnel or conversion-path analysis.

5. Use get_account_summaries if the user has not specified a property ID,
   wants to browse their properties, or asks "which properties do I have access to".

6. Use get_property_details for questions about a specific property's
   configuration, timezone, currency, or data-retention settings.

7. Before using any dimension or metric NOT in GA4's standard schema,
   always call get_custom_dimensions_and_metrics first.

── Charts ────────────────────────────────────────────────────────────────────────
8. After fetching data, proactively call create_chart to visualise results
   whenever the data would benefit from a chart:
   - Time-series data          → line chart
   - Ranking / top-N           → horizontalBar (long labels) or bar
   - Part-of-whole (channels)  → pie or doughnut
   - Funnel steps              → bar with the steps as labels
   - Multi-metric comparison   → radar
   Always pass descriptive axis labels and a clear title.
   When you call create_chart, embed the returned displayUrl (permanentUrl or shortUrl)
   in your reply using exact markdown syntax: ![Chart title](displayUrl)

── Exact API names ───────────────────────────────────────────────────────────────
9. Always use exact GA4 API names both when describing fields AND in tool calls.
   Correct:   eventName, totalUsers, sessions, pagePathPlusQueryString
   Incorrect: event_name, "Event Name", total users

── Error handling ────────────────────────────────────────────────────────────────
10. If a tool returns an error, tell the user what went wrong and suggest a fix.
    Do NOT retry with identical parameters. Do NOT proceed as if you have data.

── Data quality ──────────────────────────────────────────────────────────────────
11. If a report indicates sampling, row limits, or data thresholds, say so
    before presenting numbers.

── Formatting ────────────────────────────────────────────────────────────────────
12. Format currency with the appropriate symbol and 2 decimal places.
13. Lead with key numbers, then offer to drill down further.

── Follow-up ─────────────────────────────────────────────────────────────────────
14. After answering, suggest 1-2 related analyses the user might find valuable.
`.trim();

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  accessToken: string,
  chartContext?: ChartStorageContext,
): Promise<{ resultStr: string; chartUrl?: string }> {
  if (name === 'create_chart') {
    const result = await createChart(args as unknown as CreateChartInput, chartContext);
    const displayUrl = result.permanentUrl ?? result.shortUrl;
    return {
      resultStr: JSON.stringify({
        displayUrl,
        permanentUrl: result.permanentUrl,
        shortUrl: result.shortUrl,
        renderHint: `Embed the chart with: ![chart](${displayUrl})`,
      }),
      chartUrl: displayUrl,
    };
  }
  const resultStr = await executeGA4Function(name, args, accessToken);
  return { resultStr };
}

export async function runGA4Chat(
  geminiAi: GoogleGenAI,
  conversationHistory: Content[],
  question: string,
  ga4PropertyId: string,
  db: D1Database,
  userId: string,
  env: Env,
  model?: string,
  fileParts: any[] = [],
  sessionId?: string,
): Promise<GA4ChatResult> {
  if (ga4PropertyId) validatePropertyId(ga4PropertyId);

  const currentInstruction = ga4PropertyId
    ? `${GA4_SYSTEM_INSTRUCTION}\n\nThe user has currently selected GA4 Property ID: ${ga4PropertyId}. Use this property ID by default for all queries unless the user specifies otherwise.`
    : GA4_SYSTEM_INSTRUCTION;

  const userParts: any[] = [{ text: question || 'Please analyze the attached files.' }];
  if (fileParts.length) userParts.push(...fileParts);
  const contents: Content[] = [
    ...conversationHistory,
    { role: 'user', parts: userParts },
  ];

  const MAX_TOOL_TURNS = 20;
  const chartUrls: string[] = [];

  let accessToken = await getOAuthAccessToken(db, userId, env);

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    if (turn > 0) {
      try {
        accessToken = await getOAuthAccessToken(db, userId, env);
      } catch (err) {
        console.error(`[GA4] Token refresh failed at turn ${turn + 1}:`, err);
      }
    }

    const response = await geminiAi.models.generateContent({
      model: model || GEMINI_MODEL,
      contents: contents as any,
      config: {
        systemInstruction: currentInstruction,
        tools: [{ functionDeclarations: ALL_FUNCTION_DECLARATIONS }],
        temperature: 0.3,
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate) break;

    if (candidate.finishReason === 'SAFETY') {
      throw new Error('GA4 response was blocked by Gemini safety filters.');
    }
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new Error(
        'GA4 response was cut off because it exceeded the token limit. Try a more specific question.',
      );
    }
    if (!candidate.content?.parts?.length) break;

    const parts = candidate.content.parts as Part[];

    const functionCalls = parts
      .filter((p): p is FunctionCallPart => 'functionCall' in p && !!(p as FunctionCallPart).functionCall)
      .map((p) => p.functionCall);

    // Filter out model thought traces so internal reasoning never leaks to chat UI
    const textParts = parts
      .filter((p): p is TextPart => 'text' in p && !p.thought)
      .map((p) => p.text)
      .join('');

    if (functionCalls.length > 0) {
      contents.push({ role: 'model', parts });

      // Execute multiple tool calls in parallel for faster multi-query turns
      const executed = await Promise.all(
        functionCalls.map(async (fc) => {
          try {
            const out = await executeTool(
              fc.name,
              (fc.args ?? {}) as Record<string, unknown>,
              accessToken,
              { env, db, userId, sessionId },
            );
            return { fc, resultStr: out.resultStr, chartUrl: out.chartUrl };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[GA4] Tool "${fc.name}" failed: ${message}`);
            return { fc, resultStr: JSON.stringify({ error: message }), chartUrl: undefined };
          }
        }),
      );

      const functionResponses: FunctionResponsePart[] = executed.map(({ fc, resultStr, chartUrl }) => {
        if (chartUrl) chartUrls.push(chartUrl);
        return {
          functionResponse: {
            ...(fc.id ? { id: fc.id } : {}),
            name: fc.name,
            response: { name: fc.name, content: resultStr },
          },
        };
      });

      contents.push({ role: 'user', parts: functionResponses });
    } else {
      return {
        answer: textParts,
        updatedHistory: contents,
        charts: chartUrls,
      };
    }
  }

  const lastModelContent = [...contents].reverse().find((c) => c.role === 'model');
  const lastFunctions =
    lastModelContent?.parts
      .filter((p): p is FunctionCallPart => 'functionCall' in p)
      .map((p) => p.functionCall.name)
      .join(', ') ?? 'unknown';

  throw new Error(
    `GA4 chat exhausted the maximum of ${MAX_TOOL_TURNS} tool turns without producing a text response. ` +
      `Last functions called: ${lastFunctions}.`,
  );
}
