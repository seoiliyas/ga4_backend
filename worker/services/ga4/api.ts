// ── GA4 REST API helpers & function execution for Gemini tool-calling ─────────

export const GA4_ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
export const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

export const GA4_FUNCTION_DECLARATIONS: any[] = [
  { name: 'get_account_summaries', description: 'Retrieves information about the user\'s Google Analytics accounts and properties.' },
  { name: 'get_property_details', description: 'Returns details about a specific GA4 property.', parameters: { type: 'object', properties: { property_id: { type: 'string', description: 'The GA4 property ID (numeric)' } }, required: ['property_id'] } },
  { name: 'list_google_ads_links', description: 'Returns a list of Google Ads account links for a GA4 property.', parameters: { type: 'object', properties: { property_id: { type: 'string', description: 'The GA4 property ID (numeric)' } }, required: ['property_id'] } },
  { name: 'run_report', description: `Runs a GA4 Data API report. Common dimensions: 'date','eventName','pageTitle','pagePath','country','deviceCategory','sessionSource','sessionMedium'. Common metrics: 'activeUsers','totalUsers','sessions','screenPageViews','eventCount','bounceRate'.`, parameters: { type: 'object', properties: { property_id: { type: 'string', description: 'The GA4 property ID' }, date_ranges: { type: 'array', items: { type: 'object' }, description: 'Date ranges' }, dimensions: { type: 'array', items: { type: 'string' }, description: 'Dimension names' }, metrics: { type: 'array', items: { type: 'string' }, description: 'Metric names' }, dimension_filter: { type: 'object', description: 'Filter for dimensions' }, metric_filter: { type: 'object', description: 'Filter for metrics' }, order_bys: { type: 'array', items: { type: 'object' }, description: 'Sort specifications' }, limit: { type: 'number', description: 'Max rows' }, offset: { type: 'number', description: 'Row offset' }, currency_code: { type: 'string', description: 'Currency code' } }, required: ['property_id', 'date_ranges', 'dimensions', 'metrics'] } },
  { name: 'run_realtime_report', description: 'Runs a realtime report for the last 30 minutes.', parameters: { type: 'object', properties: { property_id: { type: 'string', description: 'The GA4 property ID' }, dimensions: { type: 'array', items: { type: 'string' } }, metrics: { type: 'array', items: { type: 'string' } }, dimension_filter: { type: 'object' }, metric_filter: { type: 'object' }, order_bys: { type: 'array', items: { type: 'object' } }, limit: { type: 'number' } }, required: ['property_id', 'dimensions', 'metrics'] } },
  { name: 'run_funnel_report', description: 'Runs a funnel report.', parameters: { type: 'object', properties: { property_id: { type: 'string', description: 'The GA4 property ID' }, date_ranges: { type: 'array', items: { type: 'object' } }, steps: { type: 'array', items: { type: 'object' }, description: 'Funnel steps' }, funnel_visualization_type: { type: 'string' } }, required: ['property_id', 'steps'] } },
  { name: 'get_custom_dimensions_and_metrics', description: 'Retrieves custom dimensions and metrics for a property.', parameters: { type: 'object', properties: { property_id: { type: 'string', description: 'The GA4 property ID' } }, required: ['property_id'] } },
];

// ── REST helpers ──────────────────────────────────────────────────────────────

export async function ga4RestGet(accessToken: string, url: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) { const e = await res.text(); throw new Error(`GA4 API error ${res.status}: ${e.slice(0, 200)}`); }
  return res.json();
}

export async function ga4RestPost(accessToken: string, url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.text(); throw new Error(`GA4 API error ${res.status}: ${e.slice(0, 200)}`); }
  return res.json();
}

export function cleanPropertyId(id: string): string { return id.replace(/^properties\//, ''); }

// ── Function execution (called by Gemini tool loop) ───────────────────────────

export async function executeGA4Function(name: string, args: Record<string, unknown>, accessToken: string): Promise<string> {
  try {
    switch (name) {
      case 'get_account_summaries': return JSON.stringify(await ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/accountSummaries`));
      case 'get_property_details': { const pid = cleanPropertyId(args.property_id as string); return JSON.stringify(await ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}`)); }
      case 'list_google_ads_links': { const pid = cleanPropertyId(args.property_id as string); return JSON.stringify(await ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}/googleAdsLinks`)); }
      case 'run_report': {
        const pid = cleanPropertyId(args.property_id as string);
        const rb: Record<string, unknown> = { dateRanges: args.date_ranges, dimensions: (args.dimensions as string[]).map((d: string) => ({ name: d })), metrics: (args.metrics as string[]).map((m: string) => ({ name: m })) };
        if (args.dimension_filter) rb.dimensionFilter = args.dimension_filter;
        if (args.metric_filter) rb.metricFilter = args.metric_filter;
        if (args.order_bys) rb.orderBys = args.order_bys;
        if (args.limit) rb.limit = args.limit;
        if (args.offset != null) rb.offset = args.offset;
        if (args.currency_code) rb.currencyCode = args.currency_code;
        return JSON.stringify(await ga4RestPost(accessToken, `${GA4_DATA_API_BASE}/properties/${pid}:runReport`, rb));
      }
      case 'run_realtime_report': {
        const pid = cleanPropertyId(args.property_id as string);
        const rb: Record<string, unknown> = { dimensions: (args.dimensions as string[]).map((d: string) => ({ name: d })), metrics: (args.metrics as string[]).map((m: string) => ({ name: m })) };
        if (args.dimension_filter) rb.dimensionFilter = args.dimension_filter;
        if (args.metric_filter) rb.metricFilter = args.metric_filter;
        if (args.order_bys) rb.orderBys = args.order_bys;
        if (args.limit) rb.limit = args.limit;
        return JSON.stringify(await ga4RestPost(accessToken, `${GA4_DATA_API_BASE}/properties/${pid}:runRealtimeReport`, rb));
      }
      case 'run_funnel_report': {
        const pid = cleanPropertyId(args.property_id as string);
        const rb: Record<string, unknown> = { steps: args.steps };
        if (args.date_ranges) rb.dateRanges = args.date_ranges;
        if (args.funnel_visualization_type) rb.funnelVisualizationType = args.funnel_visualization_type;
        return JSON.stringify(await ga4RestPost(accessToken, `https://analyticsdata.googleapis.com/v1alpha/properties/${pid}:runFunnelReport`, rb));
      }
      case 'get_custom_dimensions_and_metrics': {
        const pid = cleanPropertyId(args.property_id as string);
        const [dims, metrics] = await Promise.all([ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}/customDimensions`), ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}/customMetrics`)]);
        return JSON.stringify({ customDimensions: dims, customMetrics: metrics });
      }
      default: return JSON.stringify({ error: `Unknown function: ${name}` });
    }
  } catch (err: any) { return JSON.stringify({ error: err.message || 'GA4 API call failed' }); }
}
