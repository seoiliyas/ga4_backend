// ── HTTP helpers: origin-aware CORS & JSON response builder ───────────────────

export function parseAllowedOrigins(allowedOriginsEnv?: string): string[] {
  if (!allowedOriginsEnv) return [];
  return allowedOriginsEnv
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string, allowedOriginsEnv?: string): boolean {
  const allowed = parseAllowedOrigins(allowedOriginsEnv);
  if (allowed.length === 0 || allowed.includes('*')) return true;
  return allowed.includes(origin);
}

export function getCorsHeaders(
  request?: Request,
  allowedOriginsEnv?: string,
): Record<string, string> {
  const allowed = parseAllowedOrigins(allowedOriginsEnv);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-BrightHorizon-App',
  };

  if (allowed.length === 0 || allowed.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  const requestOrigin = request?.headers.get('Origin');
  if (requestOrigin && allowed.includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
    headers['Vary'] = 'Origin';
  }

  return headers;
}

export function applyCors(
  response: Response,
  request: Request,
  allowedOriginsEnv?: string,
): Response {
  const cors = getCorsHeaders(request, allowedOriginsEnv);
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) {
    if (k === 'Vary') {
      const existing = headers.get('Vary');
      if (!existing) {
        headers.set('Vary', v);
      } else if (!existing.split(',').map((s) => s.trim()).includes(v)) {
        headers.set('Vary', `${existing}, ${v}`);
      }
    } else {
      headers.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
