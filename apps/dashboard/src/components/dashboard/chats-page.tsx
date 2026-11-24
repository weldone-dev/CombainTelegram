"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listChatRuns } from "../../lib/ai-api";
import { ApiError, apiFetch, errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
import {
  mergeMessages,
  putReasoning,
  remapReasoning,
} from "../../lib/message-merge";
import {
  deleteMessage as deleteMessageRequest,
  INITIAL_CHAT_LIMIT,
  listChats,
  listFolders,
  markAllRead,
  nextChatLimit,
  removeChat,
  resolveChat,
  updateChat,
} from "../../lib/messaging-api";
import {
  notificationsReady,
  showMessageNotification,
} from "../../lib/notifications";
import {
  loadChatList as loadCachedChatList,
  loadMessages as loadCachedMessages,
  loadSelection,
  saveChatList,
  saveMessages,
  saveSelection,
} from "../../lib/offline-cache";
import { subscribeRealtime } from "../../lib/realtime-bus";
import {
  SESSION_CHANGED_EVENT,
  type SessionChangedDetail,
} from "../../lib/session-events";
import { playChime, readSoundEnabled } from "../../lib/sound";
import type {
  AiReplyEvent,
  ChatFolderSelection,
  ChatPatch,
  ChatView,
  FolderView,
  ForwardResult,
  MessageHistoryView,
  MessageReasoningView,
  MessageView,
  RealtimeDeletedEvent,
  RealtimeMessageEvent,
  RealtimeReadEvent,
  RealtimeTypingEvent,
  TypingEntry,
} from "../../lib/types";
import { AccountsSidebar } from "../messenger/accounts-sidebar";
import { AiAccessProvider } from "../messenger/ai-access-store";
import { ChatList } from "../messenger/chat-list";
import { ChatWindow } from "../messenger/chat-window";
import { useAppData } from "./app-data";

const LAST_ACCOUNT_KEY = "ct:last-account";

function isOffline(error?: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  // A stopped API also fails with NETWORK_ERROR while navigator.onLine stays
  // true, which must still restore the snapshot.
  return error instanceof ApiError && error.code === "NETWORK_ERROR";
}

export function ChatsPage() {
  const {
    accounts,
    accountsLoading,
    accountsError,
    reloadAccounts,
    openAddAccount,
    realtimeOnline,
    showNotice,
  } = useAppData();

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null,
  );

  const [chats, setChats] = useState<ChatView[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [focusedMessage, setFocusedMessage] = useState<{
    chatId: number;
    messageId: number;
    nonce: number;
  } | null>(null);
  const focusNonceRef = useRef(0);

  const [folders, setFolders] = useState<FolderView[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [folder, setFolder] = useState<ChatFolderSelection>({ kind: "all" });
  const [chatLimit, setChatLimit] = useState(INITIAL_CHAT_LIMIT);

  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextOffsetId, setNextOffsetId] = useState<number | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [typing, setTyping] = useState<Record<string, TypingEntry[]>>({});
  const [offline, setOffline] = useState(false);
  const [offlineBannerDismissed, setOfflineBannerDismissed] = useState(false);
  const selectedChatRef = useRef<ChatView | null>(null);
  const chatsRef = useRef<ChatView[]>([]);
  chatsRef.current = chats;
  const messagesRef = useRef<MessageView[]>([]);
  messagesRef.current = messages;
  const [reasoningByMessage, setReasoningByMessage] = useState<
    Map<number, MessageReasoningView>
  >(() => new Map());
  const reasoningRef = useRef(reasoningByMessage);
  reasoningRef.current = reasoningByMessage;
  /** `<accountId>:<chatId>` whose transcript is currently in `messagesRef`. */
  const messagesChatRef = useRef<string | null>(null);
  const selectedAccountIdRef = useRef<string | null>(null);
  selectedAccountIdRef.current = selectedAccountId;
  const selectedChatIdRef = useRef<number | null>(null);
  selectedChatIdRef.current = selectedChatId;
  const chatsRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);

  // Remember the last opened account/chat and honor ?account=<id> links from
  // the accounts page. Offline, the selection comes from the snapshot so the
  // cached transcript opens immediately.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("account");
    const queryChat = Number.parseInt(params.get("chat") ?? "", 10);
    let fromStorage: string | null = null;
    try {
      fromStorage = window.localStorage.getItem(LAST_ACCOUNT_KEY);
    } catch {
      // Private mode or a blocked storage must not break the page.
    }

    const selection = loadSelection();
    setSelectedAccountId(fromQuery ?? selection?.accountId ?? fromStorage);
    if (Number.isFinite(queryChat)) {
      setSelectedChatId(queryChat);
    } else if (selection?.chatId != null) {
      setSelectedChatId(selection.chatId);
    }
  }, []);

  // Once the account list arrives, fall back to the first account.
  useEffect(() => {
    if (accountsLoading) return;
    setSelectedAccountId((current) =>
      current && accounts.some((account) => account.id === current)
        ? current
        : (accounts[0]?.id ?? null),
    );
  }, [accounts, accountsLoading]);

  useEffect(() => {
    if (!selectedAccountId) return;
    try {
      window.localStorage.setItem(LAST_ACCOUNT_KEY, selectedAccountId);
    } catch {
      // Preference persistence is best-effort.
    }
    saveSelection(selectedAccountId, selectedChatId);
  }, [selectedAccountId, selectedChatId]);

  const markRead = useCallback(
    async (accountId: string, chatId: number, maxId?: number) => {
      const before = chatsRef.current.find((chat) => chat.id === chatId);
      const oldReadInboxMaxId = before?.readInboxMaxId ?? 0;
      try {
        await apiFetch(`/accounts/${accountId}/chats/${chatId}/read`, {
          method: "POST",
          body: maxId !== undefined ? { maxId } : {},
        });
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedChatIdRef.current !== chatId
        ) {
          return;
        }
        // A partial read only consumes messages up to `maxId`; the rest of
        // the badge stays. A full read (`maxId` undefined) zeroes it.
        const seen =
          maxId === undefined
            ? 0
            : messagesRef.current.filter(
                (message) =>
                  message.id > oldReadInboxMaxId && message.id <= maxId,
              ).length;
        setChats((previous) =>
          previous.map((chat) => {
            if (chat.id !== chatId) return chat;
            const readInboxMaxId =
              maxId === undefined
                ? Math.max(chat.readInboxMaxId, oldReadInboxMaxId)
                : Math.max(chat.readInboxMaxId, maxId);
            return {
              ...chat,
              readInboxMaxId,
              unreadCount:
                maxId === undefined ? 0 : Math.max(0, chat.unreadCount - seen),
            };
          }),
        );
      } catch {
        // Marking as read is best-effort.
      }
    },
    [],
  );

  const loadChats = useCallback(
    async (
      accountId: string,
      options: { limit: number; folder: ChatFolderSelection },
    ): Promise<ChatView[] | null> => {
      const requestId = chatsRequestRef.current + 1;
      chatsRequestRef.current = requestId;
      setChatsLoading(true);
      setChatsError(null);
      try {
        const list = await listChats(accountId, {
          limit: options.limit,
          folder: options.folder,
        });
        if (chatsRequestRef.current !== requestId) return null;
        setChats(list);
        saveChatList(accountId, list);
        setSelectedChatId((current) =>
          current !== null && list.some((chat) => chat.id === current)
            ? current
            : null,
        );
        return list;
      } catch (error) {
        if (chatsRequestRef.current !== requestId) return null;
        const cached = isOffline(error) ? loadCachedChatList(accountId) : null;
        if (cached && cached.length > 0) {
          setChats(cached);
          setOffline(true);
          setSelectedChatId((current) =>
            current !== null && cached.some((chat) => chat.id === current)
              ? current
              : null,
          );
          return cached;
        }
        setChats([]);
        setChatsError(errorMessage(error));
        return null;
      } finally {
        if (chatsRequestRef.current === requestId) setChatsLoading(false);
      }
    },
    [],
  );

  const loadFolders = useCallback(async (accountId: string) => {
    setFoldersLoading(true);
    try {
      setFolders(await listFolders(accountId));
    } catch {
      // Folders are optional: "Все" and "Архив" always work.
      setFolders([]);
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  /**
   * Merges live and fetched bubbles and keeps the local reasoning map in sync
   * when a temporary id is replaced by the real Telegram id.
   */
  const applyMessages = useCallback(
    (
      incoming: MessageView | MessageView[],
      options: { preferIncoming?: boolean } = {},
    ) => {
      const result = mergeMessages(messagesRef.current, incoming, options);
      messagesRef.current = result.messages;
      setMessages(result.messages);
      if (result.remapped.size > 0) {
        const nextReasoning = remapReasoning(
          reasoningRef.current,
          result.remapped,
        );
        reasoningRef.current = nextReasoning;
        setReasoningByMessage(nextReasoning);
      }
      return result;
    },
    [],
  );

  const rememberReasoning = useCallback(
    (messageId: number, entry: MessageReasoningView) => {
      const next = putReasoning(reasoningRef.current, messageId, entry);
      reasoningRef.current = next;
      setReasoningByMessage(next);
    },
    [],
  );

  const loadMessages = useCallback(
    async (accountId: string, chatId: number, newerThanId?: number) => {
      const requestId = messagesRequestRef.current + 1;
      messagesRequestRef.current = requestId;
      // A reconnect/refresh of the same chat keeps live bubbles so a late
      // temporary-id reply is merged with the fetched page instead of lost.
      const chatKey = `${accountId}:${chatId}`;
      if (messagesChatRef.current !== chatKey) {
        messagesChatRef.current = chatKey;
        messagesRef.current = [];
        setMessages([]);
        reasoningRef.current = new Map();
        setReasoningByMessage(new Map());
      }
      setNextOffsetId(null);
      setMessagesLoading(true);
      setMessagesError(null);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (newerThanId && newerThanId > 0) {
          params.set("newerThanId", String(newerThanId));
        }
        const history = await apiFetch<MessageHistoryView>(
          `/accounts/${accountId}/chats/${chatId}/messages?${params.toString()}`,
          {},
        );
        if (messagesRequestRef.current !== requestId) return;
        const merged = applyMessages(history.messages);
        saveMessages(accountId, chatId, merged.messages);
        setNextOffsetId(history.nextOffsetId);
      } catch (error) {
        if (messagesRequestRef.current !== requestId) return;
        const cached = isOffline(error)
          ? loadCachedMessages(accountId, chatId)
          : null;
        if (cached && cached.length > 0) {
          applyMessages(cached);
          setNextOffsetId(null);
          setMessagesError(null);
          setOffline(true);
        } else {
          setMessages([]);
          setNextOffsetId(null);
          setMessagesError(errorMessage(error));
        }
      } finally {
        if (messagesRequestRef.current === requestId) setMessagesLoading(false);
      }
    },
    [applyMessages],
  );

  /** Silent refresh used when the Socket.IO connection is unavailable. */
  const refreshMessages = useCallback(
    async (accountId: string, chatId: number) => {
      const requestId = messagesRequestRef.current;
      try {
        const history = await apiFetch<MessageHistoryView>(
          `/accounts/${accountId}/chats/${chatId}/messages?limit=50`,
          {},
        );
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedChatIdRef.current !== chatId ||
          messagesRequestRef.current !== requestId
        ) {
          return;
        }
        const merged = applyMessages(history.messages);
        saveMessages(accountId, chatId, merged.messages);
        setNextOffsetId(history.nextOffsetId);
      } catch {
        // Keep the last known messages when polling fails.
      }
    },
    [applyMessages],
  );

  const loadMore = useCallback(async () => {
    const accountId = selectedAccountId;
    const chatId = selectedChatId;
    const offsetId = nextOffsetId;
    if (accountId === null || chatId === null || offsetId === null) {
      return;
    }
    setLoadingMore(true);
    try {
      const history = await apiFetch<MessageHistoryView>(
        `/accounts/${accountId}/chats/${chatId}/messages?limit=50&offsetId=${offsetId}`,
        {},
      );
      // The user may have switched chats while the older page was loading.
      if (
        selectedAccountIdRef.current !== accountId ||
        selectedChatIdRef.current !== chatId
      ) {
        return;
      }
      const merged = applyMessages(history.messages);
      saveMessages(accountId, chatId, merged.messages);
      setNextOffsetId(history.nextOffsetId);
    } catch (error) {
      if (
        selectedAccountIdRef.current === accountId &&
        selectedChatIdRef.current === chatId
      ) {
        setMessagesError(errorMessage(error));
      }
    } finally {
      setLoadingMore(false);
    }
  }, [selectedAccountId, selectedChatId, nextOffsetId, applyMessages]);

  const sendMessage = useCallback(
    async (text: string, replyToId?: number) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      const accountId = selectedAccountId;
      const chatId = selectedChatId;
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        const message = await apiFetch<MessageView>(
          `/accounts/${accountId}/chats/${chatId}/messages`,
          {
            method: "POST",
            body:
              replyToId !== undefined
                ? { text: trimmed, replyToId }
                : { text: trimmed },
          },
        );
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedChatIdRef.current !== chatId
        ) {
          return;
        }
        messagesChatRef.current = `${accountId}:${chatId}`;
        applyMessages(message, { preferIncoming: true });
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === chatId
              ? { ...chat, lastMessage: message, unreadCount: 0 }
              : chat,
          ),
        );
      } catch (error) {
        const textError = errorMessage(error);
        setMessagesError(textError);
        throw new Error(textError);
      }
    },
    [selectedAccountId, selectedChatId, applyMessages],
  );

  const sendMedia = useCallback(
    async (file: File, caption: string, replyToId?: number) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      const accountId = selectedAccountId;
      const chatId = selectedChatId;
      const form = new FormData();
      form.append("file", file);
      const trimmed = caption.trim();
      if (trimmed) form.append("caption", trimmed);
      if (replyToId !== undefined) form.append("replyToId", String(replyToId));
      try {
        const message = await apiFetch<MessageView>(
          `/accounts/${accountId}/chats/${chatId}/media`,
          { method: "POST", formData: form },
        );
        if (
          selectedAccountIdRef.current !== accountId ||
          selectedChatIdRef.current !== chatId
        ) {
          return;
        }
        messagesChatRef.current = `${accountId}:${chatId}`;
        applyMessages(message, { preferIncoming: true });
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === chatId
              ? { ...chat, lastMessage: message, unreadCount: 0 }
              : chat,
          ),
        );
      } catch (error) {
        const textError = errorMessage(error);
        setMessagesError(textError);
        throw new Error(textError);
      }
    },
    [selectedAccountId, selectedChatId, applyMessages],
  );

  const forwardMessages = useCallback(
    async (toChatId: number, messageIds: number[]) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      const accountId = selectedAccountId;
      const chatId = selectedChatId;
      try {
        const result = await apiFetch<ForwardResult>(
          `/accounts/${accountId}/chats/${toChatId}/forward`,
          {
            method: "POST",
            body: { fromChatId: chatId, messageIds },
          },
        );
        showNotice(
          result.forwarded === 1
            ? "Сообщение переслано"
            : `Переслано сообщений: ${result.forwarded}`,
        );
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
    [selectedAccountId, selectedChatId, showNotice],
  );

  const deleteMessages = useCallback(
    async (messageIds: number[], options: { revoke?: boolean } = {}) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      const accountId = selectedAccountId;
      const chatId = selectedChatId;
      let firstError: string | null = null;
      for (const messageId of messageIds) {
        try {
          await deleteMessageRequest(accountId, chatId, messageId, options);
          if (
            selectedAccountIdRef.current !== accountId ||
            selectedChatIdRef.current !== chatId
          ) {
            continue;
          }
          setMessages((previous) =>
            previous.filter((message) => message.id !== messageId),
          );
        } catch (error) {
          firstError ??= errorMessage(error);
        }
      }
      if (firstError) throw new Error(firstError);
    },
    [selectedAccountId, selectedChatId],
  );

  const editMessage = useCallback(
    async (messageId: number, text: string) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      try {
        const edited = await apiFetch<MessageView>(
          `/accounts/${selectedAccountId}/chats/${selectedChatId}/messages/${messageId}`,
          { method: "PATCH", body: { text } },
        );
        setMessages((previous) =>
          previous.map((message) =>
            message.id === edited.id ? edited : message,
          ),
        );
        setChats((previous) =>
          previous.map((chat) =>
            chat.lastMessage?.id === edited.id
              ? { ...chat, lastMessage: edited }
              : chat,
          ),
        );
      } catch (error) {
        setMessagesError(errorMessage(error));
      }
    },
    [selectedAccountId, selectedChatId],
  );

  const replaceMessage = useCallback((message: MessageView) => {
    // Ignore a late response if the user has already switched chats.
    if (selectedChatIdRef.current !== message.chatId) return;
    setMessages((previous) =>
      previous.map((item) => (item.id === message.id ? message : item)),
    );
    setChats((previous) =>
      previous.map((chat) =>
        chat.id === message.chatId && chat.lastMessage?.id === message.id
          ? { ...chat, lastMessage: message }
          : chat,
      ),
    );
  }, []);

  const deleteMessage = useCallback(
    async (messageId: number, options: { revoke?: boolean } = {}) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      try {
        await deleteMessageRequest(
          selectedAccountId,
          selectedChatId,
          messageId,
          options,
        );
        setMessages((previous) =>
          previous.filter((message) => message.id !== messageId),
        );
      } catch (error) {
        setMessagesError(errorMessage(error));
      }
    },
    [selectedAccountId, selectedChatId],
  );

  const sendTyping = useCallback(async () => {
    if (selectedAccountId === null || selectedChatId === null) return;
    try {
      await apiFetch(
        `/accounts/${selectedAccountId}/chats/${selectedChatId}/typing`,
        { method: "POST", body: { status: "typing" } },
      );
    } catch {
      // Typing is best-effort.
    }
  }, [selectedAccountId, selectedChatId]);

  const handleSelectAccount = useCallback((accountId: string) => {
    setSelectedAccountId(accountId);
    setSelectedChatId(null);
    setFocusedMessage(null);
    messagesRequestRef.current += 1;
    setMessages([]);
    setNextOffsetId(null);
    setMessagesError(null);
    setTyping({});
    // Folder and paging state belong to one account only.
    setFolder({ kind: "all" });
    setChatLimit(INITIAL_CHAT_LIMIT);
  }, []);

  const handleSelectChat = useCallback((chatId: number) => {
    // Re-selecting the open chat (e.g. an in-chat search hit) must not wipe a
    // transcript that will not be requested again.
    if (chatId === selectedChatIdRef.current) return;
    // Clear the previous transcript before the new history request starts.
    messagesRequestRef.current += 1;
    setMessages([]);
    setNextOffsetId(null);
    setMessagesError(null);
    setFocusedMessage(null);
    setSelectedChatId(chatId);
  }, []);

  /** Jumps to a search hit inside the open chat without reloading it. */
  const openMessage = useCallback(
    (chatId: number, messageId: number) => {
      if (chatId !== selectedChatIdRef.current) {
        handleSelectChat(chatId);
        return;
      }
      focusNonceRef.current += 1;
      setFocusedMessage({
        chatId,
        messageId,
        nonce: focusNonceRef.current,
      });
    },
    [handleSelectChat],
  );

  const handleSelectFolder = useCallback((selection: ChatFolderSelection) => {
    setFolder(selection);
    setChatLimit(INITIAL_CHAT_LIMIT);
  }, []);

  const applyChatPatch = useCallback(
    async (chatId: number, patch: ChatPatch) => {
      if (!selectedAccountId) throw new Error("Аккаунт не выбран");
      const updated = await updateChat(selectedAccountId, chatId, patch);
      setChats((previous) =>
        previous.map((chat) => (chat.id === chatId ? updated : chat)),
      );
    },
    [selectedAccountId],
  );

  const markChatRead = useCallback(
    async (chatId: number) => {
      if (!selectedAccountId) throw new Error("Аккаунт не выбран");
      await apiFetch(`/accounts/${selectedAccountId}/chats/${chatId}/read`, {
        method: "POST",
        body: {},
      });
      setChats((previous) =>
        previous.map((chat) =>
          chat.id === chatId ? { ...chat, unreadCount: 0 } : chat,
        ),
      );
    },
    [selectedAccountId],
  );

  const clearChatHistory = useCallback(
    async (chatId: number) => {
      if (!selectedAccountId) throw new Error("Аккаунт не выбран");
      await removeChat(selectedAccountId, chatId, {
        clearHistory: true,
      });
      setChats((previous) =>
        previous.map((chat) =>
          chat.id === chatId
            ? { ...chat, lastMessage: null, unreadCount: 0 }
            : chat,
        ),
      );
      if (selectedChatIdRef.current === chatId) setMessages([]);
      showNotice("История очищена");
    },
    [selectedAccountId, showNotice],
  );

  const deleteChatRow = useCallback(
    async (chatId: number, everyone: boolean) => {
      if (!selectedAccountId) throw new Error("Аккаунт не выбран");
      await removeChat(selectedAccountId, chatId, { revoke: everyone });
      setChats((previous) => previous.filter((chat) => chat.id !== chatId));
      if (selectedChatIdRef.current === chatId) {
        setSelectedChatId(null);
        setMessages([]);
        setNextOffsetId(null);
      }
      showNotice(everyone ? "Чат удалён у всех" : "Чат удалён у вас");
    },
    [selectedAccountId, showNotice],
  );

  const markAllChatsRead = useCallback(async () => {
    if (!selectedAccountId) throw new Error("Аккаунт не выбран");
    const result = await markAllRead(selectedAccountId);
    setChats((previous) =>
      previous.map((chat) =>
        chat.unreadCount === 0 ? chat : { ...chat, unreadCount: 0 },
      ),
    );
    showNotice(
      result.read > 0
        ? `Прочитано чатов: ${result.read}`
        : "Непрочитанных чатов нет",
    );
  }, [selectedAccountId, showNotice]);

  /** Adds a chat that is not in the current page (search/resolve hit) and opens it. */
  const openChat = useCallback((chat: ChatView) => {
    setChats((previous) => {
      const existing = previous.find((item) => item.id === chat.id);
      if (!existing) return [chat, ...previous];
      // The peer lookup only knows the identity fields; dialog state
      // (pin/mute/archive/read marker/last message) stays from the real row so
      // resolving a known chat never resets its flags.
      return previous.map((item) =>
        item.id === chat.id
          ? {
              ...item,
              title: chat.title,
              username: chat.username,
              type: chat.type,
            }
          : item,
      );
    });
    messagesRequestRef.current += 1;
    setMessages([]);
    setNextOffsetId(null);
    setMessagesError(null);
    setFocusedMessage(null);
    setSelectedChatId(chat.id);
  }, []);

  const resolveAndOpen = useCallback(
    async (username: string) => {
      if (!selectedAccountId) throw new Error("Аккаунт не выбран");
      const chat = await resolveChat(selectedAccountId, username);
      openChat(chat);
    },
    [selectedAccountId, openChat],
  );

  const refreshChats = useCallback(() => {
    if (!selectedAccountId) return;
    void loadChats(selectedAccountId, { limit: chatLimit, folder });
    void loadFolders(selectedAccountId);
  }, [selectedAccountId, chatLimit, folder, loadChats, loadFolders]);

  const loadMoreChats = useCallback(() => {
    const next = nextChatLimit(chatLimit);
    if (next !== null) setChatLimit(next);
  }, [chatLimit]);

  // Network state for the offline banner; reconnecting refetches what the
  // cached snapshot showed.
  useEffect(() => {
    setOffline(isOffline());

    const handleOffline = () => setOffline(true);
    const handleOnline = () => {
      setOffline(false);
      setOfflineBannerDismissed(false);
      void reloadAccounts();
      refreshChats();
      const accountId = selectedAccountIdRef.current;
      const chatId = selectedChatIdRef.current;
      if (accountId && chatId !== null) void loadMessages(accountId, chatId);
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [reloadAccounts, refreshChats, loadMessages]);

  // The active session changed, so its engine (TDLib or mtcute) may have
  // changed too: the cached chat ids and the open transcript belong to the
  // previous engine and must be fetched again instead of shown or acted on.
  useEffect(() => {
    const handleSessionChanged = (event: Event) => {
      const detail = (event as CustomEvent<Partial<SessionChangedDetail>>)
        .detail;
      const accountId = selectedAccountIdRef.current;
      if (!accountId || detail?.accountId !== accountId) return;
      setOffline(false);
      setChats([]);
      setChatsError(null);
      messagesRequestRef.current += 1;
      setMessages([]);
      setNextOffsetId(null);
      setMessagesError(null);
      setFocusedMessage(null);
      void (async () => {
        const list = await loadChats(accountId, { limit: chatLimit, folder });
        // A newer request or an account switch wins over this reload.
        if (!list || selectedAccountIdRef.current !== accountId) return;
        const chatId = selectedChatIdRef.current;
        if (chatId !== null && list.some((chat) => chat.id === chatId)) {
          void loadMessages(accountId, chatId);
        }
      })();
    };

    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    };
  }, [chatLimit, folder, loadChats, loadMessages]);

  useEffect(() => {
    if (!selectedAccountId) {
      chatsRequestRef.current += 1;
      messagesRequestRef.current += 1;
      setChats([]);
      setChatsError(null);
      setSelectedChatId(null);
      setFolders([]);
      return;
    }
    void loadChats(selectedAccountId, { limit: chatLimit, folder });
  }, [selectedAccountId, folder, chatLimit, loadChats]);

  useEffect(() => {
    if (!selectedAccountId) {
      setFolders([]);
      return;
    }
    void loadFolders(selectedAccountId);
  }, [selectedAccountId, loadFolders]);

  useEffect(() => {
    if (selectedAccountId === null || selectedChatId === null) {
      messagesRequestRef.current += 1;
      setMessages([]);
      setNextOffsetId(null);
      setMessagesError(null);
      return;
    }
    const chat = selectedChatRef.current;
    const newerThanId =
      chat && chat.unreadCount > 0 && chat.readInboxMaxId > 0
        ? chat.readInboxMaxId
        : undefined;
    void loadMessages(selectedAccountId, selectedChatId, newerThanId);
  }, [selectedAccountId, selectedChatId, loadMessages]);

  // One request per opened chat decorates every bot bubble with its run.
  useEffect(() => {
    if (selectedAccountId === null || selectedChatId === null) {
      reasoningRef.current = new Map();
      setReasoningByMessage(new Map());
      return;
    }
    let active = true;
    reasoningRef.current = new Map();
    setReasoningByMessage(new Map());
    listChatRuns(selectedAccountId, selectedChatId)
      .then(({ runs }) => {
        if (!active) return;
        const next = new Map<number, MessageReasoningView>();
        for (const run of runs) {
          const reasoning = run.reasoning?.trim();
          if (!reasoning || run.messageIds.length === 0) continue;
          const messageId = Number(run.messageIds[run.messageIds.length - 1]);
          if (!Number.isFinite(messageId) || next.has(messageId)) continue;
          // A run can send several bubbles; the block goes under the last one.
          next.set(messageId, {
            runId: run.id,
            reasoning,
            bubbles: run.messageIds.length,
            createdAt: run.createdAt,
          });
        }
        // Keep a reasoning that arrived live while the request was in flight,
        // but never let one run decorate two bubbles: the loaded mapping wins.
        const runIds = new Set([...next.values()].map((value) => value.runId));
        for (const [messageId, value] of reasoningRef.current) {
          if (next.has(messageId) || runIds.has(value.runId)) continue;
          next.set(messageId, value);
          runIds.add(value.runId);
        }
        reasoningRef.current = next;
        setReasoningByMessage(next);
      })
      .catch(() => {
        // Reasoning is decorative: a failed request renders no blocks.
      });
    return () => {
      active = false;
    };
  }, [selectedAccountId, selectedChatId]);

  // Realtime events are published to the shared bus by the app-wide socket.
  useEffect(() => {
    return subscribeRealtime(({ event, payload }) => {
      if (event === "ai.reply") {
        const data = payload as AiReplyEvent;
        if (data.accountId !== selectedAccountId) return;
        const message = data.message;
        // The autopilot emits ai.reply after sending the bubble. Telegram also
        // reports it as message.new; a slow TDLib send may carry a temporary id
        // in one of the two events, so the merge matches by id *and* by a
        // signature and moves the reasoning to the surviving bubble.
        if (data.chatId === selectedChatId && selectedAccountId !== null) {
          messagesChatRef.current = `${selectedAccountId}:${data.chatId}`;
          const merged = applyMessages(message, { preferIncoming: true });
          const canonicalId = merged.canonicalId ?? Number(message.id);
          const reasoning = data.reasoning?.trim();
          if (reasoning && Number.isFinite(canonicalId)) {
            rememberReasoning(canonicalId, {
              runId: data.runId,
              reasoning,
              bubbles: 1,
              createdAt: new Date().toISOString(),
            });
          }
        }
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === data.chatId
              ? { ...chat, lastMessage: message, unreadCount: 0 }
              : chat,
          ),
        );
        return;
      }

      if (event === "message.new") {
        const data = payload as RealtimeMessageEvent;
        const message = data.message;

        // Desktop notification: only for incoming messages and only while the
        // window is hidden or unfocused. The bell toggle is read from storage
        // so changes made in the header apply immediately. Muted chats never
        // notify, matching the official clients.
        const hidden =
          document.visibilityState !== "visible" || !document.hasFocus();
        const listedChat =
          data.accountId === selectedAccountIdRef.current
            ? chatsRef.current.find((chat) => chat.id === data.chatId)
            : undefined;
        if (!message.outgoing && !listedChat?.muted) {
          if (hidden && notificationsReady()) {
            showMessageNotification(
              listedChat?.title ?? `Чат ${data.chatId}`,
              message.senderName,
              message.text ||
                (message.mediaType ? `[${message.mediaType}]` : ""),
              data.chatId,
            );
          }
          // Chime whenever the message is not already in front of the user:
          // the window is hidden/unfocused or another chat is open.
          const lookingAtChat =
            data.accountId === selectedAccountIdRef.current &&
            data.chatId === selectedChatIdRef.current;
          if ((hidden || !lookingAtChat) && readSoundEnabled()) playChime();
        }

        if (data.accountId !== selectedAccountId) return;
        if (data.chatId === selectedChatId && selectedAccountId !== null) {
          messagesChatRef.current = `${selectedAccountId}:${data.chatId}`;
          applyMessages(message, { preferIncoming: true });
        }
        setChats((previous) =>
          previous.map((chat) => {
            if (chat.id !== data.chatId) return chat;
            if (data.chatId === selectedChatId) {
              return { ...chat, lastMessage: message, unreadCount: 0 };
            }
            return {
              ...chat,
              lastMessage: message,
              unreadCount: message.outgoing
                ? chat.unreadCount
                : chat.unreadCount + 1,
            };
          }),
        );
        return;
      }

      if (event === "message.edited") {
        const data = payload as RealtimeMessageEvent;
        if (data.accountId !== selectedAccountId) return;
        const message = data.message;
        if (data.chatId === selectedChatId && selectedAccountId !== null) {
          messagesChatRef.current = `${selectedAccountId}:${data.chatId}`;
          applyMessages(message, { preferIncoming: true });
        }
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === data.chatId && chat.lastMessage?.id === message.id
              ? { ...chat, lastMessage: message }
              : chat,
          ),
        );
        return;
      }

      if (event === "message.deleted") {
        const data = payload as RealtimeDeletedEvent;
        if (data.accountId !== selectedAccountId) return;
        if (data.chatId !== null && data.chatId === selectedChatId) {
          const deleted = new Set(data.messageIds.map(Number));
          const nextMessages = messagesRef.current.filter(
            (message) => !deleted.has(Number(message.id)),
          );
          messagesRef.current = nextMessages;
          setMessages(nextMessages);
          const nextReasoning = new Map(reasoningRef.current);
          for (const id of deleted) nextReasoning.delete(id);
          reasoningRef.current = nextReasoning;
          setReasoningByMessage(nextReasoning);
        }
        return;
      }

      if (event === "message.read") {
        const data = payload as RealtimeReadEvent;
        if (data.accountId !== selectedAccountId) return;
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === data.chatId
              ? { ...chat, unreadCount: data.unread }
              : chat,
          ),
        );
        return;
      }

      if (event === "chat.typing") {
        const data = payload as RealtimeTypingEvent;
        if (data.accountId !== selectedAccountId) return;
        const key = String(data.chatId);
        setTyping((previous) => {
          const list = (previous[key] ?? []).filter(
            (entry) => entry.userId !== data.userId,
          );
          if (data.status !== "cancel") {
            list.push({
              userId: data.userId,
              status: data.status,
              until: Date.now() + 6000,
            });
          }
          return { ...previous, [key]: list };
        });
      }
    });
  }, [selectedAccountId, selectedChatId, applyMessages, rememberReasoning]);

  // Drop expired "typing" indicators even if no cancel event arrives.
  useEffect(() => {
    const timer = setInterval(() => {
      setTyping((previous) => {
        let changed = false;
        const next: Record<string, TypingEntry[]> = {};
        for (const [key, entries] of Object.entries(previous)) {
          const live = entries.filter((entry) => entry.until > Date.now());
          if (live.length !== entries.length) changed = true;
          next[key] = live;
        }
        return changed ? next : previous;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Fallback: poll the open chat while the Socket.IO connection is down.
  useEffect(() => {
    if (
      realtimeOnline ||
      selectedAccountId === null ||
      selectedChatId === null
    ) {
      return;
    }
    const timer = setInterval(() => {
      void refreshMessages(selectedAccountId, selectedChatId);
    }, 5000);
    return () => clearInterval(timer);
  }, [realtimeOnline, selectedAccountId, selectedChatId, refreshMessages]);

  const selectedAccount =
    accounts.find((account) => account.id === selectedAccountId) ?? null;
  const selectedChat = chats.find((chat) => chat.id === selectedChatId) ?? null;
  selectedChatRef.current = selectedChat;
  const chatTyping =
    selectedChatId === null ? [] : (typing[String(selectedChatId)] ?? []);

  // Stable identity: `ChatWindow` re-creates its IntersectionObserver when this
  // changes, so it must not be a fresh inline arrow on every render.
  const handleRead = useCallback(
    (maxId: number) => {
      if (selectedAccountId && selectedChatId !== null) {
        void markRead(selectedAccountId, selectedChatId, maxId);
      }
    },
    [selectedAccountId, selectedChatId, markRead],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {offline && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-900/60 bg-amber-950/40 px-4 py-1.5 text-xs text-amber-200">
          {offlineBannerDismissed ? (
            <span />
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">
                Нет сети — показаны сохранённые сообщения
              </span>
              <span className="hidden shrink-0 text-[11px] text-amber-300/70 sm:inline">
                данные могут быть устаревшими
              </span>
              <button
                type="button"
                onClick={() => setOfflineBannerDismissed(true)}
                className="shrink-0 rounded px-1 text-amber-300/80 hover:bg-amber-900/60 hover:text-amber-100"
                aria-label="Скрыть сообщение об офлайне"
              >
                Скрыть
              </button>
            </span>
          )}
          <span className="shrink-0 rounded-full border border-amber-800/70 px-2 py-0.5 text-[11px] text-amber-200">
            Вы офлайн
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-x-auto">
        <AccountsSidebar
          accounts={accounts}
          loading={accountsLoading}
          error={accountsError}
          selectedId={selectedAccountId}
          onSelect={handleSelectAccount}
          onAdd={openAddAccount}
          onRefresh={() => void reloadAccounts()}
        />

        <AiAccessProvider accountId={selectedAccount?.id ?? null}>
          <ChatList
            hasAccount={Boolean(selectedAccount)}
            chats={chats}
            loading={chatsLoading}
            error={chatsError}
            selectedId={selectedChatId}
            onSelect={handleSelectChat}
            accountLabel={
              selectedAccount
                ? accountName(selectedAccount)
                : "Аккаунт не выбран"
            }
            accountId={selectedAccount?.id ?? null}
            onRefresh={refreshChats}
            folders={folders}
            foldersLoading={foldersLoading}
            selectedFolder={folder}
            onSelectFolder={handleSelectFolder}
            canLoadMore={
              nextChatLimit(chatLimit) !== null && chats.length >= chatLimit
            }
            loadingMore={chatsLoading}
            onLoadMore={loadMoreChats}
            onUpdateChat={applyChatPatch}
            onMarkRead={markChatRead}
            onClearHistory={clearChatHistory}
            onDeleteChat={deleteChatRow}
            onReadAll={markAllChatsRead}
            onOpenChat={openChat}
            onOpenMessage={openMessage}
            onResolveUsername={resolveAndOpen}
          />

          <ChatWindow
            account={selectedAccount}
            chat={selectedChat}
            chats={chats}
            messages={messages}
            loading={messagesLoading}
            error={messagesError}
            nextOffsetId={nextOffsetId}
            loadingMore={loadingMore}
            reasoningByMessage={reasoningByMessage}
            typing={chatTyping}
            onLoadMore={() => void loadMore()}
            onSend={(text, replyToId) => sendMessage(text, replyToId)}
            onSendMedia={(file, caption, replyToId) =>
              sendMedia(file, caption, replyToId)
            }
            onEdit={(messageId, text) => void editMessage(messageId, text)}
            onMessageUpdated={replaceMessage}
            onDelete={(messageId) => void deleteMessage(messageId)}
            onDeleteMany={deleteMessages}
            onForward={forwardMessages}
            onTyping={() => void sendTyping()}
            onRead={handleRead}
            onOpenChat={handleSelectChat}
            focusMessage={focusedMessage}
          />
        </AiAccessProvider>
      </div>
    </div>
  );
}
