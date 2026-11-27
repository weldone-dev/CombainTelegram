import { Injectable } from '@nestjs/common';
import type { EveContextSnapshotModel } from '@repo/database';
import { apiError, notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseChatId, parseThreadId } from './eve-access.js';
import { eveDryRunApplies, takeEveDryRunOutbound } from './eve-dry-run.js';

/**
 * Real model context, captured by the Eve process and stored per turn.
 *
 * The Eve side does not reconstruct the prompt "by meaning": an
 * instrumentation provider receives the final AI SDK model input (instructions
 * and messages) of the first model call of the turn, and a `turn.settled` hook
 * posts it here. This service only validates, computes `chars`, dedupes a
 * retried turn and keeps the last N snapshots per chat.
 */

export type EveContextKind =
  | 'inbound'
  | 'proactive'
  | 'deletion'
  | 'reaction'
  | 'other';

const KINDS = new Set<string>([
  'inbound',
  'proactive',
  'deletion',
  'reaction',
  'other',
]);

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MESSAGE_KINDS = new Set([
  'memory',
  'internal',
  'incoming',
  'history',
  'tool',
]);

const DEFAULT_RETENTION = 50;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_SYSTEM_BLOCKS = 200;
const MAX_MESSAGES = 1_000;
const MAX_TEXT = 400_000;

export interface EveContextBlock {
  name: string;
  text: string;
  chars: number;
  tokens?: number;
}

export interface EveContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  kind?: 'memory' | 'internal' | 'incoming' | 'history' | 'tool';
  text: string;
  chars: number;
  tokens?: number;
}

export interface EveContextTokens {
  system?: number;
  messages?: number;
  total?: number;
  input?: number;
  output?: number;
}

export interface EveContextSnapshot {
  id: string;
  personaId: string;
  accountId: string;
  chatId: string;
  threadId: number;
  createdAt: string;
  model: string;
  kind: EveContextKind;
  turnId?: string;
  tokens: EveContextTokens;
  system: EveContextBlock[];
  messages: EveContextMessage[];
  meta?: Record<string, unknown>;
  dryRun: boolean;
}

export interface EveContextSnapshotQuery {
  personaId?: string;
  accountId?: string;
  chatId?: string;
  limit?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredId(value: unknown, code: string, message: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) throw apiError(code, message);
  return parsed;
}

/** Token count from a provider is kept as-is. */
function tokenNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.trunc(numeric)
    : undefined;
}

