import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { AiProviderModel, AiSettingModel } from '@repo/database';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { notFound } from '../common/api-error.js';
import { parseBoolean, requireString } from '../common/validation.js';
import { emitLog } from '../logs/log-sink.js';
import type { ReasoningEffort } from '../ai/ai.types.js';
import {
  AI_PROVIDER_PRESETS,
  keySourceOf,
  mergeLimits,
  modelsEndpoint,
  opencodeUsageEndpoint,
  parseLimits,
  parseModelsPayload,
  parseUsagePayload,
  requirePreset,
} from './ai-providers.presets.js';
import { readOpencodeToken } from './opencode-token.js';
import type {
  AiProviderCreateInput,
  AiProviderDeleteResult,
  AiProviderImportResult,
  AiProviderLimits,
  AiProviderLimitsInput,
  AiProviderLimitsUpdateResult,
  AiProviderLimitsView,
  AiProviderModelInfo,
  AiProviderModelsInput,
  AiProviderModelsView,
  AiProviderObservedUsage,
  AiProviderPreset,
  AiProviderTestResult,
  AiProviderUpdateInput,
  AiProviderView,
  ResolvedProvider,
} from './ai-providers.types.js';

const SETTINGS_ID = 'default';
/** AAD for the legacy `AiSetting.apiKey` envelope columns. */
const SETTINGS_KEY_AAD = 'ai:api-key';
/** Stored provider keys carry this prefix; legacy plain values still work. */
const SECRET_PREFIX = 'enc:v1:';
/** Short timeout: a provider test must never hang the dashboard. */
const TEST_TIMEOUT_MS = 8_000;
/** Model and usage calls to the provider; the dashboard waits for these. */
const PROVIDER_TIMEOUT_MS = 10_000;
/** A provider model list changes rarely: keep it for five minutes. */
const MODEL_CACHE_TTL_MS = 5 * 60_000;
/** Local counters reported next to the stored limits. */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const REASONING_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is string | number =>
          typeof item === 'string' || typeof item === 'number',
      )
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      return parseStringArray(JSON.parse(value));
    } catch {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = 'low',
): ReasoningEffort {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (REASONING_EFFORTS as string[]).includes(effort)
    ? (effort as ReasoningEffort)
    : fallback;
}

function normalizeBaseUrl(value: unknown): string {
  return requireString(value, 'baseUrl', { max: 500 }).replace(/\/+$/, '');
}

function extraHeaders(): Record<string, string> {
  const raw = process.env.AI_EXTRA_HEADERS;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function chatEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function errorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'The provider returned an empty answer';
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 300);
    if (typeof parsed.error?.message === 'string') {
      return parsed.error.message.slice(0, 300);
    }
    if (typeof parsed.message === 'string') return parsed.message.slice(0, 300);
  } catch {
    // Plain-text body: fall through to the raw preview.
  }
  return trimmed.slice(0, 300);
}

/**
 * CRUD for configurable OpenAI-compatible LLM providers plus the resolver that
 * every AI request goes through.
 *
 * Keys are encrypted with `SessionCryptoService` (AES-256-GCM envelope) and
 * stored as `enc:v1:<base64 envelope>` in `AiProvider.apiKey`. AAD binds the
 * blob to the provider id. Rows created before encryption (or by hand) keep a
 * plain value and are still readable, so the schema stays backwards
 * compatible.
 */
