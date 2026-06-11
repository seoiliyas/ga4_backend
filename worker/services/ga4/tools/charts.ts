// ── Chart tool ─────────────────────────────────────────────────────────────────
// Renders Chart.js charts via QuickChart.io and optionally uploads them to ImgBB
// for permanent retention. Works in Cloudflare Workers / Node / Deno.

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
  /** Optional ImgBB configuration for permanent storage */
  imgbb?: {
    apiKey: string;                     // Your ImgBB API key (required)
    expiration?: number;                // Auto-delete after seconds (60-15552000)
    name?: string;                      // Custom file name (optional)
  };
}

export interface ChartResult {
  /** QuickChart long-form URL — always works (3-day retention) */
  imageUrl: string;
  /** QuickChart short URL — shorter, but also 3-day retention */
  shortUrl: string;
  /** ImgBB permanent image URL — present only if upload succeeded */
  permanentUrl?: string;
  /** ImgBB viewer page URL (optional) */
  permanentViewerUrl?: string;
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

// ── Chart.js config ────────────────────────────────────────────────────────────
function buildConfig(input: CreateChartInput): object {
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
            title: input.xAxisLabel ? { display: true, text: input.xAxisLabel } : undefined,
          },
          y: {
            beginAtZero: true,
            title: input.yAxisLabel ? { display: true, text: input.yAxisLabel } : undefined,
          },
        },
      }),
    },
  };
}

// ── Fetch raw image bytes from a URL and return as base64 ─────────────────────
async function fetchImageAsBase64(imageUrl: string): Promise<string | null> {
  console.log('[ImgBB] STEP 2 — Fetching raw image bytes from QuickChart...');
  console.log('[ImgBB]   URL:', imageUrl);
  try {
    const res = await fetch(imageUrl);
    console.log('[ImgBB]   QuickChart response status:', res.status, res.statusText);
    console.log('[ImgBB]   Content-Type:', res.headers.get('content-type'));

    if (!res.ok) {
      console.error('[ImgBB]   ✗ QuickChart fetch failed — non-OK status:', res.status);
      return null;
    }

    const buffer = await res.arrayBuffer();
    console.log('[ImgBB]   Raw bytes received:', buffer.byteLength, 'bytes');

    if (buffer.byteLength === 0) {
      console.error('[ImgBB]   ✗ QuickChart returned empty body — cannot encode');
      return null;
    }

    // Spreading a large Uint8Array as function args overflows the call stack.
    // Process in 8 KB chunks to stay safe at any image size.
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(binary);
    console.log('[ImgBB]   ✓ Base64 encoded successfully, length:', base64.length);
    return base64;
  } catch (err) {
    console.error('[ImgBB]   ✗ Exception while fetching image:', err);
    return null;
  }
}

// ── Upload image to ImgBB ──────────────────────────────────────────────────────
async function uploadToImgbb(
  base64Image: string,
  options: NonNullable<CreateChartInput['imgbb']>
): Promise<{ permanentUrl: string; viewerUrl: string } | null> {
  console.log('[ImgBB] STEP 3 — Uploading base64 image to ImgBB...');
  console.log('[ImgBB]   API key present:', !!options.apiKey);
  console.log('[ImgBB]   API key (first 6 chars):', options.apiKey?.slice(0, 6) + '...');
  console.log('[ImgBB]   base64 length being sent:', base64Image.length);
  console.log('[ImgBB]   expiration:', options.expiration ?? 'none');
  console.log('[ImgBB]   name:', options.name ?? 'none');

  try {
    const form = new FormData();
    form.append('key', options.apiKey);
    form.append('image', base64Image);
    if (options.name) form.append('name', options.name);
    if (options.expiration) form.append('expiration', options.expiration.toString());

    console.log('[ImgBB]   Sending POST to:', IMGBB_UPLOAD);
    const res = await fetch(IMGBB_UPLOAD, {
      method: 'POST',
      body: form,
    });

    console.log('[ImgBB]   ImgBB response status:', res.status, res.statusText);

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[ImgBB]   ✗ ImgBB HTTP error:', res.status, '— body:', errorText);
      return null;
    }

    const rawText = await res.text();
    console.log('[ImgBB]   Raw ImgBB response body:', rawText);

    let json: { success: boolean; data?: { url: string; url_viewer: string }; error?: any };
    try {
      json = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('[ImgBB]   ✗ Failed to parse ImgBB response as JSON:', parseErr);
      return null;
    }

    console.log('[ImgBB]   json.success:', json.success);

    if (!json.success) {
      console.error('[ImgBB]   ✗ ImgBB returned success=false. Error details:', json.error ?? 'none provided');
      return null;
    }

    if (!json.data?.url) {
      console.error('[ImgBB]   ✗ ImgBB success=true but data.url is missing. Full response:', json);
      return null;
    }

    console.log('[ImgBB]   ✓ Upload successful!');
    console.log('[ImgBB]   permanentUrl:', json.data.url);
    console.log('[ImgBB]   viewerUrl:', json.data.url_viewer);
    return {
      permanentUrl: json.data.url,
      viewerUrl: json.data.url_viewer,
    };
  } catch (err) {
    console.error('[ImgBB]   ✗ Exception during ImgBB upload:', err);
    return null;
  }
}

