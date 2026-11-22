import {
  HttpException,
  Injectable,
} from "@nestjs/common";
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Observable, catchError, tap, throwError } from "rxjs";
import { LogsService } from "./logs.service.js";
import type { LogSource } from "./log-sink.js";
import {
  redactMessageBody,
  sanitizeDetails,
  sanitizeQueryForLog,
} from "./log-sanitize.js";
import { runWithLogContext } from "./log-context.js";
import type { LogRequestContext } from "./log-context.js";

interface HttpRequestLike {
  method: string;
  originalUrl?: string;
  url: string;
  body?: unknown;
  query?: unknown;
  params?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: { id?: string };
  route?: { path?: string };
}

interface HttpResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
}

const CONTROLLER_SOURCES: Record<string, LogSource> = {
  AccountsController: "accounts",
  MessagingController: "messaging",
  MessagingSearchController: "messaging",
  ProxiesController: "proxy",
  PhoneAuthController: "auth",
  QrAuthController: "auth",
  TdataAuthController: "auth",
  AppController: "app",
};

/**
 * Writes one `http` log per API request: controller method, route, status,
 * duration, sanitized params/query/body and the error body with its code.
 *
 * High-frequency GET polls (`/logs`, QR status) are skipped on purpose; every
 * mutation and every ordinary read is recorded.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logs: LogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const response = context.switchToHttp().getResponse<HttpResponseLike>();
    const method = request.method.toUpperCase();

    if (method === "OPTIONS" || this.shouldSkip(method, request)) {
      return next.handle();
    }

    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    const action = `${controller}.${handler}`;
    const source = CONTROLLER_SOURCES[controller] ?? "http";
    const requestId =
      headerValue(request.headers["x-request-id"]) ?? randomUUID();
    response.setHeader("x-request-id", requestId);

    const startedAt = Date.now();
    const details = {
      method,
      path: pathOnly(request.originalUrl ?? request.url),
      params: request.params ?? {},
      query: sanitizeQueryForLog(request.query ?? {}),
      body: bodyForLog(request),
      ip: request.ip,
      userAgent: headerValue(request.headers["user-agent"]),
    };

    // Services deep in the call stack can override `proxyId` once they resolve
    // the actual session this request used.
    const logContext: LogRequestContext = {
      requestId,
      proxyId: proxyIdFromRequest(request),
    };

    const stream$ = new Observable<unknown>((subscriber) =>
      runWithLogContext(logContext, () =>
        next.handle().subscribe(subscriber),
      ),
    );

    return stream$.pipe(
      tap(() => {
        this.logs.write({
          level: "info",
          source,
          action,
          message: `${method} ${pathOnly(request.originalUrl ?? request.url)} → ${response.statusCode}`,
          status: "ok",
          requestId,
          userId: request.user?.id,
          accountId: ids(request).accountId,
          sessionId: request.params?.sessionId,
          chatId: ids(request).chatId,
          attemptId: request.params?.attemptId,
          proxyId: logContext.proxyId,
          durationMs: Date.now() - startedAt,
          details,
        });
      }),
      catchError((error: unknown) => {
        const described = describeError(error);
        this.logs.write({
          level: described.status >= 500 ? "error" : "warn",
          source,
          action,
          message: `${method} ${pathOnly(request.originalUrl ?? request.url)} → ${described.status} ${described.code ?? ""}`.trim(),
          status: "failed",
          requestId,
          userId: request.user?.id,
          accountId: ids(request).accountId,
          sessionId: request.params?.sessionId,
          chatId: ids(request).chatId,
          attemptId: request.params?.attemptId,
          errorCode: described.code,
          telegramError: described.telegramError,
          telegramResponse: described.telegramResponse,
          proxyId: logContext.proxyId,
          durationMs: Date.now() - startedAt,
          details: {
            ...details,
            error: described.body,
            stack: described.stack,
          },
        });
        return throwError(() => error);
      }),
    );
  }

  private shouldSkip(method: string, request: HttpRequestLike): boolean {
    const path = pathOnly(request.originalUrl ?? request.url);
    if (path.startsWith("/logs")) return true;
    // QR login screens poll this endpoint every couple of seconds.
    if (method === "GET" && /^\/auth\/qr\/[^/]+$/.test(path)) return true;
    return false;
  }
}

function pathOnly(url: string): string {
  const path = url.split("?")[0] ?? url;
  return path.length > 200 ? `${path.slice(0, 200)}…` : path;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function ids(request: HttpRequestLike): {
  accountId?: string;
  chatId?: number;
} {
  const params = request.params ?? {};
  let accountId: string | undefined = params.accountId;
  const url = request.originalUrl ?? request.url;
  if (!accountId && url.startsWith('/accounts/')) {
    accountId = params.id;
  }
  const rawChatId = params.chatId;
  const chatId =
    rawChatId !== undefined && /^\d+$/.test(rawChatId)
      ? Number(rawChatId)
      : undefined;
  return { accountId, chatId };
}

function bodyForLog(request: HttpRequestLike): unknown {
  const contentType = headerValue(request.headers["content-type"]) ?? "";
  if (contentType.includes("multipart/form-data")) {
    return "[upload]";
  }
  return redactMessageBody(request.body);
}

/** Auth/proxy endpoints name the proxy in the body; sessions are resolved later. */
function proxyIdFromRequest(request: HttpRequestLike): string | null {
  const body = request.body;
  if (body && typeof body === "object" && "proxyId" in body) {
    const value = (body as { proxyId?: unknown }).proxyId;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

interface DescribedError {
  status: number;
  code?: string;
  body: unknown;
  stack?: string;
  telegramError?: string;
  telegramResponse?: unknown;
}

function describeError(error: unknown): DescribedError {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const body =
      typeof response === "object" && response !== null
        ? (response as Record<string, unknown>)
        : { message: String(response) };
    return {
      status,
      code: typeof body.code === "string" ? body.code : undefined,
      body: sanitizeDetails(body),
    };
  }

  const asError = error instanceof Error ? error : null;
  return {
    status: 500,
    code: asError?.name ?? "INTERNAL_ERROR",
    body: { message: asError?.message ?? String(error) },
    stack: asError?.stack?.slice(0, 4000),
    telegramError: asError?.message,
    telegramResponse: { name: asError?.name, message: asError?.message },
  };
}
