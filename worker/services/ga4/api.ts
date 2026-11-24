// ── GA4 REST API helpers & function execution for Gemini tool-calling ─────────

export const GA4_ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
export const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

const FILTER_EXPRESSION_SCHEMA = {
  type: 'object',
  description: 'GA4 FilterExpression object (filter, andGroup, orGroup, or notExpression)',
  properties: {
    filter: {
      type: 'object',
      description: 'Single field filter',
      properties: {
        fieldName: { type: 'string' },
        stringFilter: {
          type: 'object',
          properties: {
            matchType: { type: 'string' },
            value: { type: 'string' },
            caseSensitive: { type: 'boolean' },
          },
        },
        numericFilter: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            value: {
              type: 'object',
              properties: {
                int64Value: { type: 'string' },
                doubleValue: { type: 'number' },
              },
            },
          },
        },
        inListFilter: {
          type: 'object',
          properties: {
            values: { type: 'array', items: { type: 'string' } },
            caseSensitive: { type: 'boolean' },
          },
        },
      },
    },
    andGroup: {
      type: 'object',
      properties: {
        expressions: { type: 'array', items: { type: 'object', properties: { filter: { type: 'object', properties: { fieldName: { type: 'string' } } } } } },
      },
    },
    orGroup: {
      type: 'object',
      properties: {
        expressions: { type: 'array', items: { type: 'object', properties: { filter: { type: 'object', properties: { fieldName: { type: 'string' } } } } } },
      },
    },
    notExpression: {
      type: 'object',
      properties: {
        filter: { type: 'object', properties: { fieldName: { type: 'string' } } },
      },
    },
  },
};

const ORDER_BY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    desc: { type: 'boolean' },
    metric: {
      type: 'object',
      properties: { metricName: { type: 'string' } },
    },
    dimension: {
      type: 'object',
      properties: {
        dimensionName: { type: 'string' },
        orderType: { type: 'string' },
      },
    },
  },
};

export const GA4_TOOL_DEFINITIONS: any[] = [
  {
    name: 'get_account_summaries',
    description: "Retrieves information about the user's Google Analytics accounts and properties.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_property_details',
    description: 'Returns details about a specific GA4 property.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: 'The GA4 property ID (numeric)' },
      },
      required: ['property_id'],
    },
  },
  {
    name: 'list_google_ads_links',
    description: 'Returns a list of Google Ads account links for a GA4 property.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: 'The GA4 property ID (numeric)' },
      },
      required: ['property_id'],
    },
  },
  {
    name: 'run_report',
    description:
      "Runs a GA4 Data API report. Common dimensions: 'date','eventName','pageTitle','pagePath','country','deviceCategory','sessionSource','sessionMedium'. Common metrics: 'activeUsers','totalUsers','sessions','screenPageViews','eventCount','bounceRate'. Omit dimensions for aggregate totals.",
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: 'The GA4 property ID (numeric)' },
        date_ranges: {
          type: 'array',
          description: 'Date ranges (e.g. [{ startDate: "28daysAgo", endDate: "today" }])',
          items: {
            type: 'object',
            properties: {
              startDate: { type: 'string', description: 'YYYY-MM-DD, today, yesterday, or NdaysAgo' },
              endDate: { type: 'string', description: 'YYYY-MM-DD, today, yesterday, or NdaysAgo' },
              name: { type: 'string', description: 'Optional name for comparing multiple ranges' },
            },
            required: ['startDate', 'endDate'],
          },
        },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional dimension names',
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metric names',
        },
        dimension_filter: FILTER_EXPRESSION_SCHEMA,
        metric_filter: FILTER_EXPRESSION_SCHEMA,
        order_bys: {
          type: 'array',
          items: ORDER_BY_ITEM_SCHEMA,
          description: 'Sort specifications',
        },
        limit: { type: 'number', description: 'Max rows' },
        offset: { type: 'number', description: 'Row offset' },
        currency_code: { type: 'string', description: 'Currency code' },
      },
      required: ['property_id', 'date_ranges', 'metrics'],
    },
  },
  {
    name: 'run_realtime_report',
    description: 'Runs a realtime report for the last 30 minutes.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: 'The GA4 property ID (numeric)' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Optional dimension names' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Metric names' },
        dimension_filter: FILTER_EXPRESSION_SCHEMA,
        metric_filter: FILTER_EXPRESSION_SCHEMA,
        order_bys: { type: 'array', items: ORDER_BY_ITEM_SCHEMA },
        limit: { type: 'number' },
      },
      required: ['property_id', 'metrics'],
    },
  },
  {
    name: 'run_funnel_report',
    description:
      'Runs a funnel report. The "steps" array defines the funnel stages in order. Each step needs a "name" and a "filterExpression" with event or dimension filters.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: 'The GA4 property ID (numeric)' },
        date_ranges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startDate: { type: 'string' },
              endDate: { type: 'string' },
            },
            required: ['startDate', 'endDate'],
          },
        },
        steps: {
          type: 'array',
          description: 'Funnel steps array. Each step has a "name" and "filterExpression".',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              isDirectlyFollowedBy: { type: 'boolean' },
              filterExpression: FILTER_EXPRESSION_SCHEMA,
            },
            required: ['name', 'filterExpression'],
          },
        },
        is_open_funnel: {
          type: 'boolean',
          description: 'If true, users can enter at any step. If false (default), users must complete steps in order.',
        },
        funnel_visualization_type: { type: 'string' },
      },
      required: ['property_id', 'steps'],
    },
  },
  {
    name: 'get_custom_dimensions_and_metrics',
    description: 'Retrieves custom dimensions and metrics for a property.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: 'The GA4 property ID (numeric)' },
      },
      required: ['property_id'],
    },
  },
];

