import { apiFetch } from "./api";
import type { AccountView, SessionPatch, SessionRemovalView } from "./types";

/** `POST /accounts/:accountId/sessions/:sessionId/activate`. */
export function activateSession(
  accountId: string,
  sessionId: string,
): Promise<AccountView> {
  return apiFetch<AccountView>(
    `/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(sessionId)}/activate`,
    { method: "POST" },
  );
}

/** `DELETE /accounts/:accountId/sessions/:sessionId?revoke=`. */
export function deleteSession(
  accountId: string,
  sessionId: string,
  revoke: boolean,
): Promise<SessionRemovalView> {
  const query = `?revoke=${revoke ? "true" : "false"}`;
  return apiFetch<SessionRemovalView>(
    `/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(sessionId)}${query}`,
    { method: "DELETE" },
  );
}

/** `PATCH /accounts/:accountId/sessions/:sessionId` — proxy and/or label. */
export function patchSession(
  accountId: string,
  sessionId: string,
  patch: SessionPatch,
): Promise<AccountView> {
  return apiFetch<AccountView>(
    `/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: patch },
  );
}

/**
 * Reloads one account through the accounts list. The sessions modal needs a
 * fresh `AccountView` after add/delete, and there is no single-account GET.
 */
export async function fetchAccount(
  accountId: string,
): Promise<AccountView | null> {
  const accounts = await apiFetch<AccountView[]>("/accounts", {});
  return accounts.find((account) => account.id === accountId) ?? null;
}
