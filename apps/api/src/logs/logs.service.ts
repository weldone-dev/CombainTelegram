import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { LogEntryModel } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { parseJson, serializeJson } from "./log-sanitize.js";
import { setLogSink } from "./log-sink.js";
import type { LogInput, LogLevel, LogSource } from "./log-sink.js";

export interface LogEntryView {
  id: string;
  level: LogLevel;
  source: LogSource;
  action: string;
  message: string;
  status: string | null;
  requestId: string | null;
  userId: string | null;
  accountId: string | null;
  sessionId: string | null;
  chatId: number | null;
  attemptId: string | null;
  durationMs: number | null;
  errorCode: string | null;
  telegramMethod: string | null;
  telegramError: string | null;
  telegramResponse: unknown;
  proxyId: string | null;
  proxyLabel: string | null;
  proxySnapshot: unknown;
  details: unknown;
  createdAt: string;
}

export interface LogsQuery {
  level?: string;
  source?: string;
  /** `telegram` (telegram/messaging/auth) or `system` (everything else). */
  domain?: string;
  q?: string;
  accountId?: string;
  sessionId?: string;
  requestId?: string;
  chatId?: number;
  proxy?: string;
  since?: Date;
  until?: Date;
  /** Return entries strictly older than this ISO timestamp (paging). */
  before?: Date;
  /** `newest` (default), `oldest`, `slowest`. */
  sort?: string;
  offset?: number;
  limit?: number;
}

export interface LogsPageView {
  entries: LogEntryView[];
  /** Pass as `before` to fetch the next page; `null` when there are no more. */
  nextBefore: string | null;
  /** Pass as `offset` to fetch the next page (used by non-newest sorts). */
  nextOffset: number | null;
}

export interface LogsStatsView {
  total: number;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
  byProxy: Record<string, number>;
  oldest: string | null;
  newest: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const PRUNE_EVERY = 100;

/** Sources that describe talking to Telegram (RPC, messaging, login flows). */
export const TELEGRAM_SOURCES = ['telegram', 'messaging', 'auth'];
/** Sources produced by the application itself: HTTP plumbing, storage, WS. */
export const SYSTEM_SOURCES = [
  'http',
  'accounts',
  'proxy',
  'realtime',
  'app',
];

/**
 * Persistent structured log.
 *
 * Writes are queued and fire-and-forget: a logging failure can never break the
 * request it observes. Entries are also mirrored to the Nest logger (stdout),
 * and the whole table is exposed over REST for the dashboard and AI agents.
 */
@Injectable()
export class LogsService implements OnModuleDestroy {
  private readonly logger = new Logger(LogsService.name);
  private tail: Promise<void> = Promise.resolve();
  private writes = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {
    setLogSink((entry) => this.write(entry));
  }

