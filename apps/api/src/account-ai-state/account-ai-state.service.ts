import { Injectable } from '@nestjs/common';
import type { AiChatSettingModel } from '@repo/database';
import { apiError, notFound } from '../common/api-error.js';
import { parseChatId } from '../messaging/params.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

/** A per-account variable object never grows past these bounds. */
export const VARIABLES_MAX_KEYS = 32;
export const VARIABLES_MAX_VALUE_CHARS = 2_000;
export const VARIABLES_MAX_BYTES = 16 * 1024;
/** Per-chat override object bound (typing mode, max parts, ...). */
export const CHAT_SETTINGS_MAX_BYTES = 4 * 1024;

/**
 * Bus event emitted after variables/chat settings change. The n8n event
 * enrichment keeps a 10 s cache, so it subscribes to this instead of polling.
 */
export const AI_STATE_CHANGED = 'ai.state.changed';

export interface AccountVariablesView {
  accountId: string;
  variables: Record<string, string>;
}

export interface ChatSettingsView {
  settings: Record<string, unknown>;
}

/** Payload of {@link AI_STATE_CHANGED}. `chatId = null` = account-wide change. */
export interface AiStateChangedPayload {
  accountId: string;
  chatId: number | null;
  threadId: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parses a JSON object column; a broken value degrades to `{}`. */
export function parseJsonObject(raw: string | null | undefined): Record<
  string,
  unknown
> {
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** Stored variables are strings by contract; anything else is dropped. */
export function parseVariablesColumn(
  raw: string | null | undefined,
): Record<string, string> {
  const entries = Object.entries(parseJsonObject(raw)).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Validates a variables patch: a plain JSON object of at most
 * {@link VARIABLES_MAX_KEYS} string values, each at most
 * {@link VARIABLES_MAX_VALUE_CHARS} characters and {@link VARIABLES_MAX_BYTES}
 * in total. Returns the normalised object (a patch replaces the old one).
 */
export function validateVariables(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError('VALIDATION_ERROR', 'variables must be a plain JSON object');
  }
  const entries = Object.entries(raw);
  if (entries.length > VARIABLES_MAX_KEYS) {
    throw apiError(
      'VALIDATION_ERROR',
      `variables must have at most ${VARIABLES_MAX_KEYS} keys`,
    );
  }
  const parsed: Array<[string, string]> = [];
  for (const [key, value] of entries) {
    if (!key.trim()) {
      throw apiError('VALIDATION_ERROR', 'variable names must not be empty');
    }
    if (typeof value !== 'string') {
      throw apiError('VALIDATION_ERROR', `variable "${key}" must be a string`);
    }
    if ([...value].length > VARIABLES_MAX_VALUE_CHARS) {
      throw apiError(
        'VALIDATION_ERROR',
        `variable "${key}" must be at most ${VARIABLES_MAX_VALUE_CHARS} characters`,
      );
    }
    parsed.push([key, value]);
  }
  const variables = Object.fromEntries(parsed) as Record<string, string>;
  if (
    Buffer.byteLength(JSON.stringify(variables), 'utf8') > VARIABLES_MAX_BYTES
  ) {
    throw apiError(
      'VALIDATION_ERROR',
      `variables must be at most ${VARIABLES_MAX_BYTES} bytes`,
    );
  }
  return variables;
}

/**
 * Validates a per-chat settings patch: a plain JSON object of at most
 * {@link CHAT_SETTINGS_MAX_BYTES} bytes. Values are free-form so a future
 * typing override (`{ "typing": "natural", "maxParts": 2 }`) needs no schema
 * change here.
 */
export function validateChatSettings(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError('VALIDATION_ERROR', 'settings must be a plain JSON object');
  }
  let size: number;
  let settings: Record<string, unknown>;
  try {
    settings = Object.fromEntries(Object.entries(raw));
    size = Buffer.byteLength(JSON.stringify(settings), 'utf8');
  } catch {
    throw apiError('VALIDATION_ERROR', 'settings must be valid JSON');
  }
  if (size > CHAT_SETTINGS_MAX_BYTES) {
    throw apiError(
      'VALIDATION_ERROR',
      `settings must be at most ${CHAT_SETTINGS_MAX_BYTES} bytes`,
    );
  }
  return settings;
}

/**
 * Per-account variables and per-chat AI overrides, shared by the dashboard
 * (`/accounts/...`) and the n8n Action API (`/integrations/n8n/...`).
 *
 * Both surfaces validate identically and write the same rows. State changes
 * are announced on `RealtimeService` ({@link AI_STATE_CHANGED}) so the n8n
 * event enrichment can drop its 10 s cache without either module importing
 * the other.
 */
@Injectable()
export class AccountAiStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async variables(
    userId: string,
    accountId: string,
  ): Promise<AccountVariablesView> {
    const row = await this.accountColumn(userId, accountId);
    return { accountId, variables: parseVariablesColumn(row) };
  }

