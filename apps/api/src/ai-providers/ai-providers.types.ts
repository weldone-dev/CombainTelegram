import type { ReasoningEffort } from '../ai/ai.types.js';

/** Where the effective LLM configuration came from. */
export type AiProviderSource = 'provider' | 'settings' | 'env';

/**
 * Effective LLM configuration used for a request.
 *
 * Precedence: the default enabled `AiProvider` row, then the legacy
 * `AiSetting` single-provider fields, then the `AI_*` environment variables.
 */
export interface ResolvedProvider {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  reasoningEffort: ReasoningEffort;
  /** Parsed `AI_EXTRA_HEADERS`, forwarded with every chat request. */
  extraHeaders: Record<string, string>;
  source: AiProviderSource;
}

/** Where a provider gets its key from when no key is stored on the row. */
export type AiProviderKeySource = 'stored' | 'opencode' | 'env';

/** A ready-made provider configuration the dashboard can create in one click. */
export interface AiProviderPreset {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  /** `opencode` = Orca's OpenCode Go token, so no key is stored on the row. */
  keySource: AiProviderKeySource;
  defaultModel?: string;
  description?: string;
  docsUrl?: string;
}

/** Per-provider request limits. `0`/absent means unlimited. */
export interface AiProviderLimits {
  maxPerHour?: number;
  maxPerDay?: number;
}

/** Local AgentRun counters, independent of what the remote provider reports. */
export interface AiProviderObservedUsage {
  lastHour: number;
  lastDay: number;
}

/** One provider-side quota meter (OpenCode Go: 5-hour / weekly / monthly). */
export interface AiProviderUsageMeter {
  /** `ok` or `rate-limited`. */
  status: string;
  /** Whole percent of the limit used, 0–100. */
  percent: number;
  /** ISO instant when the meter resets, when the provider says so. */
  resetsAt: string | null;
}

export interface AiProviderUsage {
  rolling?: AiProviderUsageMeter;
  weekly?: AiProviderUsageMeter;
  monthly?: AiProviderUsageMeter;
}

/**
 * What `GET /ai/providers/:id/limits` reports.
 *
 * `source: 'provider'` means the provider answered a real usage/quota call;
 * `manual` means only the stored limits and local counters are known.
 */
export interface AiProviderLimitsView {
  source: 'provider' | 'manual';
  limits: AiProviderLimits;
  observed?: AiProviderObservedUsage;
  usage?: AiProviderUsage;
  /** Why the provider quota could not be read; never contains a key. */
  error?: string;
  checkedAt: string;
}

export interface AiProviderLimitsUpdateResult {
  limits: AiProviderLimits;
}

/** `PATCH /ai/providers/:id/limits` body; `null` clears a value. */
export interface AiProviderLimitsInput {
  maxPerHour?: unknown;
  maxPerDay?: unknown;
}

/** One model as offered by a provider (dashboard list entry). */
export interface AiProviderModelInfo {
  id: string;
  label?: string;
  /** Provider-declared type when present: `chat`, `embedding`, `decision`, … */
  type?: string;
}

/**
 * `GET /ai/providers/:id/models`.
 *
 * `provider` = fetched live from `<baseUrl>/models`; `stored` = the last list
 * saved on the row (`AiProvider.models`), used when the fetch fails.
 */
export interface AiProviderModelsView {
  models: AiProviderModelInfo[];
  source: 'provider' | 'stored';
  /** True when the answer came from the in-memory 5-minute cache. */
  cached?: boolean;
  /** ISO instant of the successful fetch. */
  fetchedAt?: string;
  error?: string;
}

/** `PUT /ai/providers/:id/models` body: the list the dashboard chose. */
export interface AiProviderModelsInput {
  models?: unknown;
  defaultModel?: unknown;
}

/** Dashboard view of one provider. The API key is never included. */
export interface AiProviderView {
  id: string;
  name: string;
  kind: string;
  /** Known preset the row was created from (`opencode-go`), null = custom. */
  preset: string | null;
  keySource: AiProviderKeySource;
  baseUrl: string;
  models: string[];
  defaultModel: string | null;
  reasoningEffort: ReasoningEffort;
  limits: AiProviderLimits;
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
}

export interface AiProviderCreateInput {
  name?: unknown;
  kind?: unknown;
  preset?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
  defaultModel?: unknown;
  reasoningEffort?: unknown;
  isDefault?: unknown;
  enabled?: unknown;
}

export type AiProviderUpdateInput = AiProviderCreateInput;

export interface AiProviderDeleteResult {
  removed: boolean;
  /** Provider promoted to default after deleting the previous default. */
  promotedId: string | null;
}

export interface AiProviderTestResult {
  ok: boolean;
  /** HTTP status when the provider answered; null on a transport error. */
  status: number | null;
  latencyMs: number;
  /** Human-readable failure reason; never contains the API key. */
  error?: string;
}

export interface AiProviderImportResult {
  /** True when a provider row was created from the current `AiSetting`. */
  created: boolean;
}