  /** Queues one entry; never throws and never blocks the caller. */
  write(entry: LogInput): void {
    this.logToStdout(entry);
    this.tail = this.tail
      .then(() => this.persist(entry))
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not persist a log entry: ${(error as Error).message}`,
        );
      });
  }

  async query(params: LogsQuery = {}): Promise<LogsPageView> {
    const limit = clampLimit(params.limit);
    const where = this.buildWhere(params);
    const offset = Math.max(params.offset ?? 0, 0);
    const rows = await this.prisma.logEntry.findMany({
      where,
      orderBy: orderByFor(params.sort),
      skip: params.before ? 0 : offset,
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => this.toView(row)),
      nextBefore:
        rows.length > limit && last ? last.createdAt.toISOString() : null,
      nextOffset: rows.length > limit ? offset + page.length : null,
    };
  }

  async get(id: string): Promise<LogEntryView | null> {
    const row = await this.prisma.logEntry.findUnique({ where: { id } });
    return row ? this.toView(row) : null;
  }

  async stats(params: LogsQuery = {}): Promise<LogsStatsView> {
    const where = this.buildWhere({ domain: params.domain });
    const [total, byLevel, bySource, byProxy, oldest, newest] =
      await Promise.all([
        this.prisma.logEntry.count({ where }),
        this.prisma.logEntry.groupBy({
          by: ['level'],
          where,
          _count: { _all: true },
        }),
        this.prisma.logEntry.groupBy({
          by: ['source'],
          where,
          _count: { _all: true },
        }),
        this.prisma.logEntry.groupBy({
          by: ['proxyLabel'],
          where,
          _count: { _all: true },
        }),
        this.prisma.logEntry.findFirst({
          where,
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.logEntry.findFirst({
          where,
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    const levelCounts: Record<string, number> = {};
    for (const row of byLevel) levelCounts[row.level] = row._count._all;
    const sourceCounts: Record<string, number> = {};
    for (const row of bySource) sourceCounts[row.source] = row._count._all;
    const proxyCounts: Record<string, number> = {};
    for (const row of byProxy) {
      if (row.proxyLabel) proxyCounts[row.proxyLabel] = row._count._all;
    }

    return {
      total,
      byLevel: levelCounts,
      bySource: sourceCounts,
      byProxy: proxyCounts,
      oldest: oldest?.createdAt.toISOString() ?? null,
      newest: newest?.createdAt.toISOString() ?? null,
    };
  }

  /** Newline-delimited JSON, newest first: easy to `jq` or feed to an agent. */
  async exportJsonl(params: LogsQuery = {}): Promise<string> {
    const rows = await this.prisma.logEntry.findMany({
      where: this.buildWhere(params),
      orderBy: orderByFor(params.sort),
      take: Math.min(clampLimit(params.limit, 5000), MAX_LIMIT),
    });
    return rows.map((row) => JSON.stringify(this.toView(row))).join("\n");
  }

  async clear(): Promise<number> {
    const result = await this.prisma.logEntry.deleteMany();
    return result.count;
  }

  async onModuleDestroy(): Promise<void> {
    await this.tail.catch(() => undefined);
    setLogSink(null);
  }

  private async persist(entry: LogInput): Promise<void> {
    const proxy = await this.resolveProxy(entry);
    const row = await this.prisma.logEntry.create({
      data: {
        level: entry.level,
        source: entry.source,
        action: entry.action,
        message: entry.message,
        status: entry.status ?? null,
        requestId: entry.requestId ?? null,
        userId: entry.userId ?? null,
        accountId: entry.accountId ?? null,
        sessionId: entry.sessionId ?? null,
        chatId: entry.chatId ?? null,
        attemptId: entry.attemptId ?? null,
        durationMs: entry.durationMs ?? null,
        errorCode: entry.errorCode ?? null,
        telegramMethod: entry.telegramMethod ?? null,
        telegramError: entry.telegramError ?? null,
        telegramResponse:
          entry.telegramResponse === undefined
            ? null
            : serializeJson(entry.telegramResponse),
        proxyId: entry.proxyId ?? null,
        proxyLabel: proxy.label,
        proxySnapshot: proxy.snapshot,
        details: serializeJson(entry.details),
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
      },
    });

    this.writes += 1;
    if (this.writes % PRUNE_EVERY === 0) {
      await this.prune().catch(() => undefined);
    }

    // Live tail for the dashboard and future agent subscribers.
    this.realtime.emitToUser(
      entry.userId ?? process.env.DEFAULT_USER_ID ?? 'local',
      'log.new',
      this.toView(row),
    );
  }

  /**
   * Copies the proxy profile into the entry itself. If the proxy has been
   * deleted or renamed later, the historical row still shows what was used.
   */
  private async resolveProxy(entry: LogInput): Promise<{
    label: string | null;
    snapshot: string | null;
  }> {
    const proxyId = entry.proxyId ?? null;
    if (!proxyId) {
      return {
        label: entry.proxyLabel ?? null,
        snapshot:
          entry.proxySnapshot === undefined
            ? null
            : serializeJson(entry.proxySnapshot),
      };
    }

    const row = await this.prisma.proxy.findUnique({
      where: { id: proxyId },
      select: {
        id: true,
        name: true,
        kind: true,
        host: true,
        port: true,
        username: true,
        enabled: true,
      },
    });

    if (!row) {
      return {
        label: entry.proxyLabel ?? null,
        snapshot:
          entry.proxySnapshot === undefined
            ? null
            : serializeJson(entry.proxySnapshot),
      };
    }

    return {
      label:
        entry.proxyLabel ??
        `${row.name} · ${row.kind}://${row.host}:${row.port}`,
      snapshot: serializeJson({
        id: row.id,
        name: row.name,
        kind: row.kind,
        host: row.host,
        port: row.port,
        username: row.username,
        enabled: row.enabled,
      }),
    };
  }

