"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
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
import { subscribeRealtime } from "../../lib/realtime-bus";
import type {
  ChatFolderSelection,
  ChatPatch,
  ChatView,
  FolderView,
  ForwardResult,
  MessageHistoryView,
  MessageView,
  RealtimeDeletedEvent,
  RealtimeMessageEvent,
  RealtimeReadEvent,
  RealtimeTypingEvent,
  TypingEntry,
} from "../../lib/types";
import { AccountsSidebar } from "../messenger/accounts-sidebar";
import { ChatList } from "../messenger/chat-list";
import { ChatWindow } from "../messenger/chat-window";
import { useAppData } from "./app-data";

const LAST_ACCOUNT_KEY = "ct:last-account";

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
  const selectedChatRef = useRef<ChatView | null>(null);
  const chatsRef = useRef<ChatView[]>([]);
  chatsRef.current = chats;
  const messagesRef = useRef<MessageView[]>([]);
  messagesRef.current = messages;
  const selectedAccountIdRef = useRef<string | null>(null);
  selectedAccountIdRef.current = selectedAccountId;
  const selectedChatIdRef = useRef<number | null>(null);
  selectedChatIdRef.current = selectedChatId;
  const chatsRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);

  // Remember the last opened account and honor ?account=<id> links from the
  // accounts page.
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get(
      "account",
    );
    let fromStorage: string | null = null;
    try {
      fromStorage = window.localStorage.getItem(LAST_ACCOUNT_KEY);
    } catch {
      // Private mode or a blocked storage must not break the page.
    }
    setSelectedAccountId(fromQuery ?? fromStorage);
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
  }, [selectedAccountId]);

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
    ) => {
      const requestId = chatsRequestRef.current + 1;
      chatsRequestRef.current = requestId;
      setChatsLoading(true);
      setChatsError(null);
      try {
        const list = await listChats(accountId, {
          limit: options.limit,
          folder: options.folder,
        });
        if (chatsRequestRef.current !== requestId) return;
        setChats(list);
        setSelectedChatId((current) =>
          current !== null && list.some((chat) => chat.id === current)
            ? current
            : null,
        );
      } catch (error) {
        if (chatsRequestRef.current !== requestId) return;
        setChats([]);
        setChatsError(errorMessage(error));
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

  const loadMessages = useCallback(
    async (accountId: string, chatId: number, newerThanId?: number) => {
      const requestId = messagesRequestRef.current + 1;
      messagesRequestRef.current = requestId;
      // Never leave the previous chat's transcript under the new header while
      // the history request is in flight.
      setMessages([]);
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
        setMessages(history.messages);
        setNextOffsetId(history.nextOffsetId);
      } catch (error) {
        if (messagesRequestRef.current !== requestId) return;
        setMessages([]);
        setNextOffsetId(null);
        setMessagesError(errorMessage(error));
      } finally {
        if (messagesRequestRef.current === requestId) setMessagesLoading(false);
      }
    },
    [],
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
        setMessages(history.messages);
        setNextOffsetId(history.nextOffsetId);
      } catch {
        // Keep the last known messages when polling fails.
      }
    },
    [],
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
      setMessages((previous) => {
        const existing = new Set(previous.map((message) => message.id));
        const older = history.messages.filter(
          (message) => !existing.has(message.id),
        );
        return [...older, ...previous];
      });
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
  }, [selectedAccountId, selectedChatId, nextOffsetId]);

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
        setMessages((previous) =>
          previous.some((item) => item.id === message.id)
            ? previous
            : [...previous, message],
        );
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
    [selectedAccountId, selectedChatId],
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
        setMessages((previous) =>
          previous.some((item) => item.id === message.id)
            ? previous
            : [...previous, message],
        );
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
    [selectedAccountId, selectedChatId],
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
    // Clear the previous transcript before the new history request starts.
    messagesRequestRef.current += 1;
    setMessages([]);
    setNextOffsetId(null);
    setMessagesError(null);
    setSelectedChatId(chatId);
  }, []);

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

  // Realtime events are published to the shared bus by the app-wide socket.
  useEffect(() => {
    return subscribeRealtime(({ event, payload }) => {
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
        if (
          !message.outgoing &&
          hidden &&
          !listedChat?.muted &&
          notificationsReady()
        ) {
          showMessageNotification(
            listedChat?.title ?? `Чат ${data.chatId}`,
            message.senderName,
            message.text || (message.mediaType ? `[${message.mediaType}]` : ""),
            data.chatId,
          );
        }

        if (data.accountId !== selectedAccountId) return;
        setMessages((previous) => {
          if (data.chatId !== selectedChatId) return previous;
          if (previous.some((item) => item.id === message.id)) return previous;
          return [...previous, message];
        });
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
        setMessages((previous) =>
          data.chatId === selectedChatId
            ? previous.map((item) => (item.id === message.id ? message : item))
            : previous,
        );
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
          setMessages((previous) =>
            previous.filter((message) => !data.messageIds.includes(message.id)),
          );
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
  }, [selectedAccountId, selectedChatId]);

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
    <div className="flex h-full min-h-0 overflow-x-auto">
      <AccountsSidebar
        accounts={accounts}
        loading={accountsLoading}
        error={accountsError}
        selectedId={selectedAccountId}
        onSelect={handleSelectAccount}
        onAdd={openAddAccount}
        onRefresh={() => void reloadAccounts()}
      />

      <ChatList
        hasAccount={Boolean(selectedAccount)}
        chats={chats}
        loading={chatsLoading}
        error={chatsError}
        selectedId={selectedChatId}
        onSelect={handleSelectChat}
        accountLabel={
          selectedAccount ? accountName(selectedAccount) : "Аккаунт не выбран"
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
        typing={chatTyping}
        onLoadMore={() => void loadMore()}
        onSend={(text, replyToId) => sendMessage(text, replyToId)}
        onSendMedia={(file, caption, replyToId) =>
          sendMedia(file, caption, replyToId)
        }
        onEdit={(messageId, text) => void editMessage(messageId, text)}
        onDelete={(messageId) => void deleteMessage(messageId)}
        onDeleteMany={deleteMessages}
        onForward={forwardMessages}
        onTyping={() => void sendTyping()}
        onRead={handleRead}
        onOpenChat={handleSelectChat}
      />
    </div>
  );
}
