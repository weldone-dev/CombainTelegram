import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { AiSettingModel, TelegramAccountModel } from '@repo/database';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent, fetch as httpFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { AiProvidersService } from '../ai-providers/ai-providers.service.js';
import type { ResolvedProvider as ProviderResolution } from '../ai-providers/ai-providers.types.js';
import { apiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import type { EncryptedPayload } from '../telegram/session-crypto.service.js';
import { emitLog } from '../logs/log-sink.js';
import { isPrivateHost } from './speech.service.js';
import {
  DEFAULT_CAPABILITIES,
  type AiCapabilities,
  type AiCapability,
  type AiPolicyView,
  type AiSettingsUpdate,
  type AiSettingsView,
  type ReasoningEffort,
  type ResolvedProvider,
  type SttEngine,
  type SttTestResult,
} from './ai.types.js';

const SETTINGS_ID = 'default';
const AAD_KEY = 'ai:api-key';
const AAD_MCP = 'ai:mcp-token';
const AAD_STT_KEY = 'ai:stt-key';
/** Stored STT keys carry this prefix; legacy plain values still work. */
const STT_SECRET_PREFIX = 'enc:v1:';
/**
 * Same fallback as `speech.service.ts` (the Proxmox `parakeet-lxc` service);
 * the constant is not exported there, so it is mirrored here for the probe.
 */
const DEFAULT_STT_BASE_URL = 'http://192.168.31.108:5092';
/** A test must never hang the settings page. */
const STT_PROBE_TIMEOUT_MS = 5_000;
const STT_ENGINES: SttEngine[] = [
  'auto',
  'remote',
  'parakeet',
  'whisper',
  'disabled',
];

export interface PolicyUpdate {
  capabilities?: unknown;
  allowAccountIds?: unknown;
  allowChatIds?: unknown;
  blockChatIds?: unknown;
  dryRun?: unknown;
  ownerTgUserIds?: unknown;
}

const REASONING_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

function parseReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = 'low',
): ReasoningEffort {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (REASONING_EFFORTS as string[]).includes(effort)
    ? (effort as ReasoningEffort)
    : fallback;
}

/** Tolerant read for stored rows: unknown/empty values mean `auto`. */
function parseSttEngine(value: unknown): SttEngine {
  const engine = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (STT_ENGINES as string[]).includes(engine)
    ? (engine as SttEngine)
    : 'auto';
}

/** Strict variant for writes: a typo must not silently reset the engine. */
function requireSttEngine(value: unknown): SttEngine {
  const engine = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(STT_ENGINES as string[]).includes(engine)) {
    throw apiError(
      'INVALID_STT_ENGINE',
      `sttEngine must be one of: ${STT_ENGINES.join(', ')}`,
      400,
    );
  }
  return engine as SttEngine;
}

/** Empty clears the override; anything else must be an absolute http(s) URL. */
function requireSttBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw apiError(
      'INVALID_STT_URL',
      'sttBaseUrl must be an http(s) URL or an empty string',
      400,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw apiError(
      'INVALID_STT_URL',
      'sttBaseUrl must be an http(s) URL or an empty string',
      400,
    );
  }
  return raw;
}

