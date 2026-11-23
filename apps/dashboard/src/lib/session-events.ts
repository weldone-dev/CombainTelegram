/** Fired on `window` when an account's active session may have changed. */
export const SESSION_CHANGED_EVENT = "ct:session-changed";

export interface SessionChangedDetail {
  accountId: string;
}

/**
 * Tells the open chats page that one account's active session changed.
 *
 * Message ids are engine-specific, so the cached chat list and transcripts of
 * that account were cleared and whatever is on screen is now stale.
 */
export function notifySessionChanged(accountId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SessionChangedDetail>(SESSION_CHANGED_EVENT, {
      detail: { accountId },
    }),
  );
}