  /** Replaces the whole variable object; the old value is not merged. */
  async setVariables(
    userId: string,
    accountId: string,
    rawBody: unknown,
  ): Promise<AccountVariablesView> {
    const body = asRecord(rawBody);
    const variables = validateVariables(body.variables);
    // Ownership is checked before the write, like every other account route.
    await this.accountColumn(userId, accountId);
    await this.prisma.telegramAccount.update({
      where: { id: accountId },
      data: { aiVariables: JSON.stringify(variables) },
    });
    this.changed(userId, accountId, null, null);
    return { accountId, variables };
  }

  /** Settings of exactly this chat/topic; `{}` when no row exists. */
  async chatSettings(
    userId: string,
    accountId: string,
    rawChatId: string | number,
    rawThreadId?: unknown,
  ): Promise<ChatSettingsView> {
    await this.requireAccount(userId, accountId);
    const chatId = this.chatId(rawChatId);
    const threadId = this.threadId(rawThreadId);
    const row = (await this.prisma.aiChatSetting.findUnique({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId,
        },
      },
    })) as AiChatSettingModel | null;
    return { settings: row ? parseJsonObject(row.settings) : {} };
  }

  /** Upserts the overrides of one chat/topic and returns the stored object. */
  async setChatSettings(
    userId: string,
    accountId: string,
    rawChatId: string | number,
    rawBody: unknown,
  ): Promise<ChatSettingsView> {
    await this.requireAccount(userId, accountId);
    const chatId = this.chatId(rawChatId);
    const body = asRecord(rawBody);
    const threadId = this.threadId(body.threadId);
    const settings = validateChatSettings(body.settings);

    await this.prisma.aiChatSetting.upsert({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId,
        },
      },
      create: {
        accountId,
        chatId: BigInt(chatId),
        threadId,
        settings: JSON.stringify(settings),
      },
      update: { settings: JSON.stringify(settings) },
    });
    this.changed(userId, accountId, chatId, threadId);
    return { settings };
  }

  /** Reads `aiVariables` under the same ownership rule as every read. */
  private async accountColumn(
    userId: string,
    accountId: string,
  ): Promise<string> {
    const row = (await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      select: { aiVariables: true },
    })) as { aiVariables: string } | null;
    if (!row) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
    return row.aiVariables;
  }

  /** Same ownership rule as `AccountsService.requireAccount`. */
  private async requireAccount(
    userId: string,
    accountId: string,
  ): Promise<void> {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
  }

  private changed(
    userId: string,
    accountId: string,
    chatId: number | null,
    threadId: number | null,
  ): void {
    const payload: AiStateChangedPayload = { accountId, chatId, threadId };
    this.realtime.emitToUser(userId, AI_STATE_CHANGED, payload);
  }

  private chatId(value: string | number): number {
    return typeof value === 'number' ? value : parseChatId(value);
  }

  /** `0` for the whole chat, a positive thread id otherwise. */
  private threadId(value: unknown): number {
    if (value === undefined || value === null || value === '') return 0;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw apiError(
        'VALIDATION_ERROR',
        'threadId must be a non-negative integer',
      );
    }
    return parsed;
  }
}
