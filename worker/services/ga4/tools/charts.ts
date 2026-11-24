// ── Chart tool ─────────────────────────────────────────────────────────────────
// Renders Chart.js v4 charts via QuickChart.io and stores PNGs privately in
// CHAT_FILES (R2/GCS) with authenticated `/api/files/:id` URLs, falling back to
// ImgBB (if configured) or QuickChart shortUrl when private storage isn't passed.

import { Env } from '../../../types';

const QUICKCHART = 'https://quickchart.io';
const IMGBB_UPLOAD = 'https://api.imgbb.com/1/upload';

// ── Colour palette (auto-applied when caller omits colours) ───────────────────
const PALETTE = [
  '#4F8EF7', '#F76B4F', '#4FF79A', '#F7D44F',
  '#B04FF7', '#4FD7F7', '#F74FA0', '#7AF74F',
];

// ── Types ──────────────────────────────────────────────────────────────────────
export interface ChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string | string[];
  borderColor?: string;
  fill?: boolean;
  tension?: number;
}

export interface CreateChartInput {
  /** Chart variety. Use 'horizontalBar' for long category labels. */
  type: 'bar' | 'horizontalBar' | 'line' | 'pie' | 'doughnut' | 'radar';
  title: string;
  /** X-axis labels — must align 1-to-1 with each dataset's data array. */
  labels: string[];
  datasets: ChartDataset[];
  width?: number;
  height?: number;
  xAxisLabel?: string;
  yAxisLabel?: string;
}

export interface ChartStorageContext {
  env?: Env;
  db?: D1Database;
  userId?: string;
  sessionId?: string;
}

export interface ChartResult {
  /** QuickChart long-form URL (v4) */
  imageUrl: string;
  /** QuickChart short URL (v4, 3-day retention) */
  shortUrl: string;
  /** Permanent URL — private `/api/files/:id` (preferred) or ImgBB fallback */
  permanentUrl?: string;
}

// ── Colour assignment ──────────────────────────────────────────────────────────
function withColours(datasets: ChartDataset[], type: CreateChartInput['type']): ChartDataset[] {
  const isPie = type === 'pie' || type === 'doughnut';
  return datasets.map((ds, i) => {
    const base = PALETTE[i % PALETTE.length];
    return {
      ...ds,
      backgroundColor:
        ds.backgroundColor ??
        (isPie
          ? ds.data.map((_, j) => PALETTE[j % PALETTE.length])
          : `${base}CC`),
      borderColor: ds.borderColor ?? base,
      tension: ds.tension ?? (type === 'line' ? 0.3 : undefined),
      fill: ds.fill ?? (type === 'line' ? false : undefined),
    };
  });
}

// ── Chart.js v4 config ─────────────────────────────────────────────────────────
export function buildChartConfig(input: CreateChartInput): object {
  const datasets = withColours(input.datasets, input.type);
  const isFlat = input.type === 'pie' || input.type === 'doughnut' || input.type === 'radar';
  const isHoriz = input.type === 'horizontalBar';

  return {
    type: isHoriz ? 'bar' : input.type,
    data: { labels: input.labels, datasets },
    options: {
      indexAxis: isHoriz ? 'y' : 'x',
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: input.title,
          font: { size: 16, weight: 'bold' },
          padding: { bottom: 12 },
        },
        legend: { display: datasets.length > 1 || isFlat },
      },
      ...(!isFlat && {
        scales: {
          x: {
            beginAtZero: isHoriz,
            title: input.xAxisLabel ? { display: true, text: input.xAxisLabel } : undefined,
          },
          y: {
            beginAtZero: !isHoriz,
            title: input.yAxisLabel ? { display: true, text: input.yAxisLabel } : undefined,
          },
        },
      }),
    },
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── Render PNG via QuickChart POST API (avoids GET URL length limits) ─────────
async function renderChartPng(config: object, width: number, height: number): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(`${QUICKCHART}/chart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chart: config,
        width,
        height,
        backgroundColor: 'white',
        version: '4',
        format: 'png',
      }),
    });
    if (!res.ok) {
      console.error('[Chart] QuickChart render failed:', res.status);
      return null;
    }
    const buffer = await res.arrayBuffer();
    return buffer.byteLength > 0 ? buffer : null;
  } catch (err) {
    console.error('[Chart] Exception rendering QuickChart PNG:', err);
    return null;
  }
}

async function storeChartInPrivateStorage(
  pngBytes: ArrayBuffer,
  title: string,
  ctx: Required<ChartStorageContext>,
): Promise<string | undefined> {
  try {
    const bucket = ctx.env.CHAT_FILES;
    if (!bucket) return undefined;

    const id = `chart-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const safeTitle = (title || 'chart').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'chart';
    const filename = `${safeTitle}.png`;
    const safeSession = ctx.sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const r2Key = `${ctx.userId}/${safeSession}/charts/${id}.png`;
    const now = Date.now();

    await bucket.put(r2Key, pngBytes, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { originalName: filename, userId: ctx.userId },
    });

    try {
      await ctx.db
        .prepare(
          'INSERT INTO attachments (id, session_id, user_id, filename, mime_type, size, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, ctx.sessionId, ctx.userId, filename, 'image/png', pngBytes.byteLength, r2Key, now)
        .run();
    } catch (dbErr) {
      await bucket.delete(r2Key).catch(() => {});
      throw dbErr;
    }

    return `/api/files/${id}`;
  } catch (err) {
    console.error('[Chart] Private chart storage failed:', err);
    return undefined;
  }
}