/** `<origin>/health`, tolerating a base URL with a path (same as speech). */
function sttHealthEndpoint(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/health`;
  } catch {
    return `${baseUrl.trim().replace(/\/+$/, '')}/health`;
  }
}

let sttDirectAgent: Agent | null = null;

/** Proxy-free dispatcher for LAN STT hosts (mirrors `speech.service.ts`). */
function sttDispatcher(): Agent {
  sttDirectAgent ??= new Agent({ connect: { timeout: 10_000 } });
  return sttDirectAgent;
}

function sttRequestInit(
  url: string,
  init: UndiciRequestInit,
): UndiciRequestInit {
  const result: UndiciRequestInit = { ...init };
  try {
    // A corporate `HTTP_PROXY` answers 503 for the LAN, so bypass it.
    if (isPrivateHost(new URL(url).hostname)) {
      result.dispatcher = sttDispatcher();
    }
  } catch {
    // A malformed URL fails at fetch() with a readable error.
  }
  return result;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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

function parseNumberArray(value: unknown): number[] {
  return parseStringArray(value)
    .filter((item) => /^-?\d+$/.test(item))
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item));
}

export function parseCapabilities(raw: unknown): AiCapabilities {
  const source =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : {};
  const result: AiCapabilities = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(DEFAULT_CAPABILITIES) as AiCapability[]) {
    const value = source[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function clampTemperature(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(2, Math.max(0, number));
}

function clampSteps(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(12, Math.max(1, Math.round(number)));
}

@Injectable()
export class AiConfigService implements OnModuleInit {
  private readonly logger = new Logger(AiConfigService.name);
  private opencodeToken: { token: string; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
    // Optional so the service still works without the providers module
    // (unit tests, older wiring); `AiProvidersModule` is global at runtime.
    @Optional() private readonly providers?: AiProvidersService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.row();
      await this.mcpToken();
    } catch (error) {
      // A missing table should not stop the API from booting; the dashboard
      // shows the error and AI features stay disabled.
      this.logger.warn(
        `AI settings are unavailable: ${(error as Error).message}`,
      );
    }
  }

  /** Ensures the singleton row exists and returns it. */
  async row(): Promise<AiSettingModel> {
    const existing = await this.prisma.aiSetting.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (existing) return existing;
    return this.prisma.aiSetting.create({
      data: {
        id: SETTINGS_ID,
        capabilities: JSON.stringify(DEFAULT_CAPABILITIES),
      },
    });
  }

  private storeSecret(value: string, aad: string): EncryptedPayload {
    return this.crypto.encrypt(value, aad);
  }

  private readSecret(
    row: AiSettingModel,
    prefix: 'apiKey' | 'mcpToken',
    aad: string,
  ): string | null {
    const cipher = row[`${prefix}Encrypted` as const];
    const nonce = row[`${prefix}Nonce` as const];
    const tag = row[`${prefix}Tag` as const];
    const dekWrapped = row[`${prefix}DekWrapped` as const];
    const dekNonce = row[`${prefix}DekNonce` as const];
    const dekTag = row[`${prefix}DekTag` as const];
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
          aad,
        )
        .toString('utf8');
    } catch (error) {
      emitLog({
        level: 'error',
        source: 'ai',
        action: 'ai.secret.read',
        message: `Could not decrypt AI secret: ${(error as Error).message}`,
        status: 'failed',
      });
      return null;
    }
  }

  private secretColumns(
    secret: EncryptedPayload,
    prefix: 'apiKey' | 'mcpToken' | 'token',
  ): Record<string, Uint8Array<ArrayBuffer>> {
    return {
      [`${prefix}Encrypted`]: secret.cipher,
      [`${prefix}Nonce`]: secret.nonce,
      [`${prefix}Tag`]: secret.tag,
      [`${prefix}DekWrapped`]: secret.dekWrapped,
      [`${prefix}DekNonce`]: secret.dekNonce,
      [`${prefix}DekTag`]: secret.dekTag,
    };
  }

  private env(name: string): string | null {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : null;
  }

  /**
   * STT keys live in a plain `String` column, sealed as
   * `enc:v1:<base64 envelope>` like `AiProvider.apiKey`. Rows written before
   * encryption (or by hand) keep working.
   */
  private readSttKey(row: AiSettingModel): string | null {
    const stored = row.sttApiKey?.trim();
    if (!stored) return null;
    if (!stored.startsWith(STT_SECRET_PREFIX)) return stored;
    try {
      const envelope = new Uint8Array(
        Buffer.from(stored.slice(STT_SECRET_PREFIX.length), 'base64'),
      );
      return this.crypto
        .decrypt(this.crypto.deserialize(envelope), AAD_STT_KEY)
        .toString('utf8');
    } catch (error) {
      emitLog({
        level: 'error',
        source: 'ai',
        action: 'ai.stt-key.read',
        message: `Could not decrypt the STT key: ${(error as Error).message}`,
        status: 'failed',
      });
      return null;
    }
  }

  private sealSttKey(value: string): string {
    const envelope = this.crypto.serialize(
      this.crypto.encrypt(value, AAD_STT_KEY),
    );
    return `${STT_SECRET_PREFIX}${Buffer.from(envelope).toString('base64')}`;
  }

  /**
   * Optional integration with Orca's OpenCode Go subscription: read the live
   * OAuth access token from the local OpenCode database, which Orca refreshes.
   * Falls back to `AI_API_KEY` when the file/schema is unavailable.
   */
  private readOpencodeToken(): string | null {
    if (process.env.AI_API_KEY_SOURCE !== 'opencode') return null;
    if (this.opencodeToken && Date.now() - this.opencodeToken.at < 60_000) {
      return this.opencodeToken.token;
    }
    const file =
      this.env('OPENCODE_DB') ??
      join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      const row = db
        .prepare(
          "select value from credential where integration_id = 'opencode' and active = 1 order by time_updated desc limit 1",
        )
        .get() as { value?: unknown } | undefined;
      db.close();
      if (!row || typeof row.value !== 'string') return null;
      const parsed = JSON.parse(row.value) as { access?: unknown };
      if (typeof parsed.access !== 'string' || !parsed.access.trim()) {
        return null;
      }
      this.opencodeToken = { token: parsed.access.trim(), at: Date.now() };
      return this.opencodeToken.token;
    } catch {
      return null;
    }
  }

  async resolved(): Promise<ResolvedProvider> {
    const row = await this.row();
    // Provider list (new) → legacy settings → env. `AiProvidersService`
    // implements the whole precedence chain; when it is unavailable the code
    // below falls back to the legacy per-field behaviour.
    const provider = await this.providerResolution();
    const dbKey = this.readSecret(row, 'apiKey', AAD_KEY);
    const apiKey =
      this.readOpencodeToken() ??
      provider?.apiKey ??
      dbKey ??
      this.env('AI_API_KEY');
    const baseUrl =
      provider?.baseUrl || text(row.baseUrl, this.env('AI_BASE_URL') ?? '');
    const model = provider?.model || text(row.model, this.env('AI_MODEL') ?? '');
    const fastModel = text(row.fastModel, this.env('AI_FAST_MODEL') ?? model);
    return {
      provider: row.provider,
      baseUrl,
      model,
      fastModel,
      apiKey,
      temperature: row.temperature,
      maxSteps: row.maxSteps,
      reasoningEffort:
        provider?.reasoningEffort ??
        parseReasoningEffort(
          row.reasoningEffort || this.env('AI_REASONING_EFFORT'),
        ),
      dryRun: row.dryRun,
      source: provider
        ? provider.source === 'env'
          ? 'env'
          : 'database'
        : row.baseUrl || row.model
          ? 'database'
          : 'env',
    };
  }

  private async providerResolution(): Promise<ProviderResolution | null> {
    if (!this.providers) return null;
    try {
      return await this.providers.resolve();
    } catch (error) {
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'ai.providers.resolve',
        message: `Could not resolve an AI provider: ${(error as Error).message}`,
        status: 'failed',
      });
      return null;
    }
  }

  async requireProvider(): Promise<ResolvedProvider & { apiKey: string }> {
    const resolved = await this.resolved();
    if (!resolved.baseUrl || !resolved.model) {
      throw new Error(
        'LLM is not configured: set AI_BASE_URL/AI_MODEL in apps/api/.env or in the AI settings.',
      );
    }
    if (!resolved.apiKey) {
      throw new Error(
        'LLM API key is missing: set AI_API_KEY in apps/api/.env or in the AI settings.',
      );
    }
    return { ...resolved, apiKey: resolved.apiKey };
  }

  async policy(): Promise<AiPolicyView> {
    const row = await this.row();
    return {
      capabilities: parseCapabilities(row.capabilities),
      allowAccountIds: parseStringArray(row.allowAccountIds),
      allowChatIds: parseNumberArray(row.allowChatIds),
      blockChatIds: parseNumberArray(row.blockChatIds),
      dryRun: row.dryRun,
      ownerTgUserIds: parseNumberArray(row.ownerTgUserIds).map(String),
    };
  }

  async update(input: AiSettingsUpdate): Promise<AiSettingsView> {
    const row = await this.row();
    const data: Record<string, unknown> = {};
    if (input.provider !== undefined) {
      data.provider = text(input.provider, 'openai-compatible');
    }
    if (input.baseUrl !== undefined) data.baseUrl = text(input.baseUrl);
    if (input.model !== undefined) data.model = text(input.model);
    if (input.fastModel !== undefined) data.fastModel = text(input.fastModel);
    if (input.apiKey !== undefined) {
      const value = optionalText(input.apiKey);
      if (value) {
        Object.assign(
          data,
          this.secretColumns(this.storeSecret(value, AAD_KEY), 'apiKey'),
        );
      } else {
        data.apiKeyEncrypted = null;
        data.apiKeyNonce = null;
        data.apiKeyTag = null;
        data.apiKeyDekWrapped = null;
        data.apiKeyDekNonce = null;
        data.apiKeyDekTag = null;
      }
    }
    if (input.temperature !== undefined) {
      data.temperature = clampTemperature(input.temperature, row.temperature);
    }
    if (input.maxSteps !== undefined) {
      data.maxSteps = clampSteps(input.maxSteps, row.maxSteps);
    }
    if (input.reasoningEffort !== undefined) {
      data.reasoningEffort = parseReasoningEffort(
        input.reasoningEffort,
        parseReasoningEffort(row.reasoningEffort),
      );
    }
    if (input.dryRun !== undefined) {
      data.dryRun = input.dryRun === true || input.dryRun === 'true';
    }
    // Speech-to-text settings. Untouched fields stay untouched, so the
    // legacy LLM-only payloads keep working.
    if (input.sttEngine !== undefined) {
      data.sttEngine = requireSttEngine(input.sttEngine);
    }
    if (input.sttBaseUrl !== undefined) {
      data.sttBaseUrl = requireSttBaseUrl(input.sttBaseUrl);
    }
    if (input.sttModel !== undefined) {
      data.sttModel = optionalText(input.sttModel);
    }
    if (input.sttLanguage !== undefined) {
      data.sttLanguage = text(input.sttLanguage, 'auto');
    }
    if (input.sttApiKey !== undefined) {
      const value = optionalText(input.sttApiKey);
      data.sttApiKey = value ? this.sealSttKey(value) : null;
    }
    if (input.capabilities !== undefined) {
      data.capabilities = JSON.stringify(
        parseCapabilities(input.capabilities),
      );
    }
    if (input.allowAccountIds !== undefined) {
      data.allowAccountIds = JSON.stringify(
        parseStringArray(input.allowAccountIds),
      );
    }
    if (input.allowChatIds !== undefined) {
      data.allowChatIds = JSON.stringify(parseNumberArray(input.allowChatIds));
    }
    if (input.blockChatIds !== undefined) {
      data.blockChatIds = JSON.stringify(parseNumberArray(input.blockChatIds));
    }
    if (input.ownerTgUserIds !== undefined) {
      data.ownerTgUserIds = JSON.stringify(
        parseNumberArray(input.ownerTgUserIds),
      );
    }
    await this.prisma.aiSetting.update({ where: { id: SETTINGS_ID }, data });
    return this.view();
  }

  async updatePolicy(input: PolicyUpdate): Promise<AiPolicyView> {
    const settings: AiSettingsUpdate = {};
    if (input.capabilities !== undefined) {
      settings.capabilities = input.capabilities;
    }
    if (input.allowAccountIds !== undefined) {
      settings.allowAccountIds = input.allowAccountIds;
    }
    if (input.allowChatIds !== undefined) {
      settings.allowChatIds = input.allowChatIds;
    }
    if (input.blockChatIds !== undefined) {
      settings.blockChatIds = input.blockChatIds;
    }
    if (input.ownerTgUserIds !== undefined) {
      settings.ownerTgUserIds = input.ownerTgUserIds;
    }
    if (input.dryRun !== undefined) settings.dryRun = input.dryRun;
    await this.update(settings);
    return this.policy();
  }

  /** Plain MCP bearer token. Generated once, then stored encrypted. */
  async mcpToken(): Promise<string> {
    const row = await this.row();
    const stored = this.readSecret(row, 'mcpToken', AAD_MCP);
    if (stored) return stored;
    const fromEnv = this.env('MCP_TOKEN');
    if (fromEnv) return fromEnv;
    const token = randomBytes(32).toString('hex');
    await this.prisma.aiSetting.update({
      where: { id: SETTINGS_ID },
      data: this.secretColumns(this.storeSecret(token, AAD_MCP), 'mcpToken'),
    });
    return token;
  }

  async rotateMcpToken(): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.prisma.aiSetting.update({
      where: { id: SETTINGS_ID },
      data: this.secretColumns(this.storeSecret(token, AAD_MCP), 'mcpToken'),
    });
    return token;
  }

  /** Owner Telegram ids: explicit policy list or every attached account. */
  async ownerTgUserIds(): Promise<string[]> {
    const policy = await this.policy();
    if (policy.ownerTgUserIds.length > 0) return policy.ownerTgUserIds;
    const accounts = (await this.prisma.telegramAccount.findMany({
      select: { tgUserId: true },
    })) as Pick<TelegramAccountModel, 'tgUserId'>[];
    return accounts.map((account) => account.tgUserId.toString());
  }

  async view(): Promise<AiSettingsView> {
    const row = await this.row();
    const resolved = await this.resolved();
    const token = await this.mcpToken();
    const policy = await this.policy();
    const envConfigured = Boolean(
      this.env('AI_BASE_URL') && this.env('AI_API_KEY'),
    );
    const dbKey = this.readSecret(row, 'apiKey', AAD_KEY);
    return {
      provider: row.provider,
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      fastModel: resolved.fastModel,
      hasApiKey: Boolean(resolved.apiKey),
      apiKeyHint: resolved.apiKey
        ? `…${resolved.apiKey.slice(-4)}`
        : null,
      apiKeySource: this.readOpencodeToken()
        ? 'opencode'
        : dbKey
          ? 'db'
          : this.env('AI_API_KEY')
            ? 'env'
            : resolved.apiKey
              ? 'db'
              : 'none',
      temperature: row.temperature,
      maxSteps: row.maxSteps,
      reasoningEffort: parseReasoningEffort(row.reasoningEffort),
      dryRun: row.dryRun,
      capabilities: policy.capabilities,
      allowAccountIds: policy.allowAccountIds,
      allowChatIds: policy.allowChatIds,
      blockChatIds: policy.blockChatIds,
      ownerTgUserIds: policy.ownerTgUserIds,
      source: resolved.source,
      envConfigured,
      sttEngine: parseSttEngine(row.sttEngine),
      sttBaseUrl: text(row.sttBaseUrl),
      sttModel: optionalText(row.sttModel),
      sttLanguage: text(row.sttLanguage, 'auto'),
      hasSttKey: Boolean(this.readSttKey(row)),
      mcp: {
        endpoint: '/mcp',
        token,
      },
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Probes the remote STT service for the settings page. Uses the same
   * precedence as `SpeechService`: `STT_ENGINE=parakeet|whisper` forces a local
   * engine and `STT_REMOTE=off` disables the network engine; `STT_BASE_URL`
   * overrides the stored base URL. The API key is never part of the result.
   */
  async sttTest(): Promise<SttTestResult> {
    const row = await this.row();
    const envEngine = this.env('STT_ENGINE')?.toLowerCase();
    const forcedLocal =
      envEngine === 'parakeet' || envEngine === 'whisper' ? envEngine : null;
    const effective: SttEngine = forcedLocal ?? parseSttEngine(row.sttEngine);
    if (effective === 'disabled') {
      return {
        ok: false,
        status: null,
        latencyMs: 0,
        engine: 'local',
        detail: 'Speech-to-text is disabled',
      };
    }
    const remoteOff = this.env('STT_REMOTE')?.toLowerCase() === 'off';
    if (effective === 'parakeet' || effective === 'whisper' || remoteOff) {
      return {
        ok: true,
        status: null,
        latencyMs: 0,
        engine: 'local',
        detail:
          effective === 'parakeet' || effective === 'whisper'
            ? `Local ${effective} engine does not use the network`
            : 'Remote speech-to-text is disabled (STT_REMOTE=off)',
      };
    }
    const baseUrl =
      this.env('STT_BASE_URL') ?? text(row.sttBaseUrl, DEFAULT_STT_BASE_URL);
    const url = sttHealthEndpoint(baseUrl);
    const started = Date.now();
    try {
      const response = await httpFetch(
        url,
        sttRequestInit(url, {
          method: 'GET',
          signal: AbortSignal.timeout(STT_PROBE_TIMEOUT_MS),
        }),
      );
      await response.body?.cancel().catch(() => undefined);
      const latencyMs = Date.now() - started;
      return response.ok
        ? { ok: true, status: response.status, latencyMs, engine: 'remote' }
        : {
            ok: false,
            status: response.status,
            latencyMs,
            engine: 'remote',
            detail: `HTTP ${response.status}`,
          };
    } catch (error) {
      const detail = (error as Error).message;
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'ai.stt.test',
        message: `STT health probe failed: ${detail}`,
        status: 'failed',
      });
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        engine: 'remote',
        detail,
      };
    }
  }
}
