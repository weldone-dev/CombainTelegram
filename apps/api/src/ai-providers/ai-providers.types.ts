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

/** Dashboard view of one provider. The API key is never included. */
export interface AiProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  models: string[];
  defaultModel: string | null;
  reasoningEffort: ReasoningEffort;
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
}

export interface AiProviderCreateInput {
  name?: unknown;
  kind?: unknown;
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
