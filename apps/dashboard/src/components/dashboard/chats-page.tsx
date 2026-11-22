"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
import { subscribeRealtime } from "../../lib/realtime-bus";
import type {
  ChatView,
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
  } = useAppData();

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null,
  );

  const [chats, setChats] = useState<ChatView[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);

  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextOffsetId, setNextOffsetId] = useState<number | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [typing, setTyping] = useState<Record<string, TypingEntry[]>>({});
  const selectedChatRef = useRef<ChatView | null>(null);

  // Remember the last opened account and honor ?account=<id> links from the
  // accounts page.
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get(
      "account",
    );
    const fromStorage = window.localStorage.getItem(LAST_ACCOUNT_KEY);
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
    window.localStorage.setItem(LAST_ACCOUNT_KEY, selectedAccountId);
  }, [selectedAccountId]);

  const markRead = useCallback(
    async (accountId: string, chatId: number, maxId?: number) => {
      try {
        await apiFetch(`/accounts/${accountId}/chats/${chatId}/read`, {
          method: "POST",
          body: maxId !== undefined ? { maxId } : {},
        });
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === chatId ? { ...chat, unreadCount: 0 } : chat,
          ),
        );
      } catch {
        // Marking as read is best-effort.
      }
    },
    [],
  );

  const loadChats = useCallback(async (accountId: string) => {
    setChatsLoading(true);
    setChatsError(null);
    try {
      const list = await apiFetch<ChatView[]>(
        `/accounts/${accountId}/chats?limit=50`,
        {},
      );
      setChats(list);
      setSelectedChatId((current) =>
        current !== null && list.some((chat) => chat.id === current)
          ? current
          : null,
      );
    } catch (error) {
      setChats([]);
      setChatsError(errorMessage(error));
    } finally {
      setChatsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(
    async (accountId: string, chatId: number, newerThanId?: number) => {
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
        setMessages(history.messages);
        setNextOffsetId(history.nextOffsetId);
      } catch (error) {
        setMessages([]);
        setNextOffsetId(null);
        setMessagesError(errorMessage(error));
      } finally {
        setMessagesLoading(false);
      }
    },
    [],
  );

  /** Silent refresh used when the Socket.IO connection is unavailable. */
  const refreshMessages = useCallback(
    async (accountId: string, chatId: number) => {
      try {
        const history = await apiFetch<MessageHistoryView>(
          `/accounts/${accountId}/chats/${chatId}/messages?limit=50`,
          {},
        );
        setMessages(history.messages);
        setNextOffsetId(history.nextOffsetId);
      } catch {
        // Keep the last known messages when polling fails.
      }
    },
    [],
  );

  const loadMore = useCallback(async () => {
    if (
      selectedAccountId === null ||
      selectedChatId === null ||
      nextOffsetId === null
    ) {
      return;
    }
    setLoadingMore(true);
    try {
      const history = await apiFetch<MessageHistoryView>(
        `/accounts/${selectedAccountId}/chats/${selectedChatId}/messages?limit=50&offsetId=${nextOffsetId}`,
        {},
      );
      setMessages((previous) => {
        const existing = new Set(previous.map((message) => message.id));
        const older = history.messages.filter(
          (message) => !existing.has(message.id),
        );
        return [...older, ...previous];
      });
      setNextOffsetId(history.nextOffsetId);
    } catch (error) {
      setMessagesError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }, [selectedAccountId, selectedChatId, nextOffsetId]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        const message = await apiFetch<MessageView>(
          `/accounts/${selectedAccountId}/chats/${selectedChatId}/messages`,
          { method: "POST", body: { text: trimmed } },
        );
        setMessages((previous) =>
          previous.some((item) => item.id === message.id)
            ? previous
            : [...previous, message],
        );
        setChats((previous) =>
          previous.map((chat) =>
            chat.id === selectedChatId
              ? { ...chat, lastMessage: message, unreadCount: 0 }
              : chat,
          ),
        );
      } catch (error) {
        setMessagesError(errorMessage(error));
      }
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
    async (messageId: number) => {
      if (selectedAccountId === null || selectedChatId === null) return;
      try {
        await apiFetch(
          `/accounts/${selectedAccountId}/chats/${selectedChatId}/messages/${messageId}`,
          { method: "DELETE" },
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
    setMessages([]);
    setNextOffsetId(null);
    setMessagesError(null);
    setTyping({});
  }, []);

  const handleSelectChat = useCallback((chatId: number) => {
    setSelectedChatId(chatId);
  }, []);

  useEffect(() => {
    if (!selectedAccountId) {
      setChats([]);
      setChatsError(null);
      setSelectedChatId(null);
      return;
    }
    void loadChats(selectedAccountId);
  }, [selectedAccountId, loadChats]);

  useEffect(() => {
    if (selectedAccountId === null || selectedChatId === null) {
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
        if (data.accountId !== selectedAccountId) return;
        const message = data.message;
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
        onRefresh={() =>
          selectedAccountId ? void loadChats(selectedAccountId) : undefined
        }
      />

      <ChatWindow
        account={selectedAccount}
        chat={selectedChat}
        messages={messages}
        loading={messagesLoading}
        error={messagesError}
        nextOffsetId={nextOffsetId}
        loadingMore={loadingMore}
        typing={chatTyping}
        onLoadMore={() => void loadMore()}
        onSend={(text) => void sendMessage(text)}
        onEdit={(messageId, text) => void editMessage(messageId, text)}
        onDelete={(messageId) => void deleteMessage(messageId)}
        onTyping={() => void sendTyping()}
        onRead={(maxId) => {
          if (selectedAccountId && selectedChatId !== null) {
            void markRead(selectedAccountId, selectedChatId, maxId);
          }
        }}
      />
    </div>
  );
}