function clipText(value: unknown): string {
  const text = textOf(value);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/** Normalizes a `{name,text}` block and computes `chars` on the server. */
function blockOf(raw: unknown, index: number): EveContextBlock | null {
  const row = record(raw);
  const text = clipText(row.text);
  if (!text) return null;
  const name = textOf(row.name).trim() || `block-${index + 1}`;
  const tokens = tokenNumber(row.tokens);
  return {
    name,
    text,
    chars: text.length,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

function messageOf(raw: unknown): EveContextMessage | null {
  const row = record(raw);
  const text = clipText(row.text);
  if (!text) return null;
  const role = textOf(row.role);
  if (!ROLES.has(role)) return null;
  const kindValue = textOf(row.kind);
  const kind = MESSAGE_KINDS.has(kindValue)
    ? (kindValue as EveContextMessage['kind'])
    : undefined;
  const tokens = tokenNumber(row.tokens);
  return {
    role: role as EveContextMessage['role'],
    ...(kind ? { kind } : {}),
    text,
    chars: text.length,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

function tokensOf(raw: unknown): EveContextTokens {
  const row = record(raw);
  const tokens: EveContextTokens = {};
  for (const key of [
    'system',
    'messages',
    'total',
    'input',
    'output',
  ] as const) {
    const value = tokenNumber(row[key]);
    if (value !== undefined) tokens[key] = value;
  }
  return tokens;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseJsonArray(raw: string): unknown[] {
  const parsed = safeJson<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = safeJson<unknown>(raw, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** `chars` is always recomputed: the DB may hold an older shape. */
function normalizeBlock(raw: unknown, index: number): EveContextBlock | null {
  const row = record(raw);
  const text = textOf(row.text);
  if (!text) return null;
  const name = textOf(row.name).trim() || `block-${index + 1}`;
  const tokens = tokenNumber(row.tokens);
  return {
    name,
    text,
    chars: text.length,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

function normalizeMessage(raw: unknown): EveContextMessage | null {
  const row = record(raw);
  const text = textOf(row.text);
  const role = textOf(row.role);
  if (!text || !ROLES.has(role)) return null;
  const kindValue = textOf(row.kind);
  const kind = MESSAGE_KINDS.has(kindValue)
    ? (kindValue as EveContextMessage['kind'])
    : undefined;
  const tokens = tokenNumber(row.tokens);
  return {
    role: role as EveContextMessage['role'],
    ...(kind ? { kind } : {}),
    text,
    chars: text.length,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

function snapshotOf(row: EveContextSnapshotModel): EveContextSnapshot {
  const system = parseJsonArray(row.systemJson)
    .map((entry, index) => normalizeBlock(entry, index))
    .filter((entry): entry is EveContextBlock => entry !== null);
  const messages = parseJsonArray(row.messagesJson)
    .map((entry) => normalizeMessage(entry))
    .filter((entry): entry is EveContextMessage => entry !== null);
  const meta = parseJsonObject(row.metaJson);
  return {
    id: row.id,
    personaId: row.personaId,
    accountId: row.accountId,
    chatId: row.chatId.toString(),
    threadId: row.threadId,
    createdAt: row.createdAt.toISOString(),
    model: row.model,
    kind: (KINDS.has(row.kind) ? row.kind : 'other') as EveContextKind,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    tokens: tokensOf(parseJsonObject(row.tokensJson)),
    system,
    messages,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    dryRun: row.dryRun,
  };
}

/** `EVE_CONTEXT_SNAPSHOT_KEEP`: last N snapshots per chat (default 50). */
function retentionLimit(): number {
  const raw = Number(process.env.EVE_CONTEXT_SNAPSHOT_KEEP);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_RETENTION;
}

function listLimit(raw: string | undefined): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.trunc(numeric));
}

@Injectable()
export class EveContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `POST /internal/eve/context/snapshot`. Idempotent by
   * `(personaId, accountId, chatId, turnId)`: a retried turn returns the
   * existing row instead of writing a duplicate.
   */
  async ingest(raw: unknown): Promise<{ ok: true; snapshot: EveContextSnapshot; duplicate: boolean }> {
    const body = record(raw);
    const personaId = requiredId(
      body.personaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const accountId = requiredId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(body.chatId);
    const threadId = parseThreadId(body.threadId);
    const kindValue = textOf(body.kind);
    const kind: EveContextKind = KINDS.has(kindValue)
      ? (kindValue as EveContextKind)
      : 'other';
    const turnIdRaw = textOf(body.turnId).trim();
    const turnId = turnIdRaw ? turnIdRaw.slice(0, 256) : null;
    const model = textOf(body.model).trim().slice(0, 200);
    const system = (Array.isArray(body.system) ? body.system : [])
      .slice(0, MAX_SYSTEM_BLOCKS)
      .map((entry, index) => blockOf(entry, index))
      .filter((entry): entry is EveContextBlock => entry !== null);
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .slice(0, MAX_MESSAGES)
      .map((entry) => messageOf(entry))
      .filter((entry): entry is EveContextMessage => entry !== null);
    const tokens = tokensOf(body.tokens);
    const meta = record(body.meta);

    if (turnId) {
      const existing = await this.prisma.eveContextSnapshot.findFirst({
        where: { personaId, accountId, chatId, turnId },
      });
      if (existing) {
        return { ok: true, snapshot: snapshotOf(existing), duplicate: true };
      }
    }

    // The dry-run marker and the suppressed actions live in the API process:
    // the Eve turn itself does not know whether its send reached Telegram.
    const dryRun = eveDryRunApplies(accountId, chatId);
    const suppressed = takeEveDryRunOutbound(accountId, chatId, personaId);
    const metaJson = {
      ...meta,
      ...(dryRun ? { dryRun: true } : {}),
      ...(suppressed.length > 0 ? { suppressedOutbound: suppressed } : {}),
    };

    let row: EveContextSnapshotModel;
    try {
      row = await this.prisma.eveContextSnapshot.create({
        data: {
          personaId,
          accountId,
          chatId,
          threadId,
          kind,
          model,
          turnId,
          tokensJson: JSON.stringify(tokens),
          systemJson: JSON.stringify(system),
          messagesJson: JSON.stringify(messages),
          metaJson: JSON.stringify(metaJson),
          dryRun,
        },
      });
    } catch (error) {
      // Two concurrent posts of the same turn: the unique index is the final
      // guard, the loser returns the winner row.
      if (turnId) {
        const existing = await this.prisma.eveContextSnapshot.findFirst({
          where: { personaId, accountId, chatId, turnId },
        });
        if (existing) {
          return { ok: true, snapshot: snapshotOf(existing), duplicate: true };
        }
      }
      throw error;
    }

    // Retention must never delay the response: the row is already durable.
    void this.prune(personaId, accountId, chatId);
    return { ok: true, snapshot: snapshotOf(row), duplicate: false };
  }

  /** Newest first. `limit` is capped; unknown filters are ignored. */
  async list(query: EveContextSnapshotQuery): Promise<EveContextSnapshot[]> {
    const personaId = textOf(query.personaId).trim();
    const accountId = textOf(query.accountId).trim();
    const chatId = textOf(query.chatId).trim();
    const where: {
      personaId?: string;
      accountId?: string;
      chatId?: bigint;
    } = {};
    if (personaId) where.personaId = personaId;
    if (accountId) where.accountId = accountId;
    if (chatId) where.chatId = parseChatId(chatId);
    const rows = await this.prisma.eveContextSnapshot.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: listLimit(query.limit),
    });
    return rows.map((row) => snapshotOf(row));
  }

  async get(id: string): Promise<EveContextSnapshot> {
    const value = textOf(id).trim();
    if (!value) throw apiError('EVE_CONTEXT_ID_REQUIRED', 'id is required');
    const row = await this.prisma.eveContextSnapshot.findUnique({
      where: { id: value },
    });
    if (!row) throw notFound('EVE_CONTEXT_NOT_FOUND', 'Context snapshot not found');
    return snapshotOf(row);
  }

  /**
   * Keeps the newest `EVE_CONTEXT_SNAPSHOT_KEEP` rows of one chat address.
   * Runs after the insert, fire-and-forget.
   */
  private async prune(
    personaId: string,
    accountId: string,
    chatId: bigint,
  ): Promise<void> {
    const keep = retentionLimit();
    try {
      const stale = await this.prisma.eveContextSnapshot.findMany({
        where: { personaId, accountId, chatId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: keep,
        select: { id: true },
      });
      if (stale.length === 0) return;
      await this.prisma.eveContextSnapshot.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } },
      });
    } catch {
      // Retention is housekeeping; a failed prune must not fail the turn.
    }
  }
}