// ── Main function ──────────────────────────────────────────────────────────────
export async function createChart(input: CreateChartInput): Promise<ChartResult> {
  console.log('[ImgBB] ═══════════════════════════════════════════');
  console.log('[ImgBB] createChart() called — type:', input.type, '| title:', input.title);

  const config = buildConfig(input);
  const w = input.width ?? 800;
  const h = input.height ?? 420;
  const encoded = encodeURIComponent(JSON.stringify(config));

  const imageUrl = `${QUICKCHART}/chart?c=${encoded}&w=${w}&h=${h}&bkg=white&v=2`;
  console.log('[ImgBB] Long-form QuickChart URL built (length):', imageUrl.length);

  // QuickChart shortener
  let shortUrl = imageUrl;
  try {
    const res = await fetch(`${QUICKCHART}/chart/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chart: config, width: w, height: h,
        backgroundColor: 'white', version: '2',
      }),
    });
    if (res.ok) {
      const json = await res.json() as { success: boolean; url?: string };
      if (json.success && json.url) {
        shortUrl = json.url;
        console.log('[ImgBB] QuickChart short URL:', shortUrl);
      }
    }
  } catch {
    console.warn('[ImgBB] QuickChart shortener failed — falling back to long URL');
  }

  // ── ImgBB permanent upload ────────────────────────────────────────────────────
  let permanentResult: { permanentUrl: string; viewerUrl: string } | undefined;

  const apiKey =
    input.imgbb?.apiKey ??
    (typeof process !== 'undefined' ? process.env.IMG_BB_API_KEY : undefined) ??
    (globalThis as any).IMG_BB_API_KEY as string | undefined;

  console.log('[ImgBB] ───────────────────────────────────────────');
  console.log('[ImgBB] STEP 1 — Checking ImgBB config...');
  console.log('[ImgBB]   input.imgbb present:', !!input.imgbb);
  console.log('[ImgBB]   apiKey resolved:', !!apiKey);

  if (!apiKey) {
    console.warn('[ImgBB]   ✗ No API key found — skipping ImgBB upload.');
    console.warn('[ImgBB]     Provide it via input.imgbb.apiKey or globalThis.IMG_BB_API_KEY');
  } else {
    const base64 = await fetchImageAsBase64(imageUrl);

    if (!base64) {
      console.error('[ImgBB]   ✗ Could not get base64 image — skipping ImgBB upload');
    } else {
      const imgbbOptions = Object.assign({ apiKey }, input.imgbb);
      permanentResult = (await uploadToImgbb(base64, imgbbOptions)) ?? undefined;

      if (!permanentResult) {
        console.error('[ImgBB] ✗ ImgBB upload ultimately failed — returning QuickChart URLs only');
      }
    }
  }

  console.log('[ImgBB] ═══════════════════════════════════════════');

  return {
    imageUrl,
    shortUrl,
    ...(permanentResult
      ? {
        permanentUrl: permanentResult.permanentUrl,
        permanentViewerUrl: permanentResult.viewerUrl,
      }
      : {}),
  };
}

// ── Gemini function declaration ────────────────────────────────────────────────
export const CREATE_CHART_DECLARATION = {
  name: 'create_chart',
  description:
    'Renders a chart image from data and returns a public image URL. ' +
    'Always call this AFTER fetching data with run_report / run_realtime_report. ' +
    'Prefer charts when presenting trends, comparisons, or funnels to stakeholders. ' +
    'If an ImgBB API key is provided the chart will be uploaded for permanent storage.',
  parameters: {
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
      imgbb: {
        type: 'object',
        description: 'Optional configuration for permanently storing the chart via ImgBB.',
        properties: {
          apiKey: { type: 'string', description: 'Your ImgBB API key.' },
          expiration: { type: 'number', description: 'Seconds before auto-delete (60-15552000).' },
          name: { type: 'string', description: 'Custom file name for the upload.' },
        },
      },
    },
    required: ['type', 'title', 'labels', 'datasets'],
  },
};