import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { AiSettingModel, TelegramAccountModel } from '@repo/database';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import type { EncryptedPayload } from '../telegram/session-crypto.service.js';
import { emitLog } from '../logs/log-sink.js';
import {
  DEFAULT_CAPABILITIES,
  type AiCapabilities,
  type AiCapability,
  type AiPolicyView,
  type AiSettingsUpdate,
  type AiSettingsView,
  type ResolvedProvider,
} from './ai.types.js';

const SETTINGS_ID = 'default';
const AAD_KEY = 'ai:api-key';
const AAD_MCP = 'ai:mcp-token';

export interface PolicyUpdate {
  capabilities?: unknown;
  allowAccountIds?: unknown;
  allowChatIds?: unknown;
  blockChatIds?: unknown;
  dryRun?: unknown;
  ownerTgUserIds?: unknown;
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
    const baseUrl = text(row.baseUrl, this.env('AI_BASE_URL') ?? '');
    const model = text(row.model, this.env('AI_MODEL') ?? '');
    const fastModel = text(row.fastModel, this.env('AI_FAST_MODEL') ?? model);
    const dbKey = this.readSecret(row, 'apiKey', AAD_KEY);
    const apiKey =
      this.readOpencodeToken() ?? dbKey ?? this.env('AI_API_KEY');
    return {
      provider: row.provider,
      baseUrl,
      model,
      fastModel,
      apiKey,
      temperature: row.temperature,
      maxSteps: row.maxSteps,
      dryRun: row.dryRun,
      source: row.baseUrl || row.model ? 'database' : 'env',
    };
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
    if (input.dryRun !== undefined) {
      data.dryRun = input.dryRun === true || input.dryRun === 'true';
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
            : 'none',
      temperature: row.temperature,
      maxSteps: row.maxSteps,
      dryRun: row.dryRun,
      capabilities: policy.capabilities,
      allowAccountIds: policy.allowAccountIds,
      allowChatIds: policy.allowChatIds,
      blockChatIds: policy.blockChatIds,
      ownerTgUserIds: policy.ownerTgUserIds,
      source: resolved.source,
      envConfigured,
      mcp: {
        endpoint: '/mcp',
        token,
      },
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
