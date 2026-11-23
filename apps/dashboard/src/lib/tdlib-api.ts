import { apiFetch, errorCodeText } from "./api";
import type {
  AttemptStatus,
  AttemptView,
  CloudPasswordView,
  TdlibAuthMethod,
} from "./types";

/** QR links and migration progress are polled at this interval. */
export const TDLIB_POLL_INTERVAL_MS = 2000;

export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  starting: "Запускаем TDLib…",
  qr_pending: "Ожидаем подтверждения в Telegram…",
  awaiting_code: "Ожидаем код из Telegram",
  awaiting_password: "Нужен пароль двухэтапной проверки",
  ready: "Готово",
  failed: "Ошибка",
  expired: "Время истекло",
};

/** Terminal attempts stop the polling loops. */
export function isAttemptSettled(status: AttemptStatus): boolean {
  return status === "ready" || status === "failed" || status === "expired";
}

/** `attempt.error` may be a stable API code; show Russian when we know it. */
export function attemptErrorText(error: string | undefined): string | null {
  if (!error) return null;
  return errorCodeText(error);
}

/** `POST /tdlib/auth/start` — new TDLib session for the local user. */
export function startTdlibAuth(input: {
  method: TdlibAuthMethod;
  phone?: string;
  proxyId?: string;
  label?: string;
  /** Adds the new session to this existing account instead of creating one. */
  accountId?: string;
}): Promise<AttemptView> {
  return apiFetch<AttemptView>("/tdlib/auth/start", {
    method: "POST",
    body: input,
  });
}

/** `GET /tdlib/auth/:attemptId`. */
export function getTdlibAuth(attemptId: string): Promise<AttemptView> {
  return apiFetch<AttemptView>(
    `/tdlib/auth/${encodeURIComponent(attemptId)}`,
    {},
  );
}

/** `POST /tdlib/auth/:attemptId/code`. */
export function submitTdlibAuthCode(
  attemptId: string,
  code: string,
): Promise<AttemptView> {
  return apiFetch<AttemptView>(
    `/tdlib/auth/${encodeURIComponent(attemptId)}/code`,
    { method: "POST", body: { code } },
  );
}

/** `POST /tdlib/auth/:attemptId/password`. */
export function submitTdlibAuthPassword(
  attemptId: string,
  password: string,
): Promise<AttemptView> {
  return apiFetch<AttemptView>(
    `/tdlib/auth/${encodeURIComponent(attemptId)}/password`,
    { method: "POST", body: { password } },
  );
}

/** `DELETE /tdlib/auth/:attemptId`. */
export function cancelTdlibAuth(
  attemptId: string,
): Promise<{ cancelled: boolean }> {
  return apiFetch<{ cancelled: boolean }>(
    `/tdlib/auth/${encodeURIComponent(attemptId)}`,
    { method: "DELETE" },
  );
}

/** `POST /accounts/:accountId/tdlib/migrate` — switch a session to TDLib. */
export function startTdlibMigration(accountId: string): Promise<AttemptView> {
  return apiFetch<AttemptView>(
    `/accounts/${encodeURIComponent(accountId)}/tdlib/migrate`,
    { method: "POST" },
  );
}

/** `GET /accounts/:accountId/tdlib/migrate/:attemptId`. */
export function getTdlibMigration(
  accountId: string,
  attemptId: string,
): Promise<AttemptView> {
  return apiFetch<AttemptView>(
    `/accounts/${encodeURIComponent(accountId)}/tdlib/migrate/${encodeURIComponent(attemptId)}`,
    {},
  );
}

/** `POST /accounts/:accountId/tdlib/migrate/:attemptId/password`. */
export function submitTdlibMigrationPassword(
  accountId: string,
  attemptId: string,
  password: string,
): Promise<AttemptView> {
  return apiFetch<AttemptView>(
    `/accounts/${encodeURIComponent(accountId)}/tdlib/migrate/${encodeURIComponent(attemptId)}/password`,
    { method: "POST", body: { password } },
  );
}

/** `DELETE /accounts/:accountId/tdlib/migrate/:attemptId`. */
export function cancelTdlibMigration(
  accountId: string,
  attemptId: string,
): Promise<{ cancelled: boolean }> {
  return apiFetch<{ cancelled: boolean }>(
    `/accounts/${encodeURIComponent(accountId)}/tdlib/migrate/${encodeURIComponent(attemptId)}`,
    { method: "DELETE" },
  );
}

/** `GET /accounts/:accountId/cloud-password`. */
export function fetchCloudPassword(
  accountId: string,
): Promise<CloudPasswordView> {
  return apiFetch<CloudPasswordView>(
    `/accounts/${encodeURIComponent(accountId)}/cloud-password`,
    {},
  );
}

/** `PUT /accounts/:accountId/cloud-password`. */
export function saveCloudPassword(
  accountId: string,
  password: string,
): Promise<CloudPasswordView> {
  return apiFetch<CloudPasswordView>(
    `/accounts/${encodeURIComponent(accountId)}/cloud-password`,
    { method: "PUT", body: { password } },
  );
}

/** `DELETE /accounts/:accountId/cloud-password`. */
export function deleteCloudPassword(
  accountId: string,
): Promise<CloudPasswordView> {
  return apiFetch<CloudPasswordView>(
    `/accounts/${encodeURIComponent(accountId)}/cloud-password`,
    { method: "DELETE" },
  );
}
