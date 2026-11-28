import { Injectable } from '@nestjs/common';
import { apiError, forbidden, notFound } from '../common/api-error.js';
import { emitLog } from '../logs/log-sink.js';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import type { VoiceUploadInput } from '../messaging/messaging.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EveMediaService } from './eve-media.service.js';
import {
  dryRunMessageView,
  eveDryRunEnabled,
  eveDryRunRequested,
  noteEveDryRunOutbound,
} from './eve-dry-run.js';
import { busyNow, decideOnline, parseBusySchedule } from './eve-presence.js';
import {
  eveDate,
  eveId,
  parseChatId,
  parseThreadId,
  withChatId,
  withChatIds,
  type EveAddress,
} from './eve-access.js';
import { dedupeBubbles, splitBubbles } from './eve-text.js';
import { stripMemoryNoise } from './eve-memory-lifecycle.service.js';

const BUBBLE_PAUSE_MIN_MS = 400;
const BUBBLE_PAUSE_MAX_MS = 1800;

/** Human pause before a bubble; the first one is immediate. */
export function bubblePauseMs(index: number, text: string): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  const override = Number(process.env.EVE_BUBBLE_PAUSE_MS);
  if (
    process.env.EVE_BUBBLE_PAUSE_MS !== undefined &&
    Number.isFinite(override)
  ) {
    if (override <= 0) return 0;
    return Math.min(
      BUBBLE_PAUSE_MAX_MS,
      Math.max(BUBBLE_PAUSE_MIN_MS, Math.round(override)),
    );
  }
  const chars = typeof text === 'string' ? text.trim().length : 0;
  return Math.min(BUBBLE_PAUSE_MAX_MS, BUBBLE_PAUSE_MIN_MS + chars * 20);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

/**
 * Old Eve captures could include reasoning and `[internal: …]` frames. They
 * are not conversation and must not become session-log rows that the day
 * miner later turns into "facts".
 */
const CAPTURE_NOISE_LINE =
  /^(?:the user|i should|i need|let me|content:|good\s*[—-]|okay,|hmm,|maybe:|now the deleted|the deleted text was|keep it short|avoid lists|no period)/i;

