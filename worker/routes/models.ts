// routes/models.ts
// ── Models route handler: /api/models (Google Gemini only) ────────────────────

import { Env, AuthUser } from '../types';
import { json } from '../utils/http';
import { createGeminiClient } from '../utils/genai-client';

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  icon: 'sparkles' | 'zap' | 'cpu' | 'brain';
  badge?: string;
}

const MODELS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let cachedModels: { items: ModelOption[]; expiresAt: number } | null = null;

const GEMINI_DEFAULT_MODELS: ModelOption[] = [
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    description: 'Ultra-fast and lightweight',
    icon: 'zap',
    badge: 'Recommended',
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    description: 'Deep reasoning and complex tasks',
    icon: 'brain',
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    description: 'Cost-efficient high-throughput model',
    icon: 'cpu',
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    description: 'Fast and responsive',
    icon: 'sparkles',
  },
];

function mapGeminiModel(nameOrId: string): ModelOption {
  let id = nameOrId;
  if (id.startsWith('publishers/google/models/')) {
    id = id.substring('publishers/google/models/'.length);
  } else if (id.startsWith('models/')) {
    id = id.substring('models/'.length);
  }

  const curated = GEMINI_DEFAULT_MODELS.find((m) => m.id === id);
  if (curated) {
    return { ...curated, id };
  }

  let name = id;
  let description = 'Google Gemini model';
  let icon: 'zap' | 'brain' | 'cpu' | 'sparkles' = 'sparkles';
  let badge: string | undefined;

  const lower = id.toLowerCase();
  const ver = id.match(/\d+(?:\.\d+)?/)?.[0] || '';

  if (lower.includes('flash-lite') || lower.includes('lite')) {
    name = `Gemini ${ver} Flash-Lite`.replace(/\s+/g, ' ').trim();
    description = 'Cost-efficient high-throughput model';
    icon = 'cpu';
  } else if (lower.includes('flash')) {
    name = `Gemini ${ver} Flash`.replace(/\s+/g, ' ').trim();
    description = 'Ultra-fast and lightweight';
    icon = 'zap';
    if (lower.includes('2.5')) badge = 'Recommended';
    else if (/gemini-[34]/.test(lower)) badge = 'New';
  } else if (lower.includes('pro')) {
    name = `Gemini ${ver} Pro`.replace(/\s+/g, ' ').trim();
    description = 'Deep reasoning and complex tasks';
    icon = 'brain';
    if (/gemini-[34]/.test(lower)) badge = 'New';
  } else if (lower.includes('ultra')) {
    name = `Gemini ${ver} Ultra`.replace(/\s+/g, ' ').trim();
    description = 'Most capable model for highly complex tasks';
    icon = 'brain';
  } else {
    name = id
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  return { id, name, description, icon, badge };
}

export async function handleModels(
  request: Request,
  env: Env,
  _url: URL,
  _parts: string[],
  _currentUser: AuthUser,
): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  const now = Date.now();
  if (cachedModels && now < cachedModels.expiresAt) {
    return json({ gemini: cachedModels.items });
  }

  let geminiModels: ModelOption[] = GEMINI_DEFAULT_MODELS.map((m) => ({ ...m }));

  try {
    const geminiAi = createGeminiClient(env);
    const models = await geminiAi.models.list();
    const seen = new Set<string>();
    const list: ModelOption[] = [];
    for await (const m of models) {
      const lower = m.name.toLowerCase();
      const isChat =
        lower.includes('gemini') &&
        !lower.includes('embedding') &&
        !lower.includes('-tts') &&
        !lower.includes('-image');
      if (isChat) {
        const mapped = mapGeminiModel(m.name);
        if (!seen.has(mapped.id)) {
          seen.add(mapped.id);
          list.push(mapped);
        }
      }
    }
    if (list.length > 0) {
      geminiModels = list;
    }
  } catch (err: any) {
    console.warn('[Models API] Failed to fetch Gemini models, using fallback list:', err?.message ?? err);
  }

  // Ensure default models are present without mutating GEMINI_DEFAULT_MODELS
  for (const def of GEMINI_DEFAULT_MODELS) {
    if (!geminiModels.some((m) => m.id === def.id)) {
      geminiModels.push({ ...def });
    }
  }

  cachedModels = {
    items: geminiModels,
    expiresAt: now + MODELS_CACHE_TTL_MS,
  };

  return json({ gemini: geminiModels });
}
