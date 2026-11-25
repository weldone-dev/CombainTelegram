import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type { AiChatSettingModel } from '@repo/database';
import {
  AI_STATE_CHANGED,
  parseJsonObject,
} from '../../account-ai-state/account-ai-state.service.js';
import { AiAccessService } from '../../ai-access/ai-access.service.js';
import { AiChatTagsService } from '../../ai-chat/ai-chat-tags.service.js';
import { MessagingService } from '../../messaging/messaging.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RealtimeService } from '../../realtime/realtime.service.js';
import { SessionCryptoService } from '../../telegram/session-crypto.service.js';

/** Enrichment is resolved once per event and reused for this window. */
export const N8N_CONTEXT_TTL_MS = 10_000;
/** Upper bound of each cache map; the oldest key is evicted first. */
const CACHE_LIMIT = 2_000;

/** Account identity of one event; `phone` is the decrypted number. */
export interface N8nAccountBlock {
  id: string;
  title: string;
  firstName: string;
  lastName: string | null;
  /** The account's own @username, not the peer's. */
  username: string | null;
  phone: string | null;
  /** `BigInt` does not survive JSON, so the id is a string. */
  tgUserId: string;
  workflowId: string | null;
  variables: Record<string, unknown>;
  soul: N8nSoulSummary | null;
}

export interface N8nSoulSummary {
  name: string;
  mode: string;
  temperature: number;
}

/** Derived AI permissions of one chat/topic (the REST access view subset). */
export interface N8nAccessBlock {
  allowed: boolean;
  blocked: boolean;
  warnings: number;
  reason: string | null;
}

/** Chat identity as Telegram reports it; all fields degrade to safe values. */
export interface N8nChatIdentity {
  title: string;
  username: string | null;
  type: string;
}

/** Chat block of the enriched event payload. */
export interface N8nChatBlock extends N8nChatIdentity {
  id: number;
  threadId: number;
  tags: string[];
  access: N8nAccessBlock;
}

interface Cached<T> {
  at: number;
  value: T;
}

interface AccountRow {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  tgUserId: bigint;
  workflowId: string | null;
  aiVariables: string;
  phoneEncrypted: Uint8Array | null;
  phoneNonce: Uint8Array | null;
  phoneTag: Uint8Array | null;
  soul: N8nSoulSummary | null;
}

