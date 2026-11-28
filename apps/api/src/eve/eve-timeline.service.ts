import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { eveId, parseChatId, parseThreadId } from './eve-access.js';

/**
 * Read-only "Хроника" of one chat: his messages, her replies/ignores and the
 * relationship mutations applied for those turns.
 *
 * Messages come from the `EveSessionLog` lines the turn writeback already
 * writes (`[ts] он(42): ...`, `-> она: ...`, `-> ignored (busy)`); relationship
 * changes come from `EveRelationshipChange`, which stores exact post-clamp
 * deltas. Nothing here writes, so polling the endpoint is safe.
 *
 * Entries are returned newest first. `before` is an ISO timestamp (or epoch ms)
 * used as the pagination cursor: the next page contains only older rows.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_TEXT = 2_000;

const SCORE_KEYS = [
  'interest',
  'trust',
  'attraction',
  'annoyance',
  'cringe',
] as const;

type ScoreKey = (typeof SCORE_KEYS)[number];
type ScoreView = Record<ScoreKey, number>;

export interface EveTimelineQuery {
  personaId?: unknown;
  accountId?: unknown;
  chatId?: unknown;
  threadId?: unknown;
  limit?: unknown;
  before?: unknown;
}

export type EveTimelineEntry =
  | {
      id: string;
      at: string;
      kind: 'incoming';
      text: string;
      messageId?: number;
    }
  | { id: string; at: string; kind: 'reply'; text: string; dryRun?: boolean }
  | { id: string; at: string; kind: 'ignored'; reason?: string }
  | {
      id: string;
      at: string;
      kind: 'relationship';
      source: string;
      delta: Partial<ScoreView>;
      before: ScoreView;
      after: ScoreView;
      stageFrom?: string;
      stageTo?: string;
      conflictFrom?: number;
      conflictTo?: number;
    };

interface PendingEntry {
  entry: EveTimelineEntry;
  time: number;
  /** Same-millisecond order in the newest-first list: change, outcome, his. */
  rank: number;
}

/** Strongly-typed JSON object from an untrusted text column. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function scoreOf(raw: Record<string, unknown>): ScoreView {
  const out = {} as ScoreView;
  for (const key of SCORE_KEYS) {
    const value = Number(raw[key]);
    out[key] = Number.isFinite(value) ? Math.round(value) : 0;
  }
  return out;
}

function deltaOf(raw: Record<string, unknown>): Partial<ScoreView> {
  const out: Partial<ScoreView> = {};
  for (const key of SCORE_KEYS) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value !== 0) out[key] = Math.round(value);
  }
  return out;
}

/** One log line can be long; the browser never needs the whole essay. */
function clampText(value: string): string {
  const text = value.trim();
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

function clampLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}

const INCOMING = /^\s*\[[^\]]+\]\s*(?:он|user)(?:\((\d+)\))?\s*:\s*([\s\S]*)$/i;
const INCOMING_NO_TS =
  /^\s*(?:он|user)(?:\((\d+)\))?\s*:\s*([\s\S]*)$/i;
const REPLY = /^\s*->\s*она(?:\s*\(dry-run\))?\s*:\s*([\s\S]*)$/i;
const REPLY_NO_TS = /^\s*(?:\[[^\]]+\]\s*)?assistant\s*:\s*([\s\S]*)$/i;
const IGNORED = /^\s*->\s*ignored(?:\s*\(([^)]*)\))?\s*$/i;

/**
 * Parses one `EveSessionLog.line` into a timeline entry when it is a message.
 * The canonical `at` is the row timestamp: it is written explicitly by the
 * turn writeback, so every line of one turn shares it with the change row.
 */
