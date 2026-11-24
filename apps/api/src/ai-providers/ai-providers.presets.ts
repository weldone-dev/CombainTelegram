import { apiError } from '../common/api-error.js';
import type {
  AiProviderKeySource,
  AiProviderLimits,
  AiProviderModelInfo,
  AiProviderPreset,
  AiProviderUsage,
  AiProviderUsageMeter,
} from './ai-providers.types.js';

/** OpenCode Go's OpenAI-compatible endpoint (documented in /console/go). */
export const OPENCODE_GO_BASE_URL =
  'https://opencode.ai/inference/go/openai/v1';

/** Not a real preset: it is what "create your own provider" resolves to. */
export const CUSTOM_PRESET_ID = 'custom';

/**
 * Built-in presets. `keySource: 'opencode'` means the row stores no key: the
 * token comes from Orca's OpenCode login (`AI_API_KEY_SOURCE=opencode`), which
 * is the same key the OpenCode Console shows for Go.
 */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    kind: 'openai-compatible',
    baseUrl: OPENCODE_GO_BASE_URL,
    keySource: 'opencode',
    defaultModel: 'deepseek-v4.1-flash',
    description:
      'OpenCode Go subscription. Uses the OpenCode token from this machine; the model list is fetched from the provider.',
    docsUrl: 'https://opencode.ai/docs/console/go/',
  },
  {
    id: CUSTOM_PRESET_ID,
    name: 'Custom provider',
    kind: 'openai-compatible',
    baseUrl: '',
    keySource: 'stored',
    description:
      'Any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, …) with its own base URL and API key.',
  },
];

const LIMIT_FIELDS = ['maxPerHour', 'maxPerDay'] as const;
const USAGE_METERS = ['rolling', 'weekly', 'monthly'] as const;

export function findPreset(id: string | null | undefined): AiProviderPreset | null {
  if (!id) return null;
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Validates the `preset` field of a create request. Returns null for "custom"
 * (absent, empty or `custom`); throws for an unknown preset id.
 */
export function requirePreset(value: unknown): AiProviderPreset | null {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id === CUSTOM_PRESET_ID) return null;
  const preset = findPreset(id);
  if (!preset) {
    throw apiError(
      'INVALID_PRESET',
      `Unknown AI provider preset: ${id}`,
      400,
      { details: { presets: AI_PROVIDER_PRESETS.map((item) => item.id) } },
    );
  }
  return preset;
}

/** Effective key source of a stored row: its preset decides, else `stored`. */
export function keySourceOf(preset: string | null | undefined): AiProviderKeySource {
  return findPreset(preset)?.keySource ?? 'stored';
}

/** Tolerant read for rows: junk fields are dropped, unknown values ignored. */
export function parseLimits(raw: unknown): AiProviderLimits {
  let source: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      source = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const record = source as Record<string, unknown>;
  const result: AiProviderLimits = {};
  for (const field of LIMIT_FIELDS) {
    const value = record[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      result[field] = value;
    }
  }
  return result;
}

function requireLimitValue(value: unknown, field: string): number | null {
  if (value === null) return null;
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw apiError(
      'INVALID_LIMIT',
      `${field} must be a non-negative integer (0 = unlimited)`,
      400,
    );
  }
  return number;
}

/**
 * Strict merge for `PATCH /ai/providers/:id/limits`: unknown fields are
 * ignored, `undefined` keeps the current value and `null` removes it.
 */
export function mergeLimits(
  current: AiProviderLimits,
  input: Record<string, unknown>,
): AiProviderLimits {
  const result: AiProviderLimits = { ...current };
  for (const field of LIMIT_FIELDS) {
    if (input[field] === undefined) continue;
    const value = requireLimitValue(input[field], field);
    if (value === null) {
      delete result[field];
    } else {
      result[field] = value;
    }
  }
  return result;
}

export function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/models') ? base : `${base}/models`;
}

/**
 * OpenCode Go's usage endpoint. Documented at
 * https://opencode.ai/docs/console/go/ ("Usage"), one meter per limit:
 * `https://opencode.ai/inference/go/v1/usage`. The chat base URL is a longer
 * path (`/inference/go/openai/v1`), so the origin + `/inference/go` prefix is
 * rebuilt instead of appended.
 */
export function opencodeUsageEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (!url.hostname.endsWith('opencode.ai')) return null;
    if (!url.pathname.includes('/inference/go')) return null;
    return `${url.origin}/inference/go/v1/usage`;
  } catch {
    return null;
  }
}

/** `{ data: [...] }`, `{ models: [...] }` or a bare array → model entries. */
export function parseModelsPayload(raw: unknown): AiProviderModelInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (() => {
          const record = raw as Record<string, unknown>;
          if (Array.isArray(record.data)) return record.data;
          if (Array.isArray(record.models)) return record.models;
          return [] as unknown[];
        })()
      : [];

  const seen = new Set<string>();
  const result: AiProviderModelInfo[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        result.push({ id });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const idValue =
      record.id ?? record.model ?? record.name ?? record.slug ?? record.value;
    if (typeof idValue !== 'string' || !idValue.trim()) continue;
    const id = idValue.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const entry: AiProviderModelInfo = { id };
    const label =
      typeof record.name === 'string'
        ? record.name
        : typeof record.display_name === 'string'
          ? record.display_name
          : typeof record.label === 'string'
            ? record.label
            : '';
    if (label.trim() && label.trim() !== id) entry.label = label.trim();
    if (typeof record.type === 'string' && record.type.trim()) {
      entry.type = record.type.trim();
    }
    result.push(entry);
  }
  return result;
}

function parseMeter(value: unknown): AiProviderUsageMeter | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const percent =
    typeof record.percent === 'number' && Number.isFinite(record.percent)
      ? Math.min(100, Math.max(0, Math.round(record.percent)))
      : null;
  if (percent === null) return null;
  return {
    status: typeof record.status === 'string' ? record.status : 'unknown',
    percent,
    resetsAt:
      typeof record.resetsAt === 'string' && record.resetsAt.trim()
        ? record.resetsAt.trim()
        : null,
  };
}

/** `{ usage: { rolling, weekly, monthly } }` → typed meters, null when empty. */
export function parseUsagePayload(raw: unknown): AiProviderUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const usage =
    record.usage && typeof record.usage === 'object'
      ? (record.usage as Record<string, unknown>)
      : record;
  const result: AiProviderUsage = {};
  for (const meter of USAGE_METERS) {
    const parsed = parseMeter(usage[meter]);
    if (parsed) result[meter] = parsed;
  }
  return Object.keys(result).length > 0 ? result : null;
}
