import type { AccountView, ChatView, MessageView } from "./types";

/**
 * Small offline snapshot of the chats page.
 *
 * Only what the list and transcript need is stored: minimal account rows
 * (id, names, username, isActive), chat titles, unread counters and the last
 * messages. Logs, proxies, sessions, phone numbers, tokens and anything from
 * `/api/*` never go here.
 */
const STORAGE_KEY = "tg-offline-v1";
const SELECTION_KEY = "tg-offline-selection";
const VERSION = 1;
const MAX_MESSAGES = 50;
const MAX_BYTES = 2 * 1024 * 1024;

/** The only account fields the sidebar needs; phone/sessions/device stay out. */
export interface OfflineAccount {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  isActive: boolean;
}

export interface OfflineSelection {
  accountId: string;
  chatId: number | null;
}

interface Snapshot<T> {
  /** Last write, used for LRU eviction. */
  at: number;
  items: T[];
}

interface OfflineStore {
  v: number;
  accounts: Snapshot<OfflineAccount> | null;
  chats: Record<string, Snapshot<ChatView>>;
  messages: Record<string, Snapshot<MessageView>>;
}

function emptyStore(): OfflineStore {
  return { v: VERSION, accounts: null, chats: {}, messages: {} };
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStore(): OfflineStore | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OfflineStore> | null;
    if (!parsed || parsed.v !== VERSION) return null;
    return {
      v: VERSION,
      accounts:
        parsed.accounts && Array.isArray(parsed.accounts.items)
          ? parsed.accounts
          : null,
      chats:
        parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {},
      messages:
        parsed.messages && typeof parsed.messages === "object"
          ? parsed.messages
          : {},
    };
  } catch {
    return null;
  }
}