function messageEntry(
  id: string,
  line: string,
  createdAt: Date,
): PendingEntry | null {
  const at = createdAt.toISOString();
  const time = createdAt.getTime();
  const ignored = IGNORED.exec(line);
  if (ignored) {
    const reason = (ignored[1] ?? '').trim();
    return {
      time,
      rank: 1,
      entry: {
        id,
        at,
        kind: 'ignored',
        ...(reason ? { reason: clampText(reason) } : {}),
      },
    };
  }

  const reply = REPLY.exec(line) ?? REPLY_NO_TS.exec(line);
  if (reply) {
    const text = clampText(reply[1] ?? '');
    if (!text) return null;
    return {
      time,
      rank: 1,
      entry: {
        id,
        at,
        kind: 'reply',
        text,
        ...(/\(dry-run\)/i.test(line) ? { dryRun: true } : {}),
      },
    };
  }

  const incoming = INCOMING.exec(line) ?? INCOMING_NO_TS.exec(line);
  if (incoming) {
    const text = clampText(incoming[2] ?? '');
    if (!text) return null;
    const messageId = Number(incoming[1]);
    return {
      time,
      rank: 2,
      entry: {
        id,
        at,
        kind: 'incoming',
        text,
        ...(Number.isSafeInteger(messageId) && messageId > 0
          ? { messageId }
          : {}),
      },
    };
  }

  // Free-form capture lines (`agent:`, `system:`), proactive markers and
  // anything unrecognised stay out of the human-facing feed.
  return null;
}

@Injectable()
export class EveTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /internal/eve/timeline`. */
  async timeline(query: EveTimelineQuery) {
    const personaId = eveId(
      query.personaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const accountId = eveId(
      query.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(query.chatId);
    const threadId = parseThreadId(query.threadId);
    const limit = clampLimit(query.limit);
    const before = parseBefore(query.before);

    const createdAt = before ? { lt: before } : undefined;
    const [logs, changes] = await Promise.all([
      this.prisma.eveSessionLog.findMany({
        where: {
          personaId,
          accountId,
          chatId,
          threadId,
          ...(createdAt ? { createdAt } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: { id: true, line: true, createdAt: true },
      }),
      this.prisma.eveRelationshipChange.findMany({
        where: {
          personaId,
          accountId,
          chatId,
          threadId,
          ...(createdAt ? { createdAt } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);

    const pending: PendingEntry[] = [];
    for (const row of logs) {
      const parsed = messageEntry(row.id, row.line, row.createdAt);
      if (parsed) pending.push(parsed);
    }
    for (const row of changes) {
      const delta = deltaOf(parseJson(row.delta));
      const stageFrom = row.stageFrom ?? undefined;
      const stageTo = row.stageTo ?? undefined;
      const conflictFrom =
        row.conflictBefore === null || row.conflictBefore === undefined
          ? undefined
          : row.conflictBefore;
      const conflictTo =
        row.conflictAfter === null || row.conflictAfter === undefined
          ? undefined
          : row.conflictAfter;
      pending.push({
        time: row.createdAt.getTime(),
        rank: 0,
        entry: {
          id: row.id,
          at: row.createdAt.toISOString(),
          kind: 'relationship',
          source: row.source,
          delta,
          before: scoreOf(parseJson(row.before)),
          after: scoreOf(parseJson(row.after)),
          ...(stageFrom ? { stageFrom } : {}),
          ...(stageTo ? { stageTo } : {}),
          ...(conflictFrom !== undefined ? { conflictFrom } : {}),
          ...(conflictTo !== undefined ? { conflictTo } : {}),
        },
      });
    }

    pending.sort(
      (left, right) =>
        right.time - left.time ||
        left.rank - right.rank ||
        right.entry.id.localeCompare(left.entry.id),
    );
    const page = pending.slice(0, limit);
    const entries = page.map((item) => item.entry);
    const last = entries[entries.length - 1];
    // Only a full page can have older neighbours; an empty one ends the feed.
    const nextBefore =
      entries.length === limit && last ? last.at : null;

    return { entries, nextBefore };
  }
}

/** `before` accepts an ISO timestamp or epoch milliseconds. */
function parseBefore(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const date = new Date(numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}