function captureLine(value: unknown): string {
  return text(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !CAPTURE_NOISE_LINE.test(line) &&
        !/\[internal:|reasoning_content/i.test(line),
    )
    .join('\n')
    .trim();
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function probability(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

/** Budget for one voice transcription: Eve must never hang a turn on STT. */
const TRANSCRIBE_TIMEOUT_MS = 20_000;
/** Transcript ceiling; the channel truncates for the prompt on its own. */
const MAX_TRANSCRIPT_CHARS = 4_000;

/**
 * Races a task against a deadline. The losing task is not cancelled (TDLib has
 * no abort), but the caller stops waiting, which is what a turn needs.
 */
function withTimeout<T>(
  task: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function requiredMessageId(body: Record<string, unknown>): string {
  const raw = body.messageId;
  if (raw === undefined || raw === null || raw === '') {
    throw apiError('EVE_MESSAGE_REQUIRED', 'messageId is required');
  }
  return String(raw);
}

export interface EveScope {
  personaId: string;
  accountId: string;
  chatId: bigint;
  threadId: number;
  mode: 'shared' | 'isolated';
  scopeKey: string;
}

export function localHour(timezone: string): number {
  return localClock(timezone).hour;
}

export function localClock(timezone: string): {
  hour: number;
  minute: number;
  weekday: string;
} {
  const fallback = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(fallback);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const weekdayRaw = parts.find((part) => part.type === 'weekday')?.value ?? '';
    const map: Record<string, string> = {
      Sun: 'sun',
      Mon: 'mon',
      Tue: 'tue',
      Wed: 'wed',
      Thu: 'thu',
      Fri: 'fri',
      Sat: 'sat',
    };
    return {
      hour: Number.isFinite(hour) ? hour % 24 : fallback.getHours(),
      minute: Number.isFinite(minute) ? minute : fallback.getMinutes(),
      weekday: map[weekdayRaw.slice(0, 3)] ?? 'mon',
    };
  } catch {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return {
      hour: fallback.getHours(),
      minute: fallback.getMinutes(),
      weekday: days[fallback.getDay()] ?? 'mon',
    };
  }
}

export function isSleeping(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** YYYY-MM-DD in the persona timezone. */
export function localDate(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

@Injectable()
export class EveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly users: DefaultUserService,
    private readonly media: EveMediaService,
  ) {}

  // ---------------------------------------------------------------------
  // Validation + allowlist
  // ---------------------------------------------------------------------

  private async assertPersona(personaId: string): Promise<void> {
    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      select: { id: true },
    });
    if (!persona) {
      throw notFound('EVE_PERSONA_NOT_FOUND', 'Eve persona not found');
    }
  }

  private async assertAccount(accountId: string): Promise<void> {
    const user = await this.users.get();
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId: user.id },
      select: { id: true },
    });
    if (!account) {
      throw notFound('EVE_ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
  }

  private async assertBound(
    personaId: string,
    accountId: string,
  ): Promise<void> {
    const link = await this.prisma.evePersonaAccount.findUnique({
      where: { personaId_accountId: { personaId, accountId } },
      select: { enabled: true },
    });
    if (link?.enabled !== true) {
      throw apiError(
        'EVE_ACCOUNT_NOT_BOUND',
        'Telegram account is not bound to this persona',
      );
    }
  }

  private async assertAddress(
    personaId: string,
    accountId: string,
  ): Promise<void> {
    await this.assertPersona(personaId);
    await this.assertAccount(accountId);
    await this.assertBound(personaId, accountId);
  }

  /**
   * Resolves the persona an action belongs to. Eve addresses a session as
   * `personaId:accountId:chatId`; older channel payloads omit `personaId`, so
   * the persona is inferred from the enabled bindings. With several personas
   * on one account, exactly one of them must allow the target chat; anything
   * else is a 400/403 instead of a guess.
   */
  private async resolvePersona(
    rawPersonaId: unknown,
    accountId: string,
    chatId: bigint | null,
    threadId: number,
  ): Promise<string> {
    const given =
      typeof rawPersonaId === 'string' || typeof rawPersonaId === 'number'
        ? String(rawPersonaId).trim()
        : '';
    if (given) {
      await this.assertPersona(given);
      await this.assertBound(given, accountId);
      return given;
    }

    const links = await this.prisma.evePersonaAccount.findMany({
      where: { accountId, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { personaId: true },
    });
    if (links.length === 0) {
      throw apiError(
        'EVE_PERSONA_NOT_BOUND',
        'No enabled Eve persona is bound to this account',
      );
    }
    if (links.length === 1) return links[0]!.personaId;

    const candidates = links.map((link) => link.personaId);
    const allowedRows = await this.prisma.eveChatBinding.findMany({
      where: {
        accountId,
        personaId: { in: candidates },
        allowed: true,
        ...(chatId !== null ? { chatId, threadId } : {}),
      },
      select: { personaId: true },
    });
    const allowedPersonas = [...new Set(allowedRows.map((row) => row.personaId))];
    if (allowedPersonas.length === 1) return allowedPersonas[0]!;
    if (allowedPersonas.length === 0) {
      throw forbidden(
        'EVE_CHAT_NOT_ALLOWED',
        'Chat is not on the Eve allowlist for any bound persona',
      );
    }
    throw apiError(
      'EVE_PERSONA_REQUIRED',
      'personaId is required: several personas allow this chat',
    );
  }

  /**
   * The single write gate: a chat may be touched only when the explicit
   * `EveChatBinding` row for `(personaId, accountId, chatId, threadId)` is
   * `allowed`. Reads are deliberately not gated by this method.
   */
  async requireAllowed(address: EveAddress): Promise<void> {
    const binding = await this.prisma.eveChatBinding.findUnique({
      where: {
        personaId_accountId_chatId_threadId: {
          personaId: address.personaId,
          accountId: address.accountId,
          chatId: address.chatId,
          threadId: address.threadId,
        },
      },
      select: { allowed: true },
    });
    if (binding?.allowed !== true) {
      throw forbidden(
        'EVE_CHAT_NOT_ALLOWED',
        'Chat is not on the Eve allowlist for this persona',
      );
    }
  }

  /** Validates and gates any action that talks to Telegram. */
  private async writeAddress(raw: unknown): Promise<EveAddress> {
    const body = record(raw);
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    await this.assertAccount(accountId);
    const chatId = parseChatId(body.chatId);
    const threadId = parseThreadId(body.threadId);
    const address: EveAddress = {
      personaId: await this.resolvePersona(
        body.personaId,
        accountId,
        chatId,
        threadId,
      ),
      accountId,
      chatId,
      threadId,
    };
    await this.requireAllowed(address);
    return address;
  }

  /**
   * Public address gate for the durable delayed-action queue. The queue lives
   * in Nest, so it reuses exactly the same persona/account/allowlist checks as
   * an immediate action.
   */
  async resolveWriteAddress(raw: unknown): Promise<EveAddress> {
    return this.writeAddress(raw);
  }

  // ---------------------------------------------------------------------
  // Personas and bindings
  // ---------------------------------------------------------------------

  async listPersonas() {
    return this.prisma.evePersona.findMany({
      orderBy: { createdAt: 'asc' },
      include: { accounts: true, docs: true },
    });
  }

  async getPersona(id: string) {
    const personaId = eveId(id, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      include: { accounts: true, docs: true },
    });
    if (!persona) {
      throw notFound('EVE_PERSONA_NOT_FOUND', 'Eve persona not found');
    }
    return persona;
  }

  async createPersona(raw: unknown) {
    const body = record(raw);
    const name = text(body.name);
    if (!name) {
      throw apiError('EVE_NAME_REQUIRED', 'name is required');
    }
    return this.prisma.evePersona.create({
      data: {
        name,
        age: integer(body.age, 22),
        nationality: text(body.nationality, 'RU'),
        timezone: text(body.timezone, 'Europe/Moscow'),
        stage: text(body.stage, 'tg-given-warming'),
        mode: text(body.mode, 'auto'),
        sleepFrom: integer(body.sleepFrom, 23),
        sleepTo: integer(body.sleepTo, 8),
        nightWakeChance: probability(body.nightWakeChance, 0.05),
        ignoreTendency: integer(body.ignoreTendency, 35),
        communication:
          body.communication === undefined
            ? '{}'
            : JSON.stringify(body.communication),
        busySchedule:
          body.busySchedule === undefined || body.busySchedule === null
            ? null
            : JSON.stringify(body.busySchedule),
        vibe: text(body.vibe) || null,
      },
    });
  }

  async updatePersona(id: string, raw: unknown) {
    const personaId = eveId(id, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const body = record(raw);
    await this.assertPersona(personaId);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = text(body.name);
      if (!name) throw apiError('EVE_NAME_REQUIRED', 'name must not be empty');
      data.name = name;
    }
    for (const key of [
      'nationality',
      'timezone',
      'stage',
      'mode',
      'vibe',
    ] as const) {
      if (body[key] !== undefined) data[key] = text(body[key]);
    }
    for (const key of [
      'age',
      'sleepFrom',
      'sleepTo',
      'ignoreTendency',
    ] as const) {
      if (body[key] !== undefined) data[key] = integer(body[key], 0);
    }
    if (body.nightWakeChance !== undefined) {
      data.nightWakeChance = probability(body.nightWakeChance, 0.05);
    }
    if (body.communication !== undefined) {
      data.communication = JSON.stringify(body.communication);
    }
    if (body.busySchedule !== undefined) {
      data.busySchedule =
        body.busySchedule === null
          ? null
          : JSON.stringify(body.busySchedule);
    }
    return this.prisma.evePersona.update({ where: { id: personaId }, data });
  }

  async bindAccount(personaId: string, raw: unknown) {
    const body = record(raw);
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    await this.assertPersona(id);
    await this.assertAccount(accountId);
    const mode = text(body.relationshipMode, 'isolated');
    if (mode !== 'shared' && mode !== 'isolated') {
      throw apiError(
        'EVE_RELATIONSHIP_MODE_INVALID',
        'relationshipMode must be shared or isolated',
      );
    }
    return this.prisma.evePersonaAccount.upsert({
      where: { personaId_accountId: { personaId: id, accountId } },
      create: {
        personaId: id,
        accountId,
        relationshipMode: mode,
        enabled: bool(body.enabled, true),
      },
      update: {
        relationshipMode: mode,
        enabled: bool(body.enabled, true),
      },
    });
  }

  async unbindAccount(personaId: string, accountId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const account = eveId(
      accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const removed = await this.prisma.evePersonaAccount.deleteMany({
      where: { personaId: id, accountId: account },
    });
    return { ok: true, removed: removed.count > 0 };
  }

  async listChats(personaId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    const rows = await this.prisma.eveChatBinding.findMany({
      where: { personaId: id },
      orderBy: { updatedAt: 'desc' },
    });
    return withChatIds(rows);
  }

  async allowChat(personaId: string, raw: unknown) {
    const body = record(raw);
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(body.chatId);
    const threadId = parseThreadId(body.threadId);
    await this.assertAddress(id, accountId);
    const row = await this.prisma.eveChatBinding.upsert({
      where: {
        personaId_accountId_chatId_threadId: {
          personaId: id,
          accountId,
          chatId,
          threadId,
        },
      },
      create: {
        personaId: id,
        accountId,
        chatId,
        threadId,
        allowed: bool(body.allowed, true),
        note: text(body.note) || null,
      },
      update: {
        allowed: bool(body.allowed, true),
        note: text(body.note) || null,
      },
    });
    return withChatId(row);
  }

  // ---------------------------------------------------------------------
  // Context and relationship state
  // ---------------------------------------------------------------------

  async scope(
    personaId: string,
    accountId: string,
    rawChatId: unknown,
    threadId = 0,
  ): Promise<EveScope> {
    const persona = eveId(
      personaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const account = eveId(
      accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(rawChatId);
    const thread = parseThreadId(threadId);
    const binding = await this.prisma.evePersonaAccount.findUnique({
      where: { personaId_accountId: { personaId: persona, accountId: account } },
      select: { relationshipMode: true },
    });
    const mode = binding?.relationshipMode === 'shared' ? 'shared' : 'isolated';
    return {
      personaId: persona,
      accountId: account,
      chatId,
      threadId: thread,
      mode,
      scopeKey:
        mode === 'shared'
          ? `peer:${chatId.toString()}`
          : `account:${account}:chat:${chatId.toString()}`,
    };
  }

  async context(
    personaId: string,
    accountId: string,
    rawChatId: unknown,
    threadId: unknown = 0,
  ) {
    const thread = parseThreadId(threadId);
    const scope = await this.scope(personaId, accountId, rawChatId, thread);
    await this.assertAddress(scope.personaId, scope.accountId);
    const user = await this.users.get();
    const persona = await this.getPersona(scope.personaId);
    const chat = await this.prisma.eveChatBinding.findUnique({
      where: {
        personaId_accountId_chatId_threadId: {
          personaId: scope.personaId,
          accountId: scope.accountId,
          chatId: scope.chatId,
          threadId: scope.threadId,
        },
      },
    });
    const relationship = await this.relationshipFor(scope);
    const conflict = await this.getConflict(
      scope.personaId,
      scope.accountId,
      scope.chatId,
    );
    const daily = await this.prisma.eveDailyLife.findUnique({
      where: {
        personaId_date: {
          personaId: scope.personaId,
          date: localDate(persona.timezone),
        },
      },
      select: { date: true, json: true },
    });
    let day: unknown = null;
    if (daily) {
      try {
        day = JSON.parse(daily.json) as unknown;
      } catch {
        day = null;
      }
    }
    // History is a prompt input, not the turn itself. A Telegram hiccup (or a
    // test chat that exists only in the local allowlist) must degrade to "no
    // history" instead of failing the persona instructions and behavior gate.
    let history: Awaited<ReturnType<MessagingService['listMessages']>>;
    try {
      history = await this.messaging.listMessages(
        user.id,
        scope.accountId,
        scope.chatId.toString(),
        { limit: 40 },
      );
    } catch {
      history = { messages: [], nextOffsetId: null };
    }
    return {
      persona,
      scope: withChatId(scope),
      chat: chat ? withChatId(chat) : null,
      relationship,
      conflict,
      history,
      dailyLife: day && daily ? { date: daily.date, day } : null,
    };
  }

  async relationshipFor(scope: EveScope) {
    return this.prisma.eveRelationship.upsert({
      where: {
        personaId_scopeKey: {
          personaId: scope.personaId,
          scopeKey: scope.scopeKey,
        },
      },
      create: {
        personaId: scope.personaId,
        scopeKey: scope.scopeKey,
      },
      update: {},
    });
  }

  async getRelationship(
    personaId: string,
    rawAccountId: string,
    rawChatId: unknown,
  ) {
    const scope = await this.scope(personaId, rawAccountId, rawChatId);
    await this.assertAddress(scope.personaId, scope.accountId);
    return this.relationshipFor(scope);
  }

  async updateRelationship(
    personaId: string,
    rawAccountId: string,
    rawChatId: unknown,
    raw: unknown,
  ) {
    const body = record(raw);
    const threadId = parseThreadId(body.threadId);
    const scope = await this.scope(personaId, rawAccountId, rawChatId, threadId);
    await this.assertAddress(scope.personaId, scope.accountId);
    await this.requireAllowed({
      personaId: scope.personaId,
      accountId: scope.accountId,
      chatId: scope.chatId,
      threadId,
    });
    const current = await this.relationshipFor(scope);
    const data: Record<string, unknown> = {};
    for (const key of [
      'interest',
      'trust',
      'attraction',
      'annoyance',
      'cringe',
    ] as const) {
      if (body[key] !== undefined) {
        data[key] = Math.max(-100, Math.min(100, integer(body[key], 0)));
      }
    }
    if (body.stage !== undefined) data.stage = text(body.stage);
    if (body.notes !== undefined) data.notes = text(body.notes);
    const updated = await this.prisma.eveRelationship.update({
      where: { id: current.id },
      data,
    });
    if (body.event !== undefined) {
      await this.prisma.eveRelationshipEvent.create({
        data: {
          relationshipId: current.id,
          kind: text(body.eventKind, 'note'),
          text: text(body.event),
        },
      });
    }
    return updated;
  }

  /**
   * Silent mood change without a turn (negative reaction emoji). It never
   * counts an incoming message, never logs a turn and never moves the stage:
   * exactly the reference's "silent-mood" path.
   */
  async applyMood(personaId: string, raw: unknown) {
    const body = record(raw);
    const threadId = parseThreadId(body.threadId);
    const scope = await this.scope(
      personaId,
      text(body.accountId),
      body.chatId,
      threadId,
    );
    await this.assertAddress(scope.personaId, scope.accountId);
    await this.requireAllowed({
      personaId: scope.personaId,
      accountId: scope.accountId,
      chatId: scope.chatId,
      threadId,
    });
    const relationship = await this.relationshipFor(scope);
    const delta = record(body.moodDelta);
    const data: Record<string, number> = {};
    for (const key of [
      'interest',
      'trust',
      'attraction',
      'annoyance',
      'cringe',
    ] as const) {
      const change = Number(delta[key]);
      if (!Number.isFinite(change) || change === 0) continue;
      data[key] = Math.max(
        -100,
        Math.min(100, relationship[key] + integer(change, 0)),
      );
    }
    if (Object.keys(data).length === 0) return relationship;
    return this.prisma.eveRelationship.update({
      where: { id: relationship.id },
      data,
    });
  }

  async getConflict(
    personaId: string,
    rawAccountId: string,
    rawChatId: unknown,
  ) {    const relationship = await this.getRelationship(
      personaId,
      rawAccountId,
      rawChatId,
    );
    return this.prisma.eveConflict.upsert({
      where: { relationshipId: relationship.id },
      create: { relationshipId: relationship.id },
      update: {},
    });
  }

  async updateConflict(
    personaId: string,
    rawAccountId: string,
    rawChatId: unknown,
    raw: unknown,
  ) {
    const body = record(raw);
    const threadId = parseThreadId(body.threadId);
    const scope = await this.scope(personaId, rawAccountId, rawChatId, threadId);
    await this.assertAddress(scope.personaId, scope.accountId);
    await this.requireAllowed({
      personaId: scope.personaId,
      accountId: scope.accountId,
      chatId: scope.chatId,
      threadId,
    });
    const relationship = await this.relationshipFor(scope);
    const conflict = await this.prisma.eveConflict.upsert({
      where: { relationshipId: relationship.id },
      create: { relationshipId: relationship.id },
      update: {},
    });
    const level = Math.max(0, Math.min(4, integer(body.level, conflict.level)));
    return this.prisma.eveConflict.update({
      where: { id: conflict.id },
      data: {
        level,
        coldUntil:
          body.coldUntil === null
            ? null
            : body.coldUntil === undefined
              ? conflict.coldUntil
              : eveDate(body.coldUntil),
        reason:
          body.reason === undefined ? conflict.reason : text(body.reason),
      },
    });
  }

  // ---------------------------------------------------------------------
  // Agenda
  // ---------------------------------------------------------------------

  async listAgenda(personaId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    const rows = await this.prisma.eveAgendaItem.findMany({
      where: { personaId: id },
      orderBy: { pingAt: 'asc' },
      take: 100,
    });
    return withChatIds(rows);
  }

  async createAgenda(personaId: string, raw: unknown) {
    const body = record(raw);
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(body.chatId);
    await this.assertAddress(id, accountId);
    await this.requireAllowed({ personaId: id, accountId, chatId, threadId: 0 });
    const row = await this.prisma.eveAgendaItem.create({
      data: {
        personaId: id,
        accountId,
        chatId,
        about: text(body.about, 'написать первой'),
        reason: text(body.reason),
        kind: text(body.kind, 'proactive-life'),
        importance: integer(body.importance, 1),
        pingAt: body.pingAt ? eveDate(body.pingAt) : new Date(),
      },
    });
    return withChatId(row);
  }

  async updateAgenda(id: string, raw: unknown) {
    const agendaId = eveId(id, 'EVE_AGENDA_REQUIRED', 'agenda id is required');
    const body = record(raw);
    const current = await this.prisma.eveAgendaItem.findUnique({
      where: { id: agendaId },
      select: {
        id: true,
        personaId: true,
        accountId: true,
        chatId: true,
      },
    });
    if (!current) {
      throw notFound('EVE_AGENDA_NOT_FOUND', 'Eve agenda item not found');
    }
    await this.requireAllowed({
      personaId: current.personaId,
      accountId: current.accountId,
      chatId: current.chatId,
      threadId: 0,
    });
    const data: Record<string, unknown> = {};
    if (body.state !== undefined) data.state = text(body.state);
    if (body.pingAt !== undefined) data.pingAt = eveDate(body.pingAt);
    if (body.about !== undefined) data.about = text(body.about);
    if (body.reason !== undefined) data.reason = text(body.reason);
    if (body.importance !== undefined) {
      data.importance = integer(body.importance, 1);
    }
    const row = await this.prisma.eveAgendaItem.update({
      where: { id: agendaId },
      data,
    });
    return withChatId(row);
  }

  // ---------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------

  async recall(personaId: string, raw: unknown) {
    const body = record(raw);
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    const query = text(body.query);
    const scopeKey = text(body.scopeKey);
    const relationship = scopeKey
      ? await this.prisma.eveRelationship.findUnique({
          where: { personaId_scopeKey: { personaId: id, scopeKey } },
        })
      : null;
    const facts = await this.prisma.eveMemoryFact.findMany({
      where: {
        personaId: id,
        OR: [
          { relationshipId: relationship?.id ?? '__none__' },
          { relationshipId: null },
        ],
        ...(query
          ? { content: { contains: query.slice(0, 80) } }
          : {}),
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: 8,
    });
    const daily = await this.prisma.eveMemoryDaily.findMany({
      where: { personaId: id },
      orderBy: { date: 'desc' },
      take: 3,
    });
    const palace = await this.prisma.evePalaceDrawer.findMany({
      where: {
        personaId: id,
        ...(query
          ? {
              OR: [
                { content: { contains: query.slice(0, 80) } },
                { keywords: { contains: query.slice(0, 80) } },
              ],
            }
          : {}),
      },
      orderBy: [{ salience: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });
    const messages: Array<{ id: string; content: string }> = [];
    if (relationship) {
      messages.push({
        id: `relationship:${relationship.id}`,
        content: `stage=${relationship.stage}; interest=${relationship.interest}; trust=${relationship.trust}; attraction=${relationship.attraction}; annoyance=${relationship.annoyance}; cringe=${relationship.cringe}`,
      });
    }
    for (const fact of facts) {
      messages.push({ id: `fact:${fact.id}`, content: fact.content });
    }
    for (const day of daily) {
      messages.push({ id: `daily:${day.id}`, content: day.markdown });
    }
    for (const drawer of palace) {
      messages.push({ id: `palace:${drawer.id}`, content: drawer.content });
    }
    return { messages };
  }

  async capture(personaId: string, raw: unknown) {
    const body = record(raw);
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(body.chatId);
    const threadId = parseThreadId(body.threadId);
    await this.assertAddress(id, accountId);
    await this.requireAllowed({ personaId: id, accountId, chatId, threadId });
    const day = text(body.day, new Date().toISOString().slice(0, 10));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const rows = messages
      .map((message) => {
        const item = record(message);
        const content = captureLine(item.content);
        if (!content) return null;
        return {
          personaId: id,
          accountId,
          chatId,
          threadId,
          day,
          line: `${text(item.role, 'user')}: ${content}`,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
    if (rows.length > 0) {
      await this.prisma.eveSessionLog.createMany({ data: rows });
    }
    return { captured: rows.length };
  }

  async addFact(personaId: string, raw: unknown) {
    const body = record(raw);
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required for memory writes',
    );
    const chatId = parseChatId(body.chatId);
    const threadId = parseThreadId(body.threadId);
    const content = stripMemoryNoise(text(body.content)).trim();
    if (!content) {
      throw apiError('EVE_CONTENT_REQUIRED', 'content is required');
    }
    await this.assertAddress(id, accountId);
    await this.requireAllowed({ personaId: id, accountId, chatId, threadId });
    const relationshipId = text(body.relationshipId) || null;
    if (relationshipId) {
      const relationship = await this.prisma.eveRelationship.findUnique({
        where: { id: relationshipId },
        select: { personaId: true },
      });
      if (relationship?.personaId !== id) {
        throw apiError(
          'EVE_RELATIONSHIP_NOT_FOUND',
          'Relationship does not belong to this persona',
        );
      }
    }
    return this.prisma.eveMemoryFact.create({
      data: {
        personaId: id,
        relationshipId,
        kind: text(body.kind, 'fact'),
        content,
        importance: integer(body.importance, 3),
        source: text(body.source, 'agent'),
      },
    });
  }

  async listFacts(personaId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    return this.prisma.eveMemoryFact.findMany({
      where: { personaId: id },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  async listMemoryDaily(personaId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    return this.prisma.eveMemoryDaily.findMany({
      where: { personaId: id },
      orderBy: { date: 'desc' },
      take: 60,
    });
  }

  async listPalace(personaId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    return this.prisma.evePalaceDrawer.findMany({
      where: { personaId: id },
      orderBy: [{ salience: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  async listSessions(personaId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    const rows = await this.prisma.eveSessionLog.findMany({
      where: { personaId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return withChatIds(rows);
  }

  async listStickers(personaId: string) {
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    return this.prisma.eveSticker.findMany({
      where: { personaId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async addSticker(personaId: string, raw: unknown) {
    const body = record(raw);
    const id = eveId(personaId, 'EVE_PERSONA_REQUIRED', 'personaId is required');
    await this.assertPersona(id);
    const fileId = text(body.fileId);
    if (!fileId) throw apiError('EVE_STICKER_REQUIRED', 'fileId is required');
    return this.prisma.eveSticker.upsert({
      where: { personaId_fileId: { personaId: id, fileId } },
      create: {
        personaId: id,
        fileId,
        emoji: text(body.emoji),
        tags: JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
      },
      update: {
        emoji: text(body.emoji),
        tags: JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
      },
    });
  }

  /**
   * Presence heartbeat: a stable pattern per persona (burst/evening/night/rare),
   * not "awake = online". Awake but offline is normal — she is busy or simply
   * not staring at the phone. Sleep always wins.
   */
  async presenceTick() {
    const user = await this.users.get();
    const links = await this.prisma.evePersonaAccount.findMany({
      where: { enabled: true },
      include: { persona: true },
      orderBy: { createdAt: 'asc' },
    });
    const results: Array<{
      personaId: string;
      accountId: string;
      online: boolean;
      awake: boolean;
      reason: string;
    }> = [];
    const now = new Date();
    // A cold conflict is per chat, but the online flag is per account. If any
    // relationship of the persona is in a cold conflict, she stays offline
    // instead of glowing green in the middle of a fight.
    const personaIds = [...new Set(links.map((link) => link.personaId))];
    const conflicts = personaIds.length
      ? await this.prisma.eveConflict.findMany({
          where: {
            coldUntil: { gt: now },
            relationship: { personaId: { in: personaIds } },
          },
          select: { relationship: { select: { personaId: true } } },
        })
      : [];
    const conflicted = new Set(
      conflicts.map((row) => row.relationship.personaId),
    );
    for (const link of links) {
      const persona = link.persona;
      const clock = localClock(persona.timezone);
      const asleep = isSleeping(
        clock.hour,
        persona.sleepFrom,
        persona.sleepTo,
      );
      const busy = asleep
        ? null
        : busyNow(
            parseBusySchedule(persona.busySchedule),
            clock.weekday,
            clock.hour * 60 + clock.minute,
          );
      const decision = decideOnline({
        personaId: link.personaId,
        hour: clock.hour,
        minute: clock.minute,
        weekday: clock.weekday,
        asleep,
        busy,
        conflict: conflicted.has(link.personaId),
        now: now.getTime(),
      });
      try {
        // The presence tick is a scheduled account-wide action, not a turn:
        // only the global kill-switch suppresses it. A per-turn `dryRun` does
        // not leak into it.
        if (eveDryRunEnabled()) {
          noteEveDryRunOutbound(
            'presence',
            link.accountId,
            0,
            `online=${decision.online} tick=true`,
            link.personaId,
          );
          results.push({
            personaId: link.personaId,
            accountId: link.accountId,
            online: decision.online,
            awake: !asleep,
            reason: 'dry-run',
          });
          continue;
        }
        await this.messaging.setOnline(user.id, link.accountId, decision.online);
        results.push({
          personaId: link.personaId,
          accountId: link.accountId,
          online: decision.online,
          awake: !asleep,
          reason: decision.reason,
        });
      } catch {
        results.push({
          personaId: link.personaId,
          accountId: link.accountId,
          online: false,
          awake: !asleep,
          reason: 'error',
        });
      }
    }

    // A deferred turn queued while she was asleep has `dueAt = null`: it waits
    // for a state change, not for a clock. Waking up releases it even when the
    // online flag happens to be off for this bucket.
    const awake = [...new Set(
      results.filter((row) => row.awake).map((row) => row.personaId),
    )];
    let released = 0;
    if (awake.length > 0) {
      const changed = await this.prisma.eveDelayedAction.updateMany({
        where: { personaId: { in: awake }, state: 'pending', dueAt: null },
        data: { dueAt: new Date() },
      });
      released = changed.count;
    }
    return { updated: results.length, released, results };
  }

  // ---------------------------------------------------------------------
  // Telegram transport (allowlist-gated)
  // ---------------------------------------------------------------------

  async sendText(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    const value = text(body.text);
    if (!value) {
      throw apiError('EVE_TEXT_REQUIRED', 'text is required');
    }
    const expected = Math.max(0, Math.trunc(Number(body.bubbles) || 0));
    const parts = Array.isArray(body.parts)
      ? body.parts.map((part) => text(part)).filter(Boolean)
      : dedupeBubbles(splitBubbles(value, expected));
    if (parts.length === 0) {
      throw apiError('EVE_TEXT_REQUIRED', 'text is required');
    }
    const ids: number[] = [];
    const dryRun = eveDryRunRequested(body);
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        const pause = bubblePauseMs(index, parts[index - 1] ?? '');
        if (pause > 0) await sleep(pause);
      }
      if (dryRun) {
        noteEveDryRunOutbound(
          'send',
          address.accountId,
          address.chatId,
          `text=${JSON.stringify(part)}`,
          address.personaId,
        );
        ids.push(dryRunMessageView(address.chatId, part).id);
        continue;
      }
      const message = await this.messaging.sendMessage(
        user.id,
        address.accountId,
        address.chatId.toString(),
        {
          text: part,
          replyToId: body.replyToId,
          quote: body.quote,
          typing: body.typing ?? 'auto',
        },
      );
      ids.push(message.id);
    }
    return { sent: ids.length > 0, messageIds: ids };
  }

  async sendMedia(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    const base64 = text(body.base64);
    if (!base64) {
      throw apiError('EVE_MEDIA_REQUIRED', 'base64 is required');
    }
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.byteLength === 0) {
      throw apiError('EVE_MEDIA_EMPTY', 'media payload is empty');
    }
    if (eveDryRunRequested(body)) {
      const caption = text(body.caption);
      noteEveDryRunOutbound(
        'media',
        address.accountId,
        address.chatId,
        `mime=${text(body.mimeType, 'application/octet-stream')} bytes=${buffer.byteLength} caption=${JSON.stringify(caption)}`,
        address.personaId,
      );
      return dryRunMessageView(address.chatId, caption);
    }
    return this.messaging.sendMedia(
      user.id,
      address.accountId,
      address.chatId.toString(),
      {
        buffer,
        fileName: text(body.fileName, 'file.bin'),
        mimeType: text(body.mimeType, 'application/octet-stream'),
        size: buffer.byteLength,
        caption: body.caption,
        replyToId: body.replyToId,
      },
    );
  }

  /**
   * Sends a recorded voice message through the media transport. OGG/Opus
   * becomes a real Telegram voice note; other audio becomes an audio file.
   */
  async sendVoice(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    const base64 = text(body.base64);
    if (!base64) throw apiError('EVE_MEDIA_REQUIRED', 'base64 is required');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.byteLength === 0) {
      throw apiError('EVE_MEDIA_EMPTY', 'media payload is empty');
    }
    if (eveDryRunRequested(body)) {
      const caption = text(body.caption);
      noteEveDryRunOutbound(
        'voice',
        address.accountId,
        address.chatId,
        `mime=${text(body.mimeType, 'audio/ogg')} bytes=${buffer.byteLength} caption=${JSON.stringify(caption)}`,
        address.personaId,
      );
      return dryRunMessageView(address.chatId, caption);
    }
    const input: VoiceUploadInput = {
      buffer,
      mimeType: text(body.mimeType, 'audio/ogg'),
      durationSec: body.durationSec,
      caption: body.caption,
      replyToId: body.replyToId,
    };
    return this.media.sendVoice(
      user.id,
      address.accountId,
      address.chatId.toString(),
      input,
    );
  }

  /** Sends one sticker by its Telegram file id. */
  async sendSticker(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    const fileId = text(body.fileId);
    if (!fileId) throw apiError('EVE_STICKER_REQUIRED', 'fileId is required');
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'sticker',
        address.accountId,
        address.chatId,
        `fileId=${fileId.slice(0, 64)}`,
        address.personaId,
      );
      return dryRunMessageView(address.chatId, '');
    }
    return this.media.sendSticker(
      user.id,
      address.accountId,
      address.chatId.toString(),
      fileId,
    );
  }

  /** Edits a message this persona's account already sent. */
  async editMessage(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    const messageId = requiredMessageId(body);
    const value = text(body.text);
    if (!value) throw apiError('EVE_TEXT_REQUIRED', 'text is required');
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'edit',
        address.accountId,
        address.chatId,
        `messageId=${messageId} text=${JSON.stringify(value)}`,
        address.personaId,
      );
      return { edited: true, messageId, dryRun: true };
    }
    return this.messaging.editMessage(
      user.id,
      address.accountId,
      address.chatId.toString(),
      messageId,
      { text: value },
    );
  }

  /** Deletes one message for everyone by default. */
  async deleteMessage(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    const messageId = requiredMessageId(body);
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'delete',
        address.accountId,
        address.chatId,
        `messageId=${messageId}`,
        address.personaId,
      );
      return { deleted: true, messageId, dryRun: true };
    }
    return this.messaging.deleteMessage(
      user.id,
      address.accountId,
      address.chatId.toString(),
      messageId,
      { revoke: body.revoke !== false },
    );
  }

  /** Sends or removes a reaction on a message. */
  async sendReaction(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    const messageId = requiredMessageId(body);
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'react',
        address.accountId,
        address.chatId,
        `messageId=${messageId} emoji=${JSON.stringify(text(body.emoji))}`,
        address.personaId,
      );
      return { reacted: true, messageId, dryRun: true };
    }
    return this.messaging.sendReaction(
      user.id,
      address.accountId,
      address.chatId.toString(),
      messageId,
      { emoji: body.emoji },
    );
  }

  /** Blocks the peer of an allowed Eve chat. */
  async blockContact(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'block',
        address.accountId,
        address.chatId,
        'peer block suppressed',
        address.personaId,
      );
      return { blocked: true, dryRun: true };
    }
    return this.media.blockContact(
      user.id,
      address.accountId,
      address.chatId.toString(),
    );
  }

  /** Unblocks the peer of an allowed Eve chat. */
  async unblockContact(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'unblock',
        address.accountId,
        address.chatId,
        'peer unblock suppressed',
        address.personaId,
      );
      return { blocked: false, dryRun: true };
    }
    return this.media.unblockContact(
      user.id,
      address.accountId,
      address.chatId.toString(),
    );
  }

  async typing(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'typing',
        address.accountId,
        address.chatId,
        `status=${text(body.status, 'typing')}`,
        address.personaId,
      );
      return { status: text(body.status, 'typing'), dryRun: true };
    }
    return this.messaging.sendTyping(
      user.id,
      address.accountId,
      address.chatId.toString(),
      { status: text(body.status, 'typing') },
    );
  }

  async read(raw: unknown) {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const user = await this.users.get();
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'read',
        address.accountId,
        address.chatId,
        `maxId=${String(body.maxId ?? '')}`,
        address.personaId,
      );
      return { read: true, dryRun: true };
    }
    return this.messaging.markRead(
      user.id,
      address.accountId,
      address.chatId.toString(),
      { maxId: body.maxId },
    );
  }

  /**
   * Transcript of an incoming voice note / audio / video note for the Eve
   * channel. The address is gated like every other Eve action (persona,
   * account, allowlist), but a failing engine is not an error: `{ text: null }`
   * lets the model answer the message anyway. The call is capped at
   * {@link TRANSCRIBE_TIMEOUT_MS} so a stuck TDLib/STT never holds the turn.
   */
  async transcribeVoice(raw: unknown): Promise<{ text: string | null }> {
    const body = record(raw);
    const address = await this.writeAddress(raw);
    const messageId = requiredMessageId(body);
    const user = await this.users.get();
    const started = Date.now();
    try {
      const result = await withTimeout(
        this.messaging.transcribeVoice(
          user.id,
          address.accountId,
          address.chatId.toString(),
          messageId,
        ),
        TRANSCRIBE_TIMEOUT_MS,
        `transcription timed out after ${TRANSCRIBE_TIMEOUT_MS} ms`,
      );
      const value = text(result?.text).slice(0, MAX_TRANSCRIPT_CHARS);
      if (!value) {
        emitLog({
          level: 'warn',
          source: 'messaging',
          action: 'eve.transcribe',
          message: `Voice note ${messageId} produced no text (pending=${result?.pending === true})`,
          status: 'failed',
          accountId: address.accountId,
          chatId: Number(address.chatId),
          durationMs: Date.now() - started,
          details: { messageId, pending: result?.pending === true },
        });
        return { text: null };
      }
      emitLog({
        level: 'debug',
        source: 'messaging',
        action: 'eve.transcribe',
        message: `Transcribed voice note ${messageId} (${value.length} chars)`,
        status: 'ok',
        accountId: address.accountId,
        chatId: Number(address.chatId),
        durationMs: Date.now() - started,
        details: { messageId, chars: value.length },
      });
      return { text: value };
    } catch (error) {
      emitLog({
        level: 'warn',
        source: 'messaging',
        action: 'eve.transcribe',
        message: `Voice note ${messageId} transcription failed: ${(error as Error).message}`,
        status: 'failed',
        accountId: address.accountId,
        chatId: Number(address.chatId),
        durationMs: Date.now() - started,
        details: { messageId, reason: (error as Error).message },
      });
      return { text: null };
    }
  }

  /**
   * Presence is account-wide, but an Eve persona may only change it when it
   * owns at least one allowed chat on that account. A `chatId` in the payload
   * narrows the check to that exact binding.
   */
  async presence(raw: unknown) {
    const body = record(raw);
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    await this.assertAccount(accountId);
    const chatId =
      body.chatId !== undefined && body.chatId !== null && body.chatId !== ''
        ? parseChatId(body.chatId)
        : null;
    const threadId = parseThreadId(body.threadId);
    const personaId = await this.resolvePersona(
      body.personaId,
      accountId,
      chatId,
      threadId,
    );
    if (chatId !== null) {
      await this.requireAllowed({
        personaId,
        accountId,
        chatId,
        threadId,
      });
    } else {
      const allowed = await this.prisma.eveChatBinding.findFirst({
        where: { personaId, accountId, allowed: true },
        select: { id: true },
      });
      if (!allowed) {
        throw forbidden(
          'EVE_CHAT_NOT_ALLOWED',
          'Persona has no allowed chat on this account',
        );
      }
    }
    const user = await this.users.get();
    // Presence is account-wide: the per-request flag (or the global
    // kill-switch) suppresses the flip for this call only.
    if (eveDryRunRequested(body)) {
      noteEveDryRunOutbound(
        'presence',
        accountId,
        chatId ?? 0,
        `online=${String(bool(body.online, true))}`,
        personaId,
      );
      return { online: bool(body.online, true), dryRun: true };
    }
    return this.messaging.setOnline(
      user.id,
      accountId,
      bool(body.online, true),
    );
  }

  async history(raw: unknown) {
    const body = record(raw);
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(body.chatId);
    await this.assertAccount(accountId);
    const user = await this.users.get();
    return this.messaging.listMessages(
      user.id,
      accountId,
      chatId.toString(),
      {
        limit: body.limit,
        offsetId: body.offsetId,
      },
    );
  }

  async personaForAccount(accountId: string) {
    return this.prisma.evePersonaAccount.findFirst({
      where: { accountId, enabled: true },
      include: { persona: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
