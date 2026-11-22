const DRAFT_PREFIX = "ct:draft:";

/**
 * Drafts are scoped per account and chat so switching between them (or
 * reloading the page) never loses typed text. Every helper touches
 * `window.localStorage` only when called from effects or event handlers.
 */
export function draftStorageKey(accountId: string, chatId: number): string {
  return `${DRAFT_PREFIX}${accountId}:${chatId}`;
}

export function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string): void {
  try {
    if (text) window.localStorage.setItem(key, text);
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode or a full quota must not break typing.
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Best-effort cleanup.
  }
}