function sizeOf(value: OfflineStore): number {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function oldestKey(
  store: OfflineStore,
): { area: "chats" | "messages"; key: string } | null {
  let found: { area: "chats" | "messages"; key: string; at: number } | null =
    null;
  for (const area of ["chats", "messages"] as const) {
    for (const [key, entry] of Object.entries(store[area])) {
      if (!found || entry.at < found.at) found = { area, key, at: entry.at };
    }
  }
  return found ? { area: found.area, key: found.key } : null;
}

function trimToBudget(store: OfflineStore): void {
  let guard = 0;
  while (sizeOf(store) > MAX_BYTES && guard < 200) {
    const victim = oldestKey(store);
    if (!victim) break;
    delete store[victim.area][victim.key];
    guard += 1;
  }
}

function writeStore(store: OfflineStore): void {
  const target = storage();
  if (!target) return;
  try {
    trimToBudget(store);
    target.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded or a blocked storage: evict the oldest half and retry,
    // then give up quietly. Offline data is an optimisation, not a contract.
    try {
      const oldest: Array<{
        area: "chats" | "messages";
        key: string;
        at: number;
      }> = [
        ...Object.entries(store.chats).map(([key, entry]) => ({
          area: "chats" as const,
          key,
          at: entry.at,
        })),
        ...Object.entries(store.messages).map(([key, entry]) => ({
          area: "messages" as const,
          key,
          at: entry.at,
        })),
      ];
      const entries = oldest.sort((a, b) => a.at - b.at);
      for (const entry of entries.slice(0, Math.ceil(entries.length / 2))) {
        delete store[entry.area][entry.key];
      }
      target.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // Private mode, disabled storage or still over quota.
    }
  }
}

function mutate(change: (store: OfflineStore) => void): void {
  const store = readStore() ?? emptyStore();
  change(store);
  writeStore(store);
}

/** Remembers the minimal account rows used by the sidebar. */
export function saveAccounts(accounts: AccountView[]): void {
  const known = new Set(accounts.map((account) => account.id));
  mutate((store) => {
    store.accounts = {
      at: Date.now(),
      items: accounts.map((account) => ({
        id: account.id,
        firstName: account.firstName,
        lastName: account.lastName,
        username: account.username,
        isActive: account.isActive,
      })),
    };
    // Detached accounts must not leave their chats and transcripts behind.
    for (const accountId of Object.keys(store.chats)) {
      if (!known.has(accountId)) delete store.chats[accountId];
    }
    for (const key of Object.keys(store.messages)) {
      if (!known.has(key.slice(0, key.indexOf(":")))) {
        delete store.messages[key];
      }
    }
  });
}

/**
 * Cached accounts as full `AccountView` rows, with the non-cached fields
 * neutral. Returns null when nothing was stored.
 */
export function loadAccounts(): AccountView[] | null {
  const store = readStore();
  const entry = store?.accounts;
  if (!entry || !Array.isArray(entry.items)) return null;
  return entry.items.map((account) => ({
    id: account.id,
    tgUserId: "",
    firstName: account.firstName,
    lastName: account.lastName ?? null,
    username: account.username ?? null,
    phone: null,
    phoneMasked: null,
    isActive: account.isActive === true,
    createdAt: "",
    lastUsedAt: null,
    deviceProfile: null,
    activeSessionId: null,
    sessions: [],
  }));
}

/** Remembers the last selected account/chat for offline restores. */
export function saveSelection(accountId: string, chatId: number | null): void {
  const target = storage();
  if (!target) return;
  try {
    const selection: OfflineSelection = {
      accountId,
      chatId: typeof chatId === "number" ? chatId : null,
    };
    target.setItem(SELECTION_KEY, JSON.stringify(selection));
  } catch {
    // Best effort.
  }
}

/** The last selected account/chat, or null when it is missing or malformed. */
export function loadSelection(): OfflineSelection | null {
  const target = storage();
  if (!target) return null;
  try {
    const raw = target.getItem(SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OfflineSelection> | null;
    if (!parsed || typeof parsed.accountId !== "string" || !parsed.accountId) {
      return null;
    }
    return {
      accountId: parsed.accountId,
      chatId:
        typeof parsed.chatId === "number" && Number.isFinite(parsed.chatId)
          ? parsed.chatId
          : null,
    };
  } catch {
    return null;
  }
}

/** Remembers the latest chat list of one account. */
export function saveChatList(accountId: string, chats: ChatView[]): void {
  mutate((store) => {
    store.chats[accountId] = {
      at: Date.now(),
      items: chats.slice(0, 200),
    };
  });
}

/** Cached chat list of one account, or null when nothing was stored. */
export function loadChatList(accountId: string): ChatView[] | null {
  const store = readStore();
  const entry = store?.chats[accountId];
  return entry && Array.isArray(entry.items) ? entry.items : null;
}

/** Remembers the newest `MAX_MESSAGES` messages of a chat. */
export function saveMessages(
  accountId: string,
  chatId: number,
  messages: MessageView[],
): void {
  mutate((store) => {
    store.messages[`${accountId}:${chatId}`] = {
      at: Date.now(),
      items: messages.slice(-MAX_MESSAGES),
    };
  });
}

/** Cached transcript of a chat, or null when nothing was stored. */
export function loadMessages(
  accountId: string,
  chatId: number,
): MessageView[] | null {
  const store = readStore();
  const entry = store?.messages[`${accountId}:${chatId}`];
  return entry && Array.isArray(entry.items) ? entry.items : null;
}

/**
 * Drops one account's chat list and transcripts.
 *
 * Message ids are engine-specific: TDLib and mtcute number messages
 * differently, so a transcript cached under one engine is unusable (and its
 * ids unknown to the API) after the account's active session changes. The
 * account rows and the last selection are kept.
 */
export function clearAccountCache(accountId: string): void {
  mutate((store) => {
    delete store.chats[accountId];
    const prefix = `${accountId}:`;
    for (const key of Object.keys(store.messages)) {
      if (key.startsWith(prefix)) delete store.messages[key];
    }
  });
}

/** Drops every offline snapshot (e.g. when the user clears the cache). */
export function clearOfflineCache(): void {
  const target = storage();
  if (!target) return;
  try {
    target.removeItem(STORAGE_KEY);
    target.removeItem(SELECTION_KEY);
  } catch {
    // Best effort.
  }
}
