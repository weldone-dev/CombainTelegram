import { AsyncLocalStorage } from "node:async_hooks";

export interface LogRequestContext {
  requestId: string;
  /** Proxy actually used by the session/service for this request, if any. */
  proxyId?: string | null;
  /** Set when an instrumented Telegram call already logged this failure. */
  telegramErrorLogged?: boolean;
  /** Last Telegram RPC method executed in this request. */
  telegramMethod?: string | null;
}

const storage = new AsyncLocalStorage<LogRequestContext>();

/**
 * Makes `context` available to services that run below the HTTP interceptor.
 * The interceptor keeps a reference to the same object, so mutations made deep
 * inside a service are visible when the response is logged.
 */
export function runWithLogContext<T>(
  context: LogRequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function currentLogContext(): LogRequestContext | undefined {
  return storage.getStore();
}

/** Records which proxy the resolved session used for this request. */
export function setLogProxyId(proxyId: string | null | undefined): void {
  const context = storage.getStore();
  if (!context) return;
  context.proxyId = proxyId ?? null;
}

export function setLogTelegramMethod(method: string | undefined): void {
  const context = storage.getStore();
  if (!context) return;
  context.telegramMethod = method ?? null;
}

export function markTelegramErrorLogged(): void {
  const context = storage.getStore();
  if (!context) return;
  context.telegramErrorLogged = true;
}

/** Reads and clears the "already logged" flag so the next error logs again. */
export function consumeTelegramErrorLogged(): boolean {
  const context = storage.getStore();
  if (!context?.telegramErrorLogged) return false;
  context.telegramErrorLogged = false;
  return true;
}
