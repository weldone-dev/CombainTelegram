import {
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { LogEntryView, LogsPageView, LogsStatsView } from "./logs.service.js";
import { LogsService } from "./logs.service.js";

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Structured logs for the dashboard and for AI agents.
 *
 * Examples:
 * - `GET /logs?level=error&limit=50`
 * - `GET /logs?source=telegram&q=FLOOD_WAIT`
 * - `GET /logs?accountId=<id>&before=2026-11-22T12:00:00.000Z`
 * - `GET /logs/export?level=error` (NDJSON)
 */
@ApiTags("logs")
@Controller("logs")
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  @Get()
  list(
    @Query("level") level?: string,
    @Query("source") source?: string,
    @Query("domain") domain?: string,
    @Query("q") q?: string,
    @Query("accountId") accountId?: string,
    @Query("sessionId") sessionId?: string,
    @Query("requestId") requestId?: string,
    @Query("chatId") chatId?: string,
    @Query("proxy") proxy?: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("before") before?: string,
    @Query("sort") sort?: string,
    @Query("offset") offset?: string,
    @Query("limit") limit?: string,
  ): Promise<LogsPageView> {
    return this.logs.query({
      level: parseText(level),
      source: parseText(source),
      domain: parseText(domain),
      q: parseText(q),
      accountId: parseText(accountId),
      sessionId: parseText(sessionId),
      requestId: parseText(requestId),
      chatId: parseNumber(chatId),
      proxy: parseText(proxy),
      since: parseDate(since),
      until: parseDate(until),
      before: parseDate(before),
      sort: parseText(sort),
      offset: parseNumber(offset),
      limit: parseNumber(limit),
    });
  }

  @Get("stats")
  stats(@Query("domain") domain?: string): Promise<LogsStatsView> {
    return this.logs.stats({ domain: parseText(domain) });
  }

  @Get("export")
  @Header("Content-Type", "application/x-ndjson; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="combain-logs.jsonl"')
  export(
    @Query("level") level?: string,
    @Query("source") source?: string,
    @Query("q") q?: string,
    @Query("accountId") accountId?: string,
    @Query("sessionId") sessionId?: string,
    @Query("requestId") requestId?: string,
    @Query("chatId") chatId?: string,
    @Query("proxy") proxy?: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("sort") sort?: string,
    @Query("limit") limit?: string,
  ): Promise<string> {
    return this.logs.exportJsonl({
      level: parseText(level),
      source: parseText(source),
      q: parseText(q),
      accountId: parseText(accountId),
      sessionId: parseText(sessionId),
      requestId: parseText(requestId),
      chatId: parseNumber(chatId),
      proxy: parseText(proxy),
      since: parseDate(since),
      until: parseDate(until),
      sort: parseText(sort),
      limit: parseNumber(limit),
    });
  }

  @Get(":id")
  async one(@Param("id") id: string): Promise<LogEntryView> {
    const entry = await this.logs.get(id);
    if (!entry) {
      throw new NotFoundException({ code: "LOG_NOT_FOUND", message: "Log entry not found" });
    }
    return entry;
  }

  @Delete()
  async clear(): Promise<{ cleared: number }> {
    return { cleared: await this.logs.clear() };
  }
}