// ── REST helpers ──────────────────────────────────────────────────────────────

async function parseGa4Error(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      return `GA4 API error ${res.status}: ${parsed.error.message.slice(0, 800)}`;
    }
  } catch {
    /* non-JSON body */
  }
  return `GA4 API error ${res.status}: ${raw.slice(0, 800)}`;
}

export async function ga4RestGet(accessToken: string, url: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(await parseGa4Error(res));
  return res.json();
}

export async function ga4RestPost(accessToken: string, url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseGa4Error(res));
  return res.json();
}

export function cleanPropertyId(id: string): string {
  return id.replace(/^properties\//, '');
}

export function assertNumericPropertyId(raw: unknown): string {
  const pid = cleanPropertyId(String(raw ?? '').trim());
  if (!/^\d+$/.test(pid)) {
    throw new Error(`Invalid GA4 property ID: "${pid}". Expected a numeric string.`);
  }
  return pid;
}

// ── Function execution (called by Gemini tool loop) ───────────────────────────

export async function executeGA4Function(
  name: string,
  args: Record<string, unknown>,
  accessToken: string,
): Promise<string> {
  try {
    switch (name) {
      case 'get_account_summaries':
        return JSON.stringify(await ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/accountSummaries`));

      case 'get_property_details': {
        const pid = assertNumericPropertyId(args.property_id);
        return JSON.stringify(await ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}`));
      }

      case 'list_google_ads_links': {
        const pid = assertNumericPropertyId(args.property_id);
        return JSON.stringify(
          await ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}/googleAdsLinks`),
        );
      }

      case 'run_report': {
        const pid = assertNumericPropertyId(args.property_id);
        const dims = Array.isArray(args.dimensions) ? (args.dimensions as string[]) : [];
        const metrics = Array.isArray(args.metrics) ? (args.metrics as string[]) : [];
        const rb: Record<string, unknown> = {
          dateRanges: args.date_ranges,
          metrics: metrics.map((m) => ({ name: m })),
        };
        if (dims.length > 0) rb.dimensions = dims.map((d) => ({ name: d }));
        if (args.dimension_filter) rb.dimensionFilter = args.dimension_filter;
        if (args.metric_filter) rb.metricFilter = args.metric_filter;
        if (args.order_bys) rb.orderBys = args.order_bys;
        if (args.limit != null) rb.limit = args.limit;
        if (args.offset != null) rb.offset = args.offset;
        if (args.currency_code) rb.currencyCode = args.currency_code;
        return JSON.stringify(
          await ga4RestPost(accessToken, `${GA4_DATA_API_BASE}/properties/${pid}:runReport`, rb),
        );
      }

      case 'run_realtime_report': {
        const pid = assertNumericPropertyId(args.property_id);
        const dims = Array.isArray(args.dimensions) ? (args.dimensions as string[]) : [];
        const metrics = Array.isArray(args.metrics) ? (args.metrics as string[]) : [];
        const rb: Record<string, unknown> = {
          metrics: metrics.map((m) => ({ name: m })),
        };
        if (dims.length > 0) rb.dimensions = dims.map((d) => ({ name: d }));
        if (args.dimension_filter) rb.dimensionFilter = args.dimension_filter;
        if (args.metric_filter) rb.metricFilter = args.metric_filter;
        if (args.order_bys) rb.orderBys = args.order_bys;
        if (args.limit != null) rb.limit = args.limit;
        return JSON.stringify(
          await ga4RestPost(accessToken, `${GA4_DATA_API_BASE}/properties/${pid}:runRealtimeReport`, rb),
        );
      }

      case 'run_funnel_report': {
        const pid = assertNumericPropertyId(args.property_id);
        const funnel: Record<string, unknown> = { steps: args.steps };
        if (args.is_open_funnel != null) funnel.isOpenFunnel = args.is_open_funnel;
        const rb: Record<string, unknown> = { funnel };
        if (args.date_ranges) rb.dateRanges = args.date_ranges;
        if (args.funnel_visualization_type) rb.funnelVisualizationType = args.funnel_visualization_type;
        return JSON.stringify(
          await ga4RestPost(
            accessToken,
            `https://analyticsdata.googleapis.com/v1alpha/properties/${pid}:runFunnelReport`,
            rb,
          ),
        );
      }

      case 'get_custom_dimensions_and_metrics': {
        const pid = assertNumericPropertyId(args.property_id);
        const [dims, metrics] = await Promise.all([
          ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}/customDimensions`),
          ga4RestGet(accessToken, `${GA4_ADMIN_API_BASE}/properties/${pid}/customMetrics`),
        ]);
        return JSON.stringify({ customDimensions: dims, customMetrics: metrics });
      }

      default:
        return JSON.stringify({ error: `Unknown function: ${name}` });
    }
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'GA4 API call failed' });
  }
}