async function uploadToImgbb(pngBytes: ArrayBuffer, apiKey: string): Promise<string | undefined> {
  try {
    const form = new FormData();
    form.append('key', apiKey);
    form.append('image', arrayBufferToBase64(pngBytes));

    const res = await fetch(IMGBB_UPLOAD, { method: 'POST', body: form });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { success: boolean; data?: { url: string } };
    return json.success ? json.data?.url : undefined;
  } catch (err) {
    console.error('[Chart] ImgBB fallback upload failed:', err);
    return undefined;
  }
}

async function createQuickChartShortUrl(config: object, width: number, height: number): Promise<string | null> {
  try {
    const res = await fetch(`${QUICKCHART}/chart/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chart: config,
        width,
        height,
        backgroundColor: 'white',
        version: '4',
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { success: boolean; url?: string };
    return json.success && json.url ? json.url : null;
  } catch {
    return null;
  }
}

// ── Main function ──────────────────────────────────────────────────────────────
export async function createChart(
  input: CreateChartInput,
  ctx?: ChartStorageContext,
): Promise<ChartResult> {
  const config = buildChartConfig(input);
  const w = input.width ?? 800;
  const h = input.height ?? 420;
  const encoded = encodeURIComponent(JSON.stringify(config));
  const imageUrl = `${QUICKCHART}/chart?c=${encoded}&w=${w}&h=${h}&bkg=white&v=4`;

  let permanentUrl: string | undefined;
  const pngBytes = await renderChartPng(config, w, h);

  if (pngBytes) {
    if (ctx?.env?.CHAT_FILES && ctx.db && ctx.userId && ctx.sessionId) {
      permanentUrl = await storeChartInPrivateStorage(pngBytes, input.title, {
        env: ctx.env,
        db: ctx.db,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      });
    }

    if (!permanentUrl && ctx?.env?.IMG_BB_API_KEY) {
      permanentUrl = await uploadToImgbb(pngBytes, ctx.env.IMG_BB_API_KEY);
    }
  }

  // Only request a QuickChart short URL when we don't already have a permanent one
  const shortUrl = permanentUrl ? imageUrl : ((await createQuickChartShortUrl(config, w, h)) ?? imageUrl);

  return {
    imageUrl,
    shortUrl,
    ...(permanentUrl ? { permanentUrl } : {}),
  };
}

// ── Gemini tool definition (no internal secrets exposed to LLM) ────────────────
export const CREATE_CHART_DECLARATION = {
  name: 'create_chart',
  description:
    'Renders a chart image from data and returns an image URL. ' +
    'Always call this AFTER fetching data with run_report / run_realtime_report. ' +
    'Prefer charts when presenting trends, comparisons, or funnels to stakeholders.',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['bar', 'horizontalBar', 'line', 'pie', 'doughnut', 'radar'],
        description:
          'bar=vertical bars, horizontalBar=horizontal (best for long labels), ' +
          'line=trend over time, pie/doughnut=part-of-whole, radar=multi-axis.',
      },
      title: { type: 'string' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Category or date labels. Must align 1-to-1 with each dataset data array.',
      },
      datasets: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'data'],
          properties: {
            label: { type: 'string' },
            data: { type: 'array', items: { type: 'number' } },
          },
        },
      },
      width: { type: 'number', description: 'Image width px. Default 800.' },
      height: { type: 'number', description: 'Image height px. Default 420.' },
      xAxisLabel: { type: 'string' },
      yAxisLabel: { type: 'string' },
    },
    required: ['type', 'title', 'labels', 'datasets'],
  },
};