@Injectable()
export class AiProvidersService implements OnModuleInit {
  private readonly logger = new Logger(AiProvidersService.name);
  /** `<baseUrl>/models` answers, keyed by provider id (5 min TTL). */
  private readonly modelCache = new Map<
    string,
    { baseUrl: string; at: number; models: AiProviderModelInfo[] }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const { created } = await this.importSettings();
      if (created) {
        this.logger.log('Imported the current AI settings into the provider list');
      }
    } catch (error) {
      // A missing migration should not stop the API from booting.
      this.logger.warn(
        `Could not import AI settings into providers: ${(error as Error).message}`,
      );
    }
  }

  /** Default provider first, then oldest to newest. */
  async list(): Promise<AiProviderView[]> {
    const rows = (await this.prisma.aiProvider.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })) as AiProviderModel[];
    return rows.map((row) => this.view(row));
  }

  /** Presets the dashboard offers instead of a hand-filled provider form. */
  presets(): AiProviderPreset[] {
    return [...AI_PROVIDER_PRESETS];
  }

  async create(input: AiProviderCreateInput): Promise<AiProviderView> {
    const preset = requirePreset(input.preset);
    // A preset only fills defaults: name, base URL, kind and the model stay
    // overridable, exactly like a hand-created provider.
    const name = requireString(
      text(input.name) || (preset?.name ?? ''),
      'name',
      { max: 80 },
    );
    const baseUrl = normalizeBaseUrl(
      text(input.baseUrl) || (preset?.baseUrl ?? ''),
    );
    const kind = optionalText(input.kind) ?? preset?.kind ?? 'openai-compatible';
    const defaultModel =
      input.defaultModel === undefined
        ? (preset?.defaultModel ?? null)
        : optionalText(input.defaultModel);
    const models =
      input.models === undefined
        ? defaultModel
          ? [defaultModel]
          : []
        : parseStringArray(input.models);
    const reasoningEffort = parseReasoningEffort(input.reasoningEffort);
    const enabled =
      input.enabled === undefined ? true : parseBoolean(input.enabled, true);
    const wantsDefault =
      input.isDefault === undefined
        ? false
        : parseBoolean(input.isDefault, false);
    const id = randomUUID();
    // `opencode` presets draw the key from Orca's login: store nothing, even
    // when the dashboard still posts an apiKey field.
    const keySource = keySourceOf(preset?.id);
    const apiKey =
      keySource === 'opencode' ? null : optionalText(input.apiKey);

    const row = (await this.prisma.$transaction(async (tx) => {
      const total = await tx.aiProvider.count();
      // The first enabled provider is always the default: otherwise a fresh
      // install would create a row the resolver never picks.
      const isDefault = wantsDefault || (total === 0 && enabled);
      if (isDefault) {
        await tx.aiProvider.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.aiProvider.create({
        data: {
          id,
          name,
          kind,
          preset: preset?.id ?? null,
          baseUrl,
          apiKey: apiKey ? this.encryptKey(id, apiKey) : null,
          models: JSON.stringify(models),
          defaultModel,
          reasoningEffort,
          isDefault,
          enabled,
        },
      });
    })) as AiProviderModel;

    return this.view(row);
  }

  async update(
    id: string,
    input: AiProviderUpdateInput,
  ): Promise<AiProviderView> {
    const existing = await this.requireProvider(id);
    const data: {
      name?: string;
      kind?: string;
      baseUrl?: string;
      apiKey?: string | null;
      models?: string;
      defaultModel?: string | null;
      reasoningEffort?: string;
      isDefault?: boolean;
      enabled?: boolean;
    } = {};

    if (input.name !== undefined) {
      data.name = requireString(input.name, 'name', { max: 80 });
    }
    if (input.kind !== undefined) {
      data.kind = optionalText(input.kind) ?? 'openai-compatible';
    }
    if (input.baseUrl !== undefined) data.baseUrl = normalizeBaseUrl(input.baseUrl);
    if (input.models !== undefined) {
      data.models = JSON.stringify(parseStringArray(input.models));
    }
    if (input.defaultModel !== undefined) {
      data.defaultModel = optionalText(input.defaultModel);
    }
    if (input.reasoningEffort !== undefined) {
      data.reasoningEffort = parseReasoningEffort(
        input.reasoningEffort,
        this.parseEffort(existing.reasoningEffort),
      );
    }
    if (input.enabled !== undefined) {
      data.enabled = parseBoolean(input.enabled, existing.enabled);
    }
    if (input.isDefault !== undefined) {
      data.isDefault = parseBoolean(input.isDefault, existing.isDefault);
    }
    if (input.apiKey !== undefined) {
      // `null` (or an empty string) clears the stored key.
      const value = optionalText(input.apiKey);
      data.apiKey = value ? this.encryptKey(existing.id, value) : null;
    }

    if (Object.keys(data).length === 0) return this.view(existing);

    if (data.baseUrl !== undefined && data.baseUrl !== existing.baseUrl) {
      this.modelCache.delete(existing.id);
    }

    const row = (await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.aiProvider.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.aiProvider.update({ where: { id: existing.id }, data });
    })) as AiProviderModel;

    return this.view(row);
  }

  /**
   * Deletes a provider. When it was the default, the oldest enabled remaining
   * provider is promoted in the same transaction, so the list never keeps a
   * dangling default.
   */
  async remove(id: string): Promise<AiProviderDeleteResult> {
    const existing = await this.requireProvider(id);
    this.modelCache.delete(existing.id);
    const promotedId = await this.prisma.$transaction(async (tx) => {
      await tx.aiProvider.delete({ where: { id: existing.id } });
      if (!existing.isDefault) return null;
      const next = (await tx.aiProvider.findFirst({
        where: { enabled: true },
        orderBy: { createdAt: 'asc' },
      })) as AiProviderModel | null;
      if (!next) return null;
      await tx.aiProvider.update({
        where: { id: next.id },
        data: { isDefault: true },
      });
      return next.id;
    });
    return { removed: true, promotedId };
  }

  /** Makes one provider the single default. */
  async makeDefault(id: string): Promise<AiProviderView> {
    const existing = await this.requireProvider(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.aiProvider.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      await tx.aiProvider.update({
        where: { id: existing.id },
        data: { isDefault: true },
      });
    });
    return this.view({ ...existing, isDefault: true });
  }

  /**
   * One minimal chat completion against the provider. Never exposes the key,
   * never throws: failures come back as `{ ok: false, error }`.
   */
  async test(id: string): Promise<AiProviderTestResult> {
    const provider = await this.requireProvider(id);
    const started = Date.now();
    const baseUrl = text(provider.baseUrl);
    const model = this.modelOf(provider);
    if (!baseUrl) {
      return {
        ok: false,
        status: null,
        latencyMs: 0,
        error: 'The provider has no base URL',
      };
    }
    if (!model) {
      return {
        ok: false,
        status: null,
        latencyMs: 0,
        error: 'The provider has no model: set defaultModel or add one to models',
      };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Same key chain and headers as `models()`: a preset provider with no
      // stored key (OpenCode Go) must be testable too.
      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      });
      const pending = this.requestWithCandidates(
        provider,
        chatEndpoint(baseUrl),
        (key) => ({
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...extraHeaders(),
          },
          body,
          signal: controller.signal,
        }),
      );
      void pending.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new Error(`No answer within ${TEST_TIMEOUT_MS} ms`),
          );
        }, TEST_TIMEOUT_MS);
      });
      const { response, raw } = await Promise.race([pending, timeout]);
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          latencyMs,
          error: errorMessage(raw),
        };
      }
      // Some gateways answer 200 with an OpenAI error envelope.
      try {
        const parsed = JSON.parse(raw) as { error?: unknown };
        if (parsed?.error) {
          return {
            ok: false,
            status: response.status,
            latencyMs,
            error: errorMessage(raw),
          };
        }
      } catch {
        // A healthy non-JSON answer is unusual but still a successful call.
      }
      return { ok: true, status: response.status, latencyMs };
    } catch (error) {
      const message =
        (error as Error).name === 'AbortError'
          ? `No answer within ${TEST_TIMEOUT_MS} ms`
          : (error as Error).message;
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        error: message.slice(0, 300),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The models the provider itself offers (`GET <baseUrl>/models`), so the
   * dashboard never asks the user to type a model id. Cached for five minutes;
   * never throws — on failure the list stored on the row comes back with
   * `source: 'stored'` and an `error` for the UI.
   */
  async models(id: string): Promise<AiProviderModelsView> {
    const provider = await this.requireProvider(id);
    const baseUrl = text(provider.baseUrl);
    const stored: AiProviderModelInfo[] = parseStringArray(provider.models).map(
      (model) => ({ id: model }),
    );
    if (!baseUrl) {
      return {
        models: stored,
        source: 'stored',
        error: 'The provider has no base URL',
      };
    }

    const cached = this.modelCache.get(provider.id);
    if (
      cached &&
      cached.baseUrl === baseUrl &&
      Date.now() - cached.at < MODEL_CACHE_TTL_MS
    ) {
      return {
        models: cached.models,
        source: 'provider',
        cached: true,
        fetchedAt: new Date(cached.at).toISOString(),
      };
    }

    try {
      const { response, raw } = await this.getFromProvider(
        provider,
        modelsEndpoint(baseUrl),
      );
      if (!response.ok) {
        return { models: stored, source: 'stored', error: errorMessage(raw) };
      }
      const parsed = this.parseJson(raw);
      // Some gateways answer 200 with an OpenAI error envelope.
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { error?: unknown }).error
      ) {
        return { models: stored, source: 'stored', error: errorMessage(raw) };
      }
      const models = parseModelsPayload(parsed);
      if (models.length === 0) {
        return {
          models: stored,
          source: 'stored',
          error: 'The provider returned no models',
        };
      }
      const at = Date.now();
      this.modelCache.set(provider.id, { baseUrl, at, models });
      return {
        models,
        source: 'provider',
        fetchedAt: new Date(at).toISOString(),
      };
    } catch (error) {
      return {
        models: stored,
        source: 'stored',
        error: (error as Error).message.slice(0, 300),
      };
    }
  }

  /**
   * Stored limits plus, when the provider really exposes one, its usage/quota.
   * OpenCode Go documents `GET https://opencode.ai/inference/go/v1/usage`
   * (rolling / weekly / monthly meters); other providers have no such endpoint,
   * so they report `source: 'manual'`. Local `AgentRun` counters are always
   * added when they can be read.
   */
  async limits(id: string): Promise<AiProviderLimitsView> {
    const provider = await this.requireProvider(id);
    const limits = parseLimits(provider.limits);
    const checkedAt = new Date().toISOString();
    const observed = await this.observedUsage();
    const endpoint = opencodeUsageEndpoint(text(provider.baseUrl));
    if (!endpoint) {
      return { source: 'manual', limits, observed, checkedAt };
    }

    try {
      const { response, raw } = await this.getFromProvider(provider, endpoint);
      if (!response.ok) {
        return {
          source: 'manual',
          limits,
          observed,
          checkedAt,
          error: errorMessage(raw),
        };
      }
      const usage = parseUsagePayload(this.parseJson(raw));
      if (!usage) {
        return {
          source: 'manual',
          limits,
          observed,
          checkedAt,
          error: 'The provider returned no usage data',
        };
      }
      return { source: 'provider', limits, observed, usage, checkedAt };
    } catch (error) {
      return {
        source: 'manual',
        limits,
        observed,
        checkedAt,
        error: (error as Error).message.slice(0, 300),
      };
    }
  }

  /** `PATCH /ai/providers/:id/limits`; `0` means unlimited. */
  async updateLimits(
    id: string,
    input: AiProviderLimitsInput = {},
  ): Promise<AiProviderLimitsUpdateResult> {
    const existing = await this.requireProvider(id);
    const limits: AiProviderLimits = mergeLimits(
      parseLimits(existing.limits),
      (input ?? {}) as Record<string, unknown>,
    );
    await this.prisma.aiProvider.update({
      where: { id: existing.id },
      data: { limits: JSON.stringify(limits) },
    });
    return { limits };
  }

  /**
   * `PUT /ai/providers/:id/models`: persists the list the dashboard picked
   * (usually the one `GET .../models` just fetched). When no `defaultModel` is
   * given and the current one is gone, the first model becomes the default so
   * the resolver never points at a model the provider no longer lists.
   */
  async saveModels(
    id: string,
    input: AiProviderModelsInput = {},
  ): Promise<AiProviderView> {
    const existing = await this.requireProvider(id);
    const update: AiProviderUpdateInput = {};
    if (input.models !== undefined) {
      update.models = input.models;
      const models = parseStringArray(input.models);
      const current = optionalText(existing.defaultModel);
      if (
        input.defaultModel === undefined &&
        (!current || !models.includes(current))
      ) {
        update.defaultModel = models[0] ?? null;
      }
    }
    if (input.defaultModel !== undefined) {
      update.defaultModel = input.defaultModel;
    }
    return this.update(id, update);
  }

  /** Local request counters next to the provider quota; cheap and safe. */
  private async observedUsage(): Promise<AiProviderObservedUsage | undefined> {
    const now = Date.now();
    try {
      const [lastHour, lastDay] = await Promise.all([
        this.prisma.agentRun.count({
          where: { createdAt: { gte: new Date(now - HOUR_MS) } },
        }),
        this.prisma.agentRun.count({
          where: { createdAt: { gte: new Date(now - DAY_MS) } },
        }),
      ]);
      return { lastHour, lastDay };
    } catch {
      // Older databases without AgentRun still get the limits.
      return undefined;
    }
  }

  /**
   * Key candidates for a provider call, most specific first: the OpenCode
   * token for `opencode` presets, then the stored key, the legacy settings key
   * and `AI_API_KEY`. Deduplicated; a single `null` (unauthenticated) when
   * nothing is configured, which is how local providers work.
   */
  private async keyCandidates(
    row: AiProviderModel,
  ): Promise<(string | null)[]> {
    const candidates: string[] = [];
    const add = (value: string | null | undefined): void => {
      const key = value?.trim();
      if (key && !candidates.includes(key)) candidates.push(key);
    };
    if (keySourceOf(row.preset) === 'opencode') add(readOpencodeToken());
    add(this.readKey(row));
    add(await this.settingsKey());
    add(text(process.env.AI_API_KEY) || null);
    return candidates.length > 0 ? candidates : [null];
  }

  /**
   * One request per key candidate until the provider accepts it. The chain is
   * shared by `models()`, `limits()` and `test()` so they cannot drift:
   * OpenCode token (presets) → stored key → legacy settings key → `AI_API_KEY`,
   * deduplicated, ending with a single unauthenticated attempt when nothing is
   * configured. A 401/403 moves on to the next candidate (an expired OpenCode
   * token must not hide a working `AI_API_KEY`); transport errors are not
   * retried because every candidate would hit the same network.
   */
  private async requestWithCandidates(
    row: AiProviderModel,
    url: string,
    init: (key: string | null) => RequestInit,
  ): Promise<{ response: Response; raw: string; key: string | null }> {
    const keys = await this.keyCandidates(row);
    let last: { response: Response; raw: string; key: string | null } | null =
      null;
    for (const key of keys) {
      const response = await fetch(url, init(key));
      const raw = await response.text().catch(() => '');
      last = { response, raw, key };
      if (response.status !== 401 && response.status !== 403) return last;
    }
    if (!last) throw new Error('The provider did not answer');
    return last;
  }

  /** GET through the shared key chain, with the provider-call timeout. */
  private async getFromProvider(
    row: AiProviderModel,
    url: string,
  ): Promise<{ response: Response; raw: string }> {
    return this.requestWithCandidates(row, url, (key) => ({
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...extraHeaders(),
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    }));
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * Copies the legacy single-provider `AiSetting` into the first
   * `AiProvider` row. Idempotent: does nothing when any provider exists or the
   * settings are empty.
   */
  async importSettings(): Promise<AiProviderImportResult> {
    const setting = await this.settingsRow();
    if (!setting) return { created: false };
    const baseUrl = text(setting.baseUrl).replace(/\/+$/, '');
    const model = text(setting.model);
    if (!baseUrl && !model) return { created: false };
    const apiKey = this.readSettingsKey(setting);
    const id = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.aiProvider.count();
      if (total > 0) return { created: false };
      await tx.aiProvider.create({
        data: {
          id,
          name: this.importName(baseUrl),
          kind: text(setting.provider) || 'openai-compatible',
          baseUrl,
          apiKey: apiKey ? this.encryptKey(id, apiKey) : null,
          models: JSON.stringify(model ? [model] : []),
          defaultModel: model || null,
          reasoningEffort: this.parseEffort(setting.reasoningEffort),
          isDefault: true,
          enabled: true,
        },
      });
      return { created: true };
    });
  }

  /**
   * Effective configuration for one LLM request.
   *
   * Provider (default + enabled, with a base URL and a model) wins; the legacy
   * `AiSetting` row is next; `AI_*` env vars are the last resort.
   */
  async resolve(): Promise<ResolvedProvider> {
    const headers = extraHeaders();
    const provider = await this.defaultProvider();
    if (provider) {
      const model = this.modelOf(provider);
      if (text(provider.baseUrl) && model) {
        return {
          baseUrl: text(provider.baseUrl),
          model,
          apiKey: this.readKey(provider) ?? (await this.settingsKey()),
          reasoningEffort: this.parseEffort(provider.reasoningEffort),
          extraHeaders: headers,
          source: 'provider',
        };
      }
    }

    const setting = await this.settingsRow();
    const baseUrl = text(setting?.baseUrl) || text(process.env.AI_BASE_URL);
    const model = text(setting?.model) || text(process.env.AI_MODEL);
    return {
      baseUrl,
      model,
      apiKey:
        this.readSettingsKey(setting) ?? (text(process.env.AI_API_KEY) || null),
      reasoningEffort: this.parseEffort(
        text(setting?.reasoningEffort) || process.env.AI_REASONING_EFFORT,
      ),
      extraHeaders: headers,
      source: setting && (text(setting.baseUrl) || text(setting.model))
        ? 'settings'
        : 'env',
    };
  }

  /** Model used for a provider: explicit default, else the first listed. */
  private modelOf(row: AiProviderModel): string {
    return text(row.defaultModel) || parseStringArray(row.models)[0] || '';
  }

  private parseEffort(value: unknown): ReasoningEffort {
    return parseReasoningEffort(value);
  }

  private view(row: AiProviderModel): AiProviderView {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      preset: row.preset ?? null,
      keySource: keySourceOf(row.preset),
      baseUrl: row.baseUrl,
      models: parseStringArray(row.models),
      defaultModel: row.defaultModel,
      reasoningEffort: this.parseEffort(row.reasoningEffort),
      limits: parseLimits(row.limits),
      isDefault: row.isDefault,
      enabled: row.enabled,
      hasKey: Boolean(row.apiKey),
    };
  }

  private async requireProvider(id: string): Promise<AiProviderModel> {
    const row = (await this.prisma.aiProvider.findUnique({
      where: { id },
    })) as AiProviderModel | null;
    if (!row) {
      throw notFound('PROVIDER_NOT_FOUND', `AI provider ${id} does not exist`);
    }
    return row;
  }

  private async defaultProvider(): Promise<AiProviderModel | null> {
    try {
      return (await this.prisma.aiProvider.findFirst({
        where: { isDefault: true, enabled: true },
        orderBy: { createdAt: 'asc' },
      })) as AiProviderModel | null;
    } catch (error) {
      // The providers table arrives with a migration; an older database must
      // keep working through the legacy settings.
      this.logger.warn(
        `AI providers are unavailable: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async settingsRow(): Promise<AiSettingModel | null> {
    try {
      return (await this.prisma.aiSetting.findUnique({
        where: { id: SETTINGS_ID },
      })) as AiSettingModel | null;
    } catch {
      return null;
    }
  }

  /** Legacy `AiSetting` key, encrypted in dedicated columns. */
  private async settingsKey(): Promise<string | null> {
    return this.readSettingsKey(await this.settingsRow());
  }

  private readSettingsKey(row: AiSettingModel | null): string | null {
    if (!row) return null;
    const cipher = row.apiKeyEncrypted;
    const nonce = row.apiKeyNonce;
    const tag = row.apiKeyTag;
    const dekWrapped = row.apiKeyDekWrapped;
    const dekNonce = row.apiKeyDekNonce;
    const dekTag = row.apiKeyDekTag;
    if (!cipher || !nonce || !tag || !dekWrapped || !dekNonce || !dekTag) {
      return null;
    }
    try {
      return this.crypto
        .decrypt(
          {
            cipher: new Uint8Array(cipher),
            nonce: new Uint8Array(nonce),
            tag: new Uint8Array(tag),
            dekWrapped: new Uint8Array(dekWrapped),
            dekNonce: new Uint8Array(dekNonce),
            dekTag: new Uint8Array(dekTag),
            keyVersion: 1,
          },
          SETTINGS_KEY_AAD,
        )
        .toString('utf8');
    } catch (error) {
      emitLog({
        level: 'error',
        source: 'ai',
        action: 'ai.provider.settings-key',
        message: `Could not decrypt the AI settings key: ${(error as Error).message}`,
        status: 'failed',
      });
      return null;
    }
  }

  private encryptKey(id: string, value: string): string {
    const envelope = this.crypto.serialize(
      this.crypto.encrypt(value, `ai-provider:${id}`),
    );
    return `${SECRET_PREFIX}${Buffer.from(envelope).toString('base64')}`;
  }

  /** Decrypts a stored key; plain legacy values are returned as-is. */
  private readKey(row: AiProviderModel): string | null {
    const stored = row.apiKey?.trim();
    if (!stored) return null;
    if (!stored.startsWith(SECRET_PREFIX)) return stored;
    try {
      const envelope = new Uint8Array(
        Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64'),
      );
      return this.crypto
        .decrypt(this.crypto.deserialize(envelope), `ai-provider:${row.id}`)
        .toString('utf8');
    } catch (error) {
      emitLog({
        level: 'error',
        source: 'ai',
        action: 'ai.provider.key',
        message: `Could not decrypt the key of AI provider ${row.id}: ${(error as Error).message}`,
        status: 'failed',
      });
      return null;
    }
  }

  private importName(baseUrl: string): string {
    if (!baseUrl) return 'Imported provider';
    try {
      return new URL(baseUrl).hostname || 'Imported provider';
    } catch {
      return 'Imported provider';
    }
  }
}
