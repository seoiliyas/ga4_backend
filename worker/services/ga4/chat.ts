// services/ga4/chat.ts
// ── GA4 Chat service: Gemini function-calling loop ────────────────────────────
import { GoogleGenAI } from '@google/genai';
import { Env } from '../../types';
import { GEMINI_MODEL } from '../../types';
import { getOAuthAccessToken } from './oauth';
import { executeGA4Function, GA4_FUNCTION_DECLARATIONS } from './api';
// [NEW] Chart tool
import { createChart, CREATE_CHART_DECLARATION, CreateChartInput } from './tools/charts';

// ── Types ──────────────────────────────────────────────────────────────────────
interface TextPart {
  text: string | { text: string };   // <-- allow both string and object
}

interface FunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
}

interface FunctionResponsePart {
  functionResponse: {
    name: string;
    response: {
      name: string;
      content: string;
    };
  };
}

type Part = TextPart | FunctionCallPart | FunctionResponsePart;

interface Content {
  role: string;
  parts: Part[];
}

// [CHANGED] charts carries every image URL produced during the conversation
// turn so the UI can render them inline alongside the text answer.
export interface GA4ChatResult {
  answer: string;
  updatedHistory: Content[];
  /** Public image URLs for every chart Gemini generated this turn. */
  charts: string[];
}

// ── All function declarations (GA4 + chart) ───────────────────────────────────
// [NEW] Merge chart declaration with the existing GA4 ones.
const ALL_FUNCTION_DECLARATIONS = [
  ...GA4_FUNCTION_DECLARATIONS,
  CREATE_CHART_DECLARATION,
];

// ── Property ID validation ─────────────────────────────────────────────────────
const PROPERTY_ID_REGEX = /^\d+$/;

function validatePropertyId(propertyId: string): void {
  if (propertyId && !PROPERTY_ID_REGEX.test(propertyId)) {
    throw new Error(
      `Invalid GA4 property ID format: "${propertyId}". Expected a numeric string.`,
    );
  }
}

// ── System prompt ──────────────────────────────────────────────────────────────
const GA4_SYSTEM_INSTRUCTION = `
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
   When you call create_chart, include the returned imageUrl in your reply
   using the exact markdown syntax: ![Chart title](imageUrl)
   This renders the image inline in the chat for the user.

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

// ── Robust text extraction ─────────────────────────────────────────────────────
/**
 * Extracts a plain string from a text part, handling both:
 * - { text: "string" }
 * - { text: { text: "string" } }   (Vertex AI sometimes wraps this way)
 */
function extractText(part: TextPart): string {
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.text === 'object' && part.text !== null) {
    if (typeof (part.text as any).text === 'string') {
      return (part.text as any).text;
    }
    // Last resort: stringify (should not normally happen)
    return JSON.stringify(part.text);
  }
  return '';
}

// ── Tool executor ──────────────────────────────────────────────────────────────
// [NEW] Handles both GA4 API tools and the chart tool in one place.
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  accessToken: string,
): Promise<string> {
  if (name === 'create_chart') {
    const result = await createChart(args as unknown as CreateChartInput);
    // Prefer the permanent ImgBB URL; fall back to the QuickChart short URL.
    const displayUrl = result.permanentUrl ?? result.shortUrl;
    console.log('[ImgBB] displayUrl selected:', displayUrl);
    console.log('[ImgBB] permanentUrl:', result.permanentUrl ?? 'not available — ImgBB upload may have failed');
    return JSON.stringify({
      imageUrl: result.imageUrl,
      shortUrl: result.shortUrl,
      permanentUrl: result.permanentUrl,
      // Use the permanent URL in renderHint so stored messages stay valid long-term.
      renderHint: `Embed the chart with: ![chart](${displayUrl})`,
    });
  }
  // All other tools go to the existing GA4 executor.
  return executeGA4Function(name, args, accessToken);
}

// ── Main chat function ─────────────────────────────────────────────────────────
export async function runGA4Chat(
  geminiAi: GoogleGenAI,
  conversationHistory: Content[],
  question: string,
  ga4PropertyId: string,
  db: D1Database,
  userId: string,
  env: Env,
): Promise<GA4ChatResult> {
  if (ga4PropertyId) validatePropertyId(ga4PropertyId);

  const currentInstruction = ga4PropertyId
    ? `${GA4_SYSTEM_INSTRUCTION}\n\nThe user has currently selected GA4 Property ID: ${ga4PropertyId}. Use this property ID by default for all queries unless the user specifies otherwise.`
    : GA4_SYSTEM_INSTRUCTION;

  const contents: Content[] = [
    ...conversationHistory,
    { role: 'user', parts: [{ text: question }] },
  ];

  const MAX_TOOL_TURNS = 20;

  // [NEW] Collect every chart URL produced this turn.
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

    console.log(`[GA4] Turn ${turn + 1}/${MAX_TOOL_TURNS} — sending ${contents.length} content items`);

    const response = await geminiAi.models.generateContent({
      model: GEMINI_MODEL,
      contents: contents as any,
      config: {
        systemInstruction: currentInstruction,
        // [CHANGED] Use ALL_FUNCTION_DECLARATIONS (GA4 + chart).
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
      .filter((p): p is FunctionCallPart => 'functionCall' in p)
      .map((p) => p.functionCall);

    // Use robust extraction for every text part
    const textParts = parts
      .filter((p): p is TextPart => 'text' in p)
      .map(extractText)
      .join('');

    if (functionCalls.length > 0) {
      console.log(
        `[GA4] Turn ${turn + 1} — calling: ${functionCalls.map((f) => f.name).join(', ')}`,
      );

      contents.push({ role: 'model', parts });

      const functionResponses: FunctionResponsePart[] = [];

      for (const fc of functionCalls) {
        let resultStr: string;
        try {
          resultStr = await executeTool(
            fc.name,
            (fc.args ?? {}) as Record<string, unknown>,
            accessToken,
          );

          // Collect the best available chart URL (permanent ImgBB > short > long).
          if (fc.name === 'create_chart') {
            try {
              const parsed = JSON.parse(resultStr) as { permanentUrl?: string; shortUrl?: string; imageUrl?: string };
              const url = parsed.permanentUrl ?? parsed.shortUrl ?? parsed.imageUrl;
              if (url) chartUrls.push(url);
            } catch { /* ignore parse errors */ }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[GA4] Tool "${fc.name}" failed: ${message}`);
          resultStr = JSON.stringify({ error: message });
        }

        functionResponses.push({
          functionResponse: {
            name: fc.name,
            response: { name: fc.name, content: resultStr },
          },
        });
      }

      contents.push({ role: 'user', parts: functionResponses });
    } else {
      console.log(`[GA4] Completed in ${turn + 1} turn(s).`);

      // Ensure answer is always a plain string
      const finalAnswer = typeof textParts === 'string' ? textParts : String(textParts);

      return {
        answer: finalAnswer,
        updatedHistory: contents,
        charts: chartUrls,   // [NEW]
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
    `Last functions called: ${lastFunctions}. ` +
    `This may indicate a tool-call loop — check your function declarations for ambiguous routing.`,
  );
}