function displayTitle(firstName: string, lastName: string | null): string {
  const title = [firstName, lastName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ');
  return title || firstName || '';
}

/**
 * Resolves the context blocks of an n8n event: who sent it (account) and where
 * (chat, tags, access). Every answer is cached for
 * {@link N8N_CONTEXT_TTL_MS}, so one burst of messages costs one query per
 * account and one per chat instead of one per event.
 *
 * Chat identity needs Telegram (`getChat`), so failures there never fail the
 * event: the block degrades to empty title/`unknown` type. Nothing here reads
 * or returns media bytes.
 */
@Injectable()
export class N8nContextService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(N8nContextService.name);
  private readonly accounts = new Map<string, Cached<N8nAccountBlock | null>>();
  private readonly chats = new Map<string, Cached<N8nChatBlock>>();
  private readonly identities = new Map<string, Cached<N8nChatIdentity>>();
  private subscription?: Subscription;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
    private readonly messaging: MessagingService,
    private readonly tags: AiChatTagsService,
    private readonly access: AiAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Variables and per-chat settings are written by `AccountAiStateService` on
   * both surfaces; its bus event drops the affected cache entries at once
   * instead of waiting out {@link N8N_CONTEXT_TTL_MS}.
   */
  onModuleInit(): void {
    this.subscription = this.realtime.events$.subscribe((event) => {
      if (event.event !== AI_STATE_CHANGED) return;
      const payload = event.payload as {
        accountId?: unknown;
        chatId?: unknown;
      } | null;
      const accountId = payload?.accountId;
      if (typeof accountId !== 'string') return;
      this.invalidateAccount(accountId);
      const chatId =
        typeof payload?.chatId === 'number' ? payload.chatId : null;
      if (chatId !== null) this.invalidateChat(accountId, chatId);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  /** Account block of an event; `null` when the account row is gone. */
  async account(accountId: string): Promise<N8nAccountBlock | null> {
    const cached = this.accounts.get(accountId);
    if (cached && Date.now() - cached.at < N8N_CONTEXT_TTL_MS) {
      return cached.value;
    }
    let value: N8nAccountBlock | null = null;
    try {
      const row = (await this.prisma.telegramAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          tgUserId: true,
          workflowId: true,
          aiVariables: true,
          phoneEncrypted: true,
          phoneNonce: true,
          phoneTag: true,
          soul: { select: { name: true, mode: true, temperature: true } },
        },
      })) as AccountRow | null;
      value = row ? this.toAccountBlock(row) : null;
    } catch (error) {
      this.logger.warn(
        `Could not resolve the n8n account block: ${(error as Error).message}`,
      );
      value = null;
    }
    this.remember(this.accounts, accountId, value);
    return value;
  }

  /** Chat block of an event; `null` when the event carries no chat id. */
  async chat(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<N8nChatBlock | null> {
    if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
    const thread = Number.isSafeInteger(threadId) && threadId > 0 ? threadId : 0;
    const key = `${accountId}:${chatId}:${thread}`;
    const cached = this.chats.get(key);
    if (cached && Date.now() - cached.at < N8N_CONTEXT_TTL_MS) {
      return cached.value;
    }

    const [identity, tags, access] = await Promise.all([
      this.identity(userId, accountId, chatId),
      this.tagsOf(accountId, chatId),
      this.accessOf(userId, accountId, chatId, thread),
    ]);
    const value: N8nChatBlock = {
      id: chatId,
      threadId: thread,
      ...identity,
      tags,
      access,
    };
    this.remember(this.chats, key, value);
    return value;
  }

  /** Drops the cached chat context so the next event re-reads tags/access. */
  invalidateChat(accountId: string, chatId: number | null): void {
    if (chatId === null) return;
    const prefix = `${accountId}:${chatId}:`;
    for (const key of this.chats.keys()) {
      if (key.startsWith(prefix)) this.chats.delete(key);
    }
  }

  /** Drops the cached account block (e.g. after variables were patched). */
  invalidateAccount(accountId: string): void {
    this.accounts.delete(accountId);
  }

  /**
   * Parsed per-chat overrides of one chat/topic, falling back to the
   * whole-chat row. Read-only: the AI layer owns writes.
   */
  async chatSettings(
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<Record<string, unknown>> {
    const thread = Number.isSafeInteger(threadId) && threadId > 0 ? threadId : 0;
    const rows = (await this.prisma.aiChatSetting.findMany({
      where: {
        accountId,
        chatId: BigInt(chatId),
        threadId: { in: thread > 0 ? [thread, 0] : [0] },
      },
      orderBy: { threadId: 'desc' },
      select: { threadId: true, settings: true },
    })) as Array<Pick<AiChatSettingModel, 'threadId' | 'settings'>>;
    const row = rows.find((entry) => entry.threadId === thread) ?? rows[0];
    return parseJsonObject(row?.settings ?? null);
  }

  private toAccountBlock(row: AccountRow): N8nAccountBlock {
    return {
      id: row.id,
      title: displayTitle(row.firstName, row.lastName),
      firstName: row.firstName,
      lastName: row.lastName,
      username: row.username,
      phone: this.decryptPhone(row),
      tgUserId: row.tgUserId.toString(),
      workflowId: row.workflowId,
      variables: parseJsonObject(row.aiVariables),
      soul: row.soul
        ? {
            name: row.soul.name,
            mode: row.soul.mode,
            temperature: row.soul.temperature,
          }
        : null,
    };
  }

  /** Same envelope/AAD as `AccountsService`: `phone:<accountId>`. */
  private decryptPhone(row: AccountRow): string | null {
    if (!row.phoneEncrypted || !row.phoneNonce || !row.phoneTag) return null;
    try {
      const envelope = this.crypto.deserialize(row.phoneEncrypted);
      const phone = this.crypto
        .decrypt(envelope, `phone:${row.id}`)
        .toString('utf8');
      if (!phone) return null;
      return phone.startsWith('+') ? phone : `+${phone}`;
    } catch {
      return null;
    }
  }

  /** Chat title/username/type, cached separately from tags/access. */
  private async identity(
    userId: string,
    accountId: string,
    chatId: number,
  ): Promise<N8nChatIdentity> {
    const key = `${accountId}:${chatId}`;
    const cached = this.identities.get(key);
    if (cached && Date.now() - cached.at < N8N_CONTEXT_TTL_MS) {
      return cached.value;
    }
    let value: N8nChatIdentity = {
      title: '',
      username: null,
      type: 'unknown',
    };
    try {
      const chat = await this.messaging.getChat(
        userId,
        accountId,
        String(chatId),
      );
      value = {
        title: chat.title,
        username: chat.username,
        type: chat.type,
      };
    } catch {
      // A chat Telegram no longer knows must not drop the event.
    }
    this.remember(this.identities, key, value);
    return value;
  }

  private async tagsOf(accountId: string, chatId: number): Promise<string[]> {
    try {
      return await this.tags.list(accountId, chatId);
    } catch {
      return [];
    }
  }

  private async accessOf(
    userId: string,
    accountId: string,
    chatId: number,
    threadId: number,
  ): Promise<N8nAccessBlock> {
    try {
      const view = await this.access.view(userId, accountId, chatId, threadId);
      return {
        allowed: view.allowed,
        blocked: view.blocked,
        warnings: view.warnings,
        reason: view.reason,
      };
    } catch {
      return { allowed: false, blocked: false, warnings: 0, reason: null };
    }
  }

  private remember<T>(map: Map<string, Cached<T>>, key: string, value: T): void {
    map.set(key, { at: Date.now(), value });
    while (map.size > CACHE_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