  /** Keeps the table under `LOG_MAX_ENTRIES` (oldest first). */
  private async prune(): Promise<void> {
    const max = Number(process.env.LOG_MAX_ENTRIES ?? DEFAULT_MAX_ENTRIES);
    if (!Number.isFinite(max) || max <= 0) return;

    const total = await this.prisma.logEntry.count();
    if (total <= max) return;

    const stale = await this.prisma.logEntry.findMany({
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: total - max,
    });
    if (stale.length === 0) return;
    await this.prisma.logEntry.deleteMany({
      where: { id: { in: stale.map((row) => row.id) } },
    });
  }

  private buildWhere(params: LogsQuery) {
    const where: {
      level?: string;
      source?: string | { in: string[] };
      accountId?: string;
      sessionId?: string;
      requestId?: string;
      chatId?: number;
      proxyLabel?: string;
      createdAt?: { gte?: Date; lte?: Date; lt?: Date };
      OR?: Array<{
        action?: { contains: string };
        message?: { contains: string };
        telegramError?: { contains: string };
        errorCode?: { contains: string };
        proxyLabel?: { contains: string };
      }>;
    } = {};

    if (params.level) where.level = params.level;
    if (params.source) {
      where.source = params.source;
    } else if (params.domain === 'telegram') {
      where.source = { in: TELEGRAM_SOURCES };
    } else if (params.domain === 'system') {
      where.source = { in: SYSTEM_SOURCES };
    }
    if (params.accountId) where.accountId = params.accountId;
    if (params.sessionId) where.sessionId = params.sessionId;
    if (params.requestId) where.requestId = params.requestId;
    if (params.chatId !== undefined) where.chatId = params.chatId;
    if (params.proxy) where.proxyLabel = params.proxy;

    const createdAt: { gte?: Date; lte?: Date; lt?: Date } = {};
    if (params.since) createdAt.gte = params.since;
    if (params.until) createdAt.lte = params.until;
    if (params.before) createdAt.lt = params.before;
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

    const q = params.q?.trim();
    if (q) {
      where.OR = [
        { action: { contains: q } },
        { message: { contains: q } },
        { telegramError: { contains: q } },
        { errorCode: { contains: q } },
        { proxyLabel: { contains: q } },
      ];
    }

    return where;
  }

  private toView(row: LogEntryModel): LogEntryView {
    return {
      id: row.id,
      level: row.level as LogLevel,
      source: row.source as LogSource,
      action: row.action,
      message: row.message,
      status: row.status,
      requestId: row.requestId,
      userId: row.userId,
      accountId: row.accountId,
      sessionId: row.sessionId,
      chatId: row.chatId,
      attemptId: row.attemptId,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      telegramMethod: row.telegramMethod,
      telegramError: row.telegramError,
      telegramResponse: parseJson(row.telegramResponse),
      proxyId: row.proxyId,
      proxyLabel: row.proxyLabel,
      proxySnapshot: parseJson(row.proxySnapshot),
      details: parseJson(row.details),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private logToStdout(entry: LogInput): void {
    const line = `[${entry.source}] ${entry.action}: ${entry.message}`;
    switch (entry.level) {
      case "error":
        this.logger.error(line);
        return;
      case "warn":
        this.logger.warn(line);
        return;
      case "debug":
        this.logger.debug(line);
        return;
      default:
        this.logger.log(line);
    }
  }
}

function clampLimit(value: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function orderByFor(
  sort: string | undefined,
): Array<{ createdAt?: 'asc' | 'desc'; durationMs?: 'asc' | 'desc' }> {
  if (sort === 'oldest') return [{ createdAt: 'asc' }];
  if (sort === 'slowest') return [{ durationMs: 'desc' }, { createdAt: 'desc' }];
  return [{ createdAt: 'desc' }];
}
