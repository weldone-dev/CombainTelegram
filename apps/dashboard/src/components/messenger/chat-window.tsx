"use client";

import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { errorMessage, mediaUrl } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import { copyToClipboard } from "../../lib/clipboard";
import {
  clearDraft,
  draftStorageKey,
  readDraft,
  writeDraft,
} from "../../lib/drafts";
import { formatFileSize, formatTime } from "../../lib/format";
import {
  hasMediaBody,
  readAiFramesPreference,
  resolveMediaKind,
  writeAiFramesPreference,
} from "../../lib/media-url";
import {
  MAX_MEDIA_UPLOAD_BYTES,
  sendMessageReaction,
  sendPollVote,
  transcribeMessage,
  translateMessage,
} from "../../lib/messaging-api";
import { subscribeRealtime } from "../../lib/realtime-bus";
import type {
  AccountView,
  ChatView,
  MessagePollView,
  MessageReactionView,
  MessageTranscriptionView,
  MessageView,
  RealtimeMessageEvent,
  TypingEntry,
} from "../../lib/types";
import { Avatar } from "../avatar";
import { ChatInfoPanel } from "./chat-info-panel";
import { CommentThreadDrawer } from "./comment-thread-drawer";
import { ForwardModal } from "./forward-modal";
import { MessageText } from "./message-text";
import {
  AnimationBubble,
  AudioBubble,
  StickerBubble,
  VideoBubble,
  VideoNoteBubble,
} from "./sticker-bubble";
import { VoiceBubble } from "./voice-bubble";

/** Emoji offered by the inline reaction picker. */
const REACTION_EMOJI = [
  "👍",
  "❤️",
  "🔥",
  "😂",
  "😮",
  "😢",
  "🙏",
  "👏",
  "🎉",
  "💯",
];

/** Target languages of the per-message translation action. */
const TRANSLATE_LANGS: ReadonlyArray<readonly [string, string]> = [
  ["ru", "RU"],
  ["en", "EN"],
  ["uk", "UK"],
  ["de", "DE"],
  ["es", "ES"],
  ["fr", "FR"],
];

const TRANSLATE_LANG_KEY = "tg-translate-lang";

function messagePreview(message: MessageView | undefined): string {
  if (!message) return "";
  const text = message.text.trim();
  if (text) return text;
  return message.mediaType ? `[${message.mediaType}]` : "(без текста)";
}

/**
 * Local copy of one reaction change, used for the optimistic update until the
 * API/realtime refresh arrives. Telegram chats keep a single chosen reaction,
 * so adding one clears the previous choice.
 */
function applyReactionChange(
  current: MessageReactionView[],
  emoji: string,
  add: boolean,
): MessageReactionView[] {
  if (!add) {
    return current
      .map((reaction) =>
        reaction.emoji === emoji
          ? { ...reaction, count: reaction.count - 1, chosen: false }
          : reaction,
      )
      .filter((reaction) => reaction.count > 0);
  }
  const exists = current.some((reaction) => reaction.emoji === emoji);
  const cleared = current.map((reaction) => ({ ...reaction, chosen: false }));
  if (exists) {
    return cleared.map((reaction) =>
      reaction.emoji === emoji
        ? { ...reaction, count: reaction.count + 1, chosen: true }
        : reaction,
    );
  }
  return [...cleared, { emoji, count: 1, chosen: true }];
}

export function ChatWindow({
  account,
  chat,
  chats,
  messages,
  loading,
  error,
  nextOffsetId,
  loadingMore,
  typing,
  onLoadMore,
  onSend,
  onSendMedia,
  onEdit,
  onMessageUpdated,
  onDelete,
  onDeleteMany,
  onForward,
  onTyping,
  onRead,
  onOpenChat,
  focusMessage,
}: {
  account: AccountView | null;
  chat: ChatView | null;
  /** Loaded chats of the active account, used by the forward picker. */
  chats: ChatView[];
  messages: MessageView[];
  loading: boolean;
  error: string | null;
  nextOffsetId: number | null;
  loadingMore: boolean;
  typing: TypingEntry[];
  onLoadMore: () => void;
  onSend: (text: string, replyToId?: number) => Promise<void>;
  onSendMedia: (
    file: File,
    caption: string,
    replyToId?: number,
  ) => Promise<void>;
  onEdit: (messageId: number, text: string) => void;
  /** Replaces one message in the transcript with the authoritative server copy. */
  onMessageUpdated: (message: MessageView) => void;
  onDelete: (messageId: number, options?: { revoke?: boolean }) => void;
  onDeleteMany: (
    messageIds: number[],
    options?: { revoke?: boolean },
  ) => Promise<void>;
  onForward: (toChatId: number, messageIds: number[]) => Promise<void>;
  onTyping: () => void;
  /** Called with the newest visible id once the user is at the bottom. */
  onRead: (maxId: number) => void;
  /** Opens another chat from the info panel's "Похожие" list. */
  onOpenChat?: (chatId: number) => void;
  /** Scrolls to and highlights a message picked in the in-chat search. */
  focusMessage?: {
    chatId: number;
    messageId: number;
    nonce: number;
  } | null;
}) {
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(
    null,
  );
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [forwardIds, setForwardIds] = useState<number[] | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [threadFor, setThreadFor] = useState<MessageView | null>(null);
  /** Debug-only AI frame collages, off/on per browser (default on). */
  const [showAiFrames, setShowAiFrames] = useState(true);
  const [threadCounts, setThreadCounts] = useState<Map<number, number>>(
    () => new Map(),
  );
  const [translateLang, setTranslateLang] = useState("ru");
  const [reactionPending, setReactionPending] = useState<Set<number>>(
    () => new Set(),
  );
  // Optimistic chip, kept only while the request is in flight and dropped as
  // soon as the authoritative message (API or realtime) replaces it.
  const [reactionOptimistic, setReactionOptimistic] = useState<
    Map<number, { message: MessageView; reactions: MessageReactionView[] }>
  >(() => new Map());
  const [emojiPickerFor, setEmojiPickerFor] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [pollOverrides, setPollOverrides] = useState<
    Map<number, { base: MessageView["poll"]; value: MessagePollView }>
  >(() => new Map());
  const [votingId, setVotingId] = useState<number | null>(null);
  const [translations, setTranslations] = useState<
    Map<number, { text: string; to: string }>
  >(() => new Map());
  const [translating, setTranslating] = useState<Set<number>>(() => new Set());
  const [transcripts, setTranscripts] = useState<
    Map<number, MessageTranscriptionView>
  >(() => new Map());
  const [transcribing, setTranscribing] = useState<Set<number>>(
    () => new Set(),
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcribingRef = useRef<Set<number>>(new Set());
  const handledFocusRef = useRef(0);
  const stickRef = useRef(true);
  const sendingRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const activeChatRef = useRef<number | null>(null);
  const pendingUnreadRef = useRef(0);
  const readUpToRef = useRef(0);
  const [unreadAnchor, setUnreadAnchor] = useState(0);

  const accountId = account?.id ?? null;
  const chatId = chat?.id ?? null;

  // The frame-collage switch is a device preference shared by all accounts.
  // It is read after mount so server and client markup stay identical.
  useEffect(() => {
    setShowAiFrames(readAiFramesPreference());
  }, []);

  const toggleAiFrames = useCallback(() => {
    setShowAiFrames((current) => {
      const next = !current;
      writeAiFramesPreference(next);
      return next;
    });
  }, []);

  const draftKey =
    accountId !== null && chatId !== null
      ? draftStorageKey(accountId, chatId)
      : null;
  const draftKeyRef = useRef<string | null>(draftKey);
  draftKeyRef.current = draftKey;

  const visible = [...messages].reverse();
  const activeTyping = typing.filter((entry) => entry.until > Date.now());

  // The info panel belongs to one chat: switching chats closes it.
  // `chat` updates for unread counts too, so compare ids before resetting.
  const infoChatRef = useRef<number | null>(chat?.id ?? null);
  useEffect(() => {
    const id = chat?.id ?? null;
    if (infoChatRef.current === id) return;
    infoChatRef.current = id;
    setInfoOpen(false);
  }, [chat]);

  const closeInfo = useCallback(() => setInfoOpen(false), []);

  const threadCount = (message: MessageView) =>
    threadCounts.get(message.id) ?? message.thread?.comments ?? 0;

  const openThreadChatId = threadFor?.thread?.discussionChatId ?? null;

  // Keep the counter under an open thread in sync with new comments arriving
  // through the discussion chat, without refetching the whole thread.
  useEffect(() => {
    if (threadFor === null || openThreadChatId === null || !accountId) return;
    const messageId = threadFor.id;
    const base = threadFor.thread?.comments ?? 0;
    return subscribeRealtime(({ event, payload }) => {
      if (event !== "message.new") return;
      const data = payload as RealtimeMessageEvent;
      if (data.accountId !== accountId || data.chatId !== openThreadChatId) {
        return;
      }
      if (data.message.id === messageId) return;
      // The composer already bumps the counter for our own comments.
      if (data.message.outgoing) return;
      setThreadCounts((previous) => {
        const next = new Map(previous);
        next.set(messageId, (next.get(messageId) ?? base) + 1);
        return next;
      });
    });
  }, [accountId, threadFor, openThreadChatId]);

  // Restore the per-account/per-chat draft and reset transient composer state
  // whenever the open chat changes. localStorage is only touched here.
  useEffect(() => {
    setAttachment(null);
    setAttachmentPreview(null);
    if (!draftKey) {
      setDraft("");
      return;
    }
    setDraft(readDraft(draftKey));
    setEditingId(null);
    setEditDraft("");
    setReplyTo(null);
    setSelecting(false);
    setSelected(new Set());
    setForwardIds(null);
    setStatus(null);
    setEmojiPickerFor(null);
    setMenuFor(null);
    setReactionOptimistic(new Map());
    setReactionPending(new Set());
    setPollOverrides(new Map());
    setVotingId(null);
    setTranslations(new Map());
    setTranslating(new Set());
    setTranscripts(new Map());
    setTranscribing(new Set());
    setThreadFor(null);
    setThreadCounts(new Map());
  }, [draftKey]);

  // The translate target is a user preference, restored after mount so the
  // server-rendered default (`ru`) and the client markup stay identical.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TRANSLATE_LANG_KEY);
      if (saved && /^[a-z]{2}$/.test(saved)) setTranslateLang(saved);
    } catch {
      // Private mode / disabled storage: keep the default.
    }
  }, []);

  const changeTranslateLang = (value: string) => {
    setTranslateLang(value);
    try {
      window.localStorage.setItem(TRANSLATE_LANG_KEY, value);
    } catch {
      // Ignore storage failures; the in-memory choice still applies.
    }
  };

  // Revoke the previous object URL whenever the preview changes or the
  // composer unmounts; the browser keeps blobs alive until then.
  useEffect(() => {
    if (!attachmentPreview) return;
    return () => URL.revokeObjectURL(attachmentPreview);
  }, [attachmentPreview]);

  const chooseAttachment = (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
      setStatus("Файл больше 50 МБ");
      return;
    }
    setStatus(null);
    setAttachment(file);
    setAttachmentPreview(
      file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    );
  };

  const clearAttachment = () => {
    setAttachment(null);
    setAttachmentPreview(null);
  };

  // Snapshot the unread counter once per chat: this is where the divider and
  // the initial scroll position come from. Opening a chat no longer marks
  // everything read; it only scrolls to the first unread message.
  useEffect(() => {
    if (!chat) {
      activeChatRef.current = null;
      setUnreadAnchor(0);
      return;
    }
    if (activeChatRef.current === chat.id) return;
    activeChatRef.current = chat.id;
    pendingUnreadRef.current = chat.unreadCount;
    setUnreadAnchor(chat.unreadCount);
    stickRef.current = chat.unreadCount === 0;
    // Everything up to the inbox read marker is already read; only newer ids
    // should ever be sent to the API.
    readUpToRef.current = chat.readInboxMaxId ?? 0;
  }, [chat]);

  /**
   * Advances the read marker to `maxId` (message ids grow towards the newest
   * message). Called for every group of messages that actually became visible,
   * not only at the bottom, so partially scrolled chats are read progressively.
   */
  const markReadUpTo = useCallback(
    (maxId: number) => {
      const current = messagesRef.current;
      if (chatId === null || current.length === 0) return;
      if (maxId <= readUpToRef.current) return;
      readUpToRef.current = maxId;
      onRead(maxId);
      const newestId = current[0].id;
      if (maxId >= newestId) setUnreadAnchor(0);
    },
    [chatId, onRead],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !chat) return;

    if (pendingUnreadRef.current > 0) {
      // Wait for the loaded messages: the divider only exists once the render
      // with `messages` has been committed.
      const divider = container.querySelector<HTMLElement>(
        "[data-unread-divider]",
      );
      if (!divider) return;
      // Manual scroll: `scrollIntoView` also scrolls the outer horizontal
      // container and shifts the whole dashboard sideways.
      const containerRect = container.getBoundingClientRect();
      const dividerRect = divider.getBoundingClientRect();
      const offset =
        dividerRect.top -
        containerRect.top -
        container.clientHeight / 2 +
        dividerRect.height / 2;
      container.scrollTop = Math.max(container.scrollTop + offset, 0);
      pendingUnreadRef.current = 0;
      return;
    }

    if (stickRef.current) {
      container.scrollTop = container.scrollHeight;
      markReadUpTo(messages[0]?.id ?? 0);
    }
  }, [chat, markReadUpTo, messages]);

  // Telegram-style read tracking: whichever messages are on screen count as
  // read, debounced to one request per settling of the scroll.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || chatId === null || messages.length === 0) return;
    const items = container.querySelectorAll<HTMLElement>("[data-message-id]");
    if (items.length === 0) return;

    const visibleIds = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      if (document.visibilityState !== "visible" || visibleIds.size === 0) {
        return;
      }
      const maxId = Math.max(...visibleIds);
      markReadUpTo(maxId);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.messageId);
          if (!Number.isFinite(id)) continue;
          if (entry.isIntersecting) visibleIds.add(id);
          else visibleIds.delete(id);
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 400);
      },
      { root: container, threshold: 0.5 },
    );

    for (const item of items) observer.observe(item);

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [chatId, markReadUpTo, messages.length]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      64;
    stickRef.current = atBottom;
    if (atBottom) markReadUpTo(messages[0]?.id ?? 0);
  };

  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  const unreadDividerIndex =
    unreadAnchor > 0 ? Math.max(visible.length - unreadAnchor, 0) : -1;

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (draftKeyRef.current) writeDraft(draftKeyRef.current, value);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (value.trim()) {
      typingTimer.current = setTimeout(() => {
        onTyping();
      }, 1200);
    }
  };

  const showCopied = (key: string) => {
    setCopiedKey(key);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedKey(null), 1600);
  };

  const submit = async () => {
    const text = draft.trim();
    if ((!text && !attachment) || !account || !chat) return;
    // Read-only channels/groups never send, even if a stale event fires.
    if (chat.canSendMessages === false) return;
    // Enter and a click can land in the same tick: guard with a ref so the
    // same draft is never submitted twice.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const key = draftStorageKey(account.id, chat.id);
    const replyTargetId = replyTo?.id;
    try {
      if (attachment) {
        await onSendMedia(attachment, text, replyTargetId);
        clearDraft(key);
      } else {
        await onSend(text, replyTargetId);
        clearDraft(key);
      }
      if (draftKeyRef.current === key) {
        setDraft("");
        setAttachment(null);
        setAttachmentPreview(null);
        setReplyTo(null);
        setStatus(null);
      }
    } catch (caught) {
      setStatus(
        caught instanceof Error ? caught.message : "Не удалось отправить",
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const startEdit = (message: MessageView) => {
    setEditingId(message.id);
    setEditDraft(message.text);
  };

  const submitEdit = () => {
    if (editingId === null) return;
    const text = editDraft.trim();
    if (!text) return;
    onEdit(editingId, text);
    setEditingId(null);
    setEditDraft("");
  };

  const jumpToMessage = useCallback((id: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(
      `[data-message-id="${id}"]`,
    );
    if (!target) {
      setStatus("Сообщение не загружено");
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    container.scrollTop +=
      targetRect.top -
      containerRect.top -
      container.clientHeight / 2 +
      targetRect.height / 2;
    setHighlightId(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1800);
  }, []);

  // A search hit in the already open chat asks for a scroll/highlight; the
  // nonce makes repeated clicks on the same message work again.
  useEffect(() => {
    if (!focusMessage || focusMessage.chatId !== chatId) return;
    if (handledFocusRef.current === focusMessage.nonce) return;
    handledFocusRef.current = focusMessage.nonce;
    jumpToMessage(focusMessage.messageId);
  }, [focusMessage, chatId, jumpToMessage]);

  const toggleSelection = () => {
    setSelecting((current) => {
      if (!current) setSelected(new Set());
      return !current;
    });
    setForwardIds(null);
    setMenuFor(null);
  };

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
    setMenuFor(null);
  };

  const toggleSelected = (id: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyMessage = async (message: MessageView) => {
    const text = message.text || messagePreview(message);
    const ok = await copyToClipboard(text);
    if (ok) showCopied(`message:${message.id}`);
    else setStatus("Не удалось скопировать текст");
  };

  const copySelected = async () => {
    const text = visible
      .filter((message) => selected.has(message.id))
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n\n");
    const ok = await copyToClipboard(text);
    if (ok) showCopied("selection");
    else setStatus("Не удалось скопировать текст");
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Удалить выбранные сообщения у всех участников (${ids.length})?`,
      )
    ) {
      return;
    }
    // Message deletion always revokes now: the dashboard has no
    // "delete for me" action anymore.
    try {
      await onDeleteMany(ids, { revoke: true });
      setStatus(null);
    } catch (caught) {
      setStatus(
        caught instanceof Error ? caught.message : "Не удалось удалить",
      );
    } finally {
      exitSelection();
    }
  };

  const deleteOne = (message: MessageView) => {
    if (
      !window.confirm(
        "Удалить это сообщение у всех участников? Это действие необратимо.",
      )
    ) {
      return;
    }
    onDelete(message.id, { revoke: true });
  };

  const reactionsFor = (message: MessageView): MessageReactionView[] => {
    const optimistic = reactionOptimistic.get(message.id);
    // A refreshed message (realtime edit) wins over the in-flight local chip.
    if (optimistic && optimistic.message === message) {
      return optimistic.reactions;
    }
    return message.reactions ?? [];
  };

  const react = async (message: MessageView, emoji: string) => {
    if (!account || chatId === null) return;
    if (reactionPending.has(message.id)) return;
    const current = reactionsFor(message);
    const chosen = current.some(
      (reaction) => reaction.emoji === emoji && reaction.chosen,
    );
    const target = chosen ? null : emoji;
    setEmojiPickerFor(null);
    setReactionOptimistic((previous) =>
      new Map(previous).set(message.id, {
        message,
        reactions: applyReactionChange(current, emoji, target !== null),
      }),
    );
    setReactionPending((previous) => new Set(previous).add(message.id));
    try {
      const updated = await sendMessageReaction(
        account.id,
        message.chatId,
        message.id,
        target,
      );
      // The API response is authoritative: merge it by id exactly like the
      // other message actions, so `reactions`/`chosen` match the server.
      if (updated) onMessageUpdated(updated);
    } catch (caught) {
      // Dropping the optimistic chip restores the exact previous message.
      setStatus(errorMessage(caught));
    } finally {
      setReactionOptimistic((previous) => {
        const next = new Map(previous);
        next.delete(message.id);
        return next;
      });
      setReactionPending((previous) => {
        const next = new Set(previous);
        next.delete(message.id);
        return next;
      });
    }
  };

  const pollFor = (message: MessageView): MessagePollView | null => {
    const override = pollOverrides.get(message.id);
    if (override && override.base === message.poll) return override.value;
    return message.poll ?? null;
  };

  const vote = async (message: MessageView, answer: number) => {
    if (!account) return;
    const poll = pollFor(message);
    if (!poll || poll.closed || votingId === message.id) return;
    const chosen = poll.answers
      .filter((option) => option.chosen)
      .map((option) => option.index);
    let options: number[] | null;
    if (poll.multiple) {
      const next = chosen.includes(answer)
        ? chosen.filter((index) => index !== answer)
        : [...chosen, answer];
      options = next.length > 0 ? next : null;
    } else {
      // Clicking the chosen answer of a single-choice poll retracts it.
      options = chosen.includes(answer) ? null : [answer];
    }
    setVotingId(message.id);
    try {
      const updated = await sendPollVote(
        account.id,
        message.chatId,
        message.id,
        options,
      );
      setPollOverrides((previous) =>
        new Map(previous).set(message.id, {
          base: message.poll,
          value: updated,
        }),
      );
      setStatus(null);
    } catch (caught) {
      setStatus(errorMessage(caught));
    } finally {
      setVotingId(null);
    }
  };

  const toggleTranslation = async (message: MessageView) => {
    if (!account) return;
    if (translations.has(message.id)) {
      setTranslations((previous) => {
        const next = new Map(previous);
        next.delete(message.id);
        return next;
      });
      return;
    }
    if (translating.has(message.id)) return;
    setTranslating((previous) => new Set(previous).add(message.id));
    try {
      const result = await translateMessage(
        account.id,
        message.chatId,
        message.id,
        translateLang,
      );
      setTranslations((previous) => new Map(previous).set(message.id, result));
      setStatus(null);
    } catch (caught) {
      setStatus(errorMessage(caught));
    } finally {
      setTranslating((previous) => {
        const next = new Set(previous);
        next.delete(message.id);
        return next;
      });
    }
  };

  const transcribe = useCallback(
    async (messageId: number) => {
      if (!accountId || chatId === null) return;
      if (transcribingRef.current.has(messageId)) return;
      transcribingRef.current.add(messageId);
      setTranscribing((previous) => new Set(previous).add(messageId));
      try {
        const result = await transcribeMessage(accountId, chatId, messageId);
        setTranscripts((previous) => new Map(previous).set(messageId, result));
        setStatus(null);
      } catch {
        // Voice notes are the only transcribed media; keep the failure inside
        // the bubble (403 until the API-side transcription fallback lands).
        setTranscripts((previous) =>
          new Map(previous).set(messageId, {
            text: "Расшифровка недоступна",
            pending: false,
            unavailable: true,
          }),
        );
      } finally {
        transcribingRef.current.delete(messageId);
        setTranscribing((previous) => {
          const next = new Set(previous);
          next.delete(messageId);
          return next;
        });
      }
    },
    [accountId, chatId],
  );

  // Telegram may still be transcribing (`pending`): poll again in a moment.
  useEffect(() => {
    if (chatId === null) return;
    const waiting = [...transcripts].filter(
      ([messageId, transcript]) =>
        transcript.pending && !transcribingRef.current.has(messageId),
    );
    if (waiting.length === 0) return;
    const timer = setTimeout(() => {
      for (const [messageId] of waiting) void transcribe(messageId);
    }, 3000);
    return () => clearTimeout(timer);
  }, [transcripts, transcribe, chatId]);

  if (!account || !chat) {
    return (
      <section className="flex min-w-[420px] flex-1 items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Выберите аккаунт и чат, чтобы начать переписку.
      </section>
    );
  }

  const byId = new Map(messages.map((message) => [message.id, message]));
  const forwardTargets = chats.filter((item) => item.id !== chat.id);
  const selectedIds = [...selected];
  const canWrite = chat.canSendMessages !== false;

  return (
    <section className="relative flex min-w-[420px] flex-1 flex-col bg-zinc-950">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <button
          type="button"
          onClick={() => setInfoOpen(true)}
          title="Информация о чате"
          aria-label={`Информация о чате ${chat.title}`}
          aria-expanded={infoOpen}
          className="-m-1 flex min-w-0 items-center gap-3 rounded-lg p-1 text-left transition-colors hover:bg-zinc-900"
        >
          <Avatar
            key={chat.id}
            src={chatAvatarUrl(account.id, chat.id)}
            label={chat.title}
            className="h-9 w-9 text-xs"
          />
          <span className="block min-w-0">
            <span className="block truncate text-sm font-semibold text-zinc-100">
              {chat.title}
            </span>
            <span className="block truncate text-xs text-zinc-500">
              {chat.username ? `@${chat.username}` : `чат ${chat.id}`}
              {chat.unreadCount > 0
                ? ` · ${chat.unreadCount} непрочитанных`
                : ""}
            </span>
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {activeTyping.length > 0 && (
            <span className="text-xs text-sky-400">
              печатает
              {activeTyping[0]?.status === "typing"
                ? "…"
                : ` (${activeTyping[0]?.status})`}
            </span>
          )}
          <button
            type="button"
            onClick={toggleAiFrames}
            title="Показывать кадры для ИИ под стикерами, GIF и видеосообщениями (только в дашборде)"
            aria-pressed={showAiFrames}
            aria-label="Кадры для ИИ"
            className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
              showAiFrames
                ? "border-violet-500/70 bg-violet-500/15 text-violet-200"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            }`}
          >
            Кадры ИИ
          </button>
          <label className="flex items-center gap-1 text-[11px] text-zinc-500">
            <span>Перевод</span>
            <select
              value={translateLang}
              onChange={(event) => changeTranslateLang(event.target.value)}
              title="Язык перевода сообщений"
              aria-label="Язык перевода сообщений"
              className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none focus:border-sky-500"
            >
              {TRANSLATE_LANGS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={toggleSelection}
            title={selecting ? "Отменить выбор" : "Выбрать сообщения"}
            aria-label={selecting ? "Отменить выбор" : "Выбрать сообщения"}
            aria-pressed={selecting}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              selecting
                ? "border-sky-500 bg-sky-500/15 text-sky-300"
                : "border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            }`}
          >
            {selecting ? "Отмена" : "Выбрать"}
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        data-transcript-scroll
        onScroll={handleScroll}
        className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
      >
        {nextOffsetId !== null && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-50"
            >
              {loadingMore ? "Загрузка…" : "Показать ещё"}
            </button>
          </div>
        )}

        {loading && (
          <p className="text-center text-sm text-zinc-500">
            Загрузка сообщений…
          </p>
        )}
        {error && <p className="text-center text-sm text-red-300">{error}</p>}
        {!loading && !error && visible.length === 0 && (
          <p className="text-center text-sm text-zinc-500">
            Пока нет сообщений.
          </p>
        )}

        {visible.map((message, index) => {
          if (message.service) return null;
          const quoted = message.replyToId
            ? byId.get(message.replyToId)
            : undefined;
          const isSelected = selected.has(message.id);
          const reactions = reactionsFor(message);
          const poll = pollFor(message);
          const translation = translations.get(message.id);
          const transcript = transcripts.get(message.id);
          const reactionBusy = reactionPending.has(message.id);
          const voteBusy = votingId === message.id;
          // Telegram repeats the sticker emoji as the message text; the media
          // bubble already shows it as a caption, so skip the duplicate line.
          const stickerMedia = message.media;
          const stickerEcho =
            stickerMedia != null &&
            stickerMedia.emoji != null &&
            resolveMediaKind(stickerMedia, message.mediaType) === "sticker" &&
            message.text.trim() === stickerMedia.emoji.trim();
          const menuActions: MessageMenuAction[] = [];
          if (canWrite) {
            menuActions.push({
              label: "Ответить",
              onSelect: () => {
                setReplyTo(message);
                inputRef.current?.focus();
              },
            });
          }
          if (message.text.trim()) {
            menuActions.push({
              label: translating.has(message.id)
                ? "Перевод…"
                : translation
                  ? "Скрыть перевод"
                  : "Перевести",
              disabled: translating.has(message.id),
              onSelect: () => void toggleTranslation(message),
            });
          }
          if (message.isVoice) {
            menuActions.push({
              label:
                transcript?.pending || transcribing.has(message.id)
                  ? "Расшифровка…"
                  : "Расшифровать",
              disabled: transcribing.has(message.id),
              onSelect: () => void transcribe(message.id),
            });
          }
          menuActions.push({
            label: "Переслать",
            onSelect: () => setForwardIds([message.id]),
          });
          menuActions.push({
            label:
              copiedKey === `message:${message.id}`
                ? "Скопировано"
                : "Копировать",
            onSelect: () => void copyMessage(message),
          });
          if (message.outgoing) {
            menuActions.push({
              label: "Изменить",
              onSelect: () => startEdit(message),
            });
          }
          menuActions.push({
            label: "Выбрать",
            onSelect: () => {
              setSelecting(true);
              setSelected(new Set([message.id]));
            },
          });
          menuActions.push({
            label: "Удалить",
            danger: true,
            onSelect: () => deleteOne(message),
          });
          return (
            <Fragment key={message.id}>
              {index === unreadDividerIndex && (
                <div
                  data-unread-divider
                  className="flex items-center gap-3 py-1 text-[11px] font-medium text-sky-400"
                >
                  <span className="h-px flex-1 bg-sky-500/40" />
                  Непрочитанные сообщения
                  <span className="h-px flex-1 bg-sky-500/40" />
                </div>
              )}
              <article
                data-message-id={message.id}
                {...(selecting
                  ? {
                      onClick: () => toggleSelected(message.id),
                      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleSelected(message.id);
                        }
                      },
                      role: "checkbox" as const,
                      "aria-checked": isSelected,
                      tabIndex: 0,
                    }
                  : {})}
                className={`group flex ${
                  message.outgoing ? "justify-end" : "justify-start"
                } ${selecting ? "cursor-pointer" : ""}`}
              >
                <div
                  className={`flex max-w-[75%] flex-col gap-1 ${
                    message.outgoing ? "items-end" : "items-start"
                  }`}
                >
                  <div className="flex w-full items-start gap-2">
                    {selecting && !message.outgoing && (
                      <SelectionMark checked={isSelected} />
                    )}
                    <div
                      className={`relative min-w-0 rounded-2xl px-3.5 py-2 transition-shadow ${
                        message.outgoing
                          ? "bg-sky-600 text-white"
                          : "bg-zinc-800 text-zinc-100"
                      } ${
                        isSelected
                          ? "ring-2 ring-sky-300"
                          : highlightId === message.id
                            ? "ring-2 ring-sky-400"
                            : ""
                      }`}
                    >
                      {!selecting && editingId !== message.id && (
                        <MessageActionsMenu
                          open={menuFor === message.id}
                          onToggle={() =>
                            setMenuFor((current) =>
                              current === message.id ? null : message.id,
                            )
                          }
                          onClose={() =>
                            setMenuFor((current) =>
                              current === message.id ? null : current,
                            )
                          }
                          actions={menuActions}
                        />
                      )}

                      {!message.outgoing && (
                        <p className="mb-0.5 text-xs font-medium text-sky-400">
                          {message.senderName}
                        </p>
                      )}

                      {message.replyToId !== null && (
                        <button
                          type="button"
                          onClick={(event) => {
                            if (selecting) return;
                            event.stopPropagation();
                            if (message.replyToId !== null) {
                              jumpToMessage(message.replyToId);
                            }
                          }}
                          title="Перейти к сообщению"
                          className="mb-1 flex w-full items-baseline gap-1.5 overflow-hidden rounded border-l-2 border-sky-400/70 bg-black/20 px-2 py-1 text-left text-[11px] opacity-80 transition-opacity hover:opacity-100"
                        >
                          <span className="shrink-0 font-medium">
                            {quoted
                              ? quoted.senderName
                              : `#${message.replyToId}`}
                          </span>
                          <span className="truncate">
                            {quoted
                              ? messagePreview(quoted)
                              : "сообщение не загружено"}
                          </span>
                        </button>
                      )}

                      {editingId === message.id ? (
                        <div className="space-y-2">
                          <input
                            value={editDraft}
                            onChange={(event) =>
                              setEditDraft(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") submitEdit();
                              if (event.key === "Escape") setEditingId(null);
                            }}
                            className="w-full rounded-md border border-zinc-500 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-sky-400"
                            autoComplete="off"
                          />
                          <div className="flex gap-2 text-xs">
                            <button
                              type="button"
                              onClick={submitEdit}
                              className="rounded bg-sky-500 px-2 py-1 font-medium text-white hover:bg-sky-400"
                            >
                              Сохранить
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="rounded bg-zinc-600 px-2 py-1 text-zinc-100 hover:bg-zinc-500"
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {poll ? (
                            <PollBlock
                              poll={poll}
                              canVote={!selecting}
                              busy={voteBusy}
                              onVote={(index) => void vote(message, index)}
                            />
                          ) : (
                            <MessageMedia
                              message={message}
                              accountId={account.id}
                              selecting={selecting}
                              showAiFrames={showAiFrames}
                              transcript={transcript}
                              transcribing={transcribing.has(message.id)}
                              onTranscribe={() => void transcribe(message.id)}
                            />
                          )}
                          {message.text.trim() &&
                            !stickerEcho &&
                            (!poll ||
                              message.text.trim() !== poll.question.trim()) && (
                              <MessageText
                                text={message.text}
                                links={!selecting}
                              />
                            )}
                          {!poll &&
                            !message.text &&
                            message.mediaType &&
                            !hasMediaBody(message.media, message.mediaType) && (
                              <p className="text-sm opacity-80">
                                [{message.mediaType}]
                              </p>
                            )}
                          {translation && (
                            <p className="mt-1 rounded border-l-2 border-sky-300/60 bg-black/20 px-2 py-1 text-xs">
                              <span className="mr-1 uppercase opacity-60">
                                {translation.to}
                              </span>
                              {translation.text}
                            </p>
                          )}
                        </>
                      )}

                      {!selecting && editingId !== message.id && (
                        <div className="mt-1 space-y-1">
                          {(reactions.length > 0 || canWrite) && (
                            <div className="flex flex-wrap items-center gap-1">
                              {reactions.map((reaction) => (
                                <button
                                  key={reaction.emoji}
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void react(message, reaction.emoji);
                                  }}
                                  disabled={reactionBusy}
                                  aria-pressed={reaction.chosen}
                                  title={
                                    reaction.chosen
                                      ? "Убрать реакцию"
                                      : "Поставить реакцию"
                                  }
                                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                                    reaction.chosen
                                      ? "border-sky-300 bg-sky-500/30 text-white"
                                      : "border-white/20 bg-black/20 hover:bg-black/30"
                                  }`}
                                >
                                  <span aria-hidden="true">
                                    {reaction.emoji.startsWith("custom:")
                                      ? "✦"
                                      : reaction.emoji}
                                  </span>
                                  <span>{reaction.count}</span>
                                </button>
                              ))}
                              {canWrite && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEmojiPickerFor(
                                      emojiPickerFor === message.id
                                        ? null
                                        : message.id,
                                    )
                                  }
                                  title="Добавить реакцию"
                                  aria-label="Добавить реакцию"
                                  aria-expanded={emojiPickerFor === message.id}
                                  className="rounded-full border border-white/20 bg-black/20 px-2 py-0.5 text-[11px] transition-colors hover:bg-black/30"
                                >
                                  +
                                </button>
                              )}
                            </div>
                          )}
                          {emojiPickerFor === message.id && canWrite && (
                            <div className="flex flex-wrap gap-1 rounded-lg bg-black/30 p-1">
                              {REACTION_EMOJI.map((emoji) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void react(message, emoji);
                                  }}
                                  disabled={reactionBusy}
                                  title={`Реакция ${emoji}`}
                                  aria-label={`Реакция ${emoji}`}
                                  className="rounded px-1 text-base transition-colors hover:bg-white/10 disabled:opacity-50"
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="mt-1 flex items-center justify-end gap-2 text-[11px] opacity-80">
                        {message.mediaType && message.text && !stickerEcho && (
                          <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px]">
                            {message.mediaType}
                          </span>
                        )}
                        {message.edited && <span>изменено</span>}
                        <span>{formatTime(message.date)}</span>
                      </div>
                    </div>
                    {selecting && message.outgoing && (
                      <SelectionMark checked={isSelected} />
                    )}
                  </div>
                  {!selecting &&
                    message.thread?.hasComments &&
                    threadCount(message) > 0 && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setThreadFor(message);
                        }}
                        title="Открыть комментарии"
                        className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/70 px-2.5 py-0.5 text-[11px] text-sky-400 transition-colors hover:border-sky-500 hover:text-sky-300"
                      >
                        <span aria-hidden="true">💬</span>
                        Комментарии ({threadCount(message)})
                      </button>
                    )}
                </div>
              </article>
            </Fragment>
          );
        })}
      </div>

      {status && (
        <p className="border-t border-zinc-800 bg-zinc-900/60 px-5 py-1.5 text-xs text-red-300">
          {status}
        </p>
      )}

      {selecting && (
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-900/70 px-5 py-2 text-xs text-zinc-300">
          <span className="font-medium">Выбрано: {selected.size}</span>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => setForwardIds(selectedIds)}
            title="Переслать выбранные сообщения"
            className="rounded-md border border-zinc-700 px-2 py-1 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-40"
          >
            Переслать ({selected.size})
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => void copySelected()}
            title="Копировать выбранные сообщения"
            className="rounded-md border border-zinc-700 px-2 py-1 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-40"
          >
            Копировать
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => void deleteSelected()}
            title="Удалить выбранные сообщения"
            className="rounded-md border border-red-900/70 px-2 py-1 text-red-300 transition-colors hover:border-red-600 hover:text-red-200 disabled:opacity-40"
          >
            Удалить
          </button>
          <button
            type="button"
            onClick={exitSelection}
            title="Отменить выбор"
            className="rounded-md border border-zinc-700 px-2 py-1 transition-colors hover:border-zinc-500 hover:text-white"
          >
            Отмена
          </button>
          {copiedKey === "selection" && (
            <span className="text-emerald-400">Скопировано</span>
          )}
        </div>
      )}

      {canWrite && replyTo && (
        <div className="flex items-start gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            onClick={() => jumpToMessage(replyTo.id)}
            title="Перейти к сообщению"
            className="min-w-0 flex-1 border-l-2 border-sky-500 pl-2 text-left transition-opacity hover:opacity-80"
          >
            <p className="truncate text-[11px] font-medium text-sky-400">
              Ответ на {replyTo.senderName}
            </p>
            <p className="truncate text-xs text-zinc-400">
              {messagePreview(replyTo)}
            </p>
          </button>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            title="Отменить ответ"
            aria-label="Отменить ответ"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>
      )}

      {!canWrite && (
        <div className="border-t border-zinc-800 px-5 py-3">
          <output className="block rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-center text-xs text-zinc-400">
            {chat.type === "channel"
              ? "В этом канале нельзя отправлять сообщения"
              : "Отправка сообщений ограничена"}
          </output>
        </div>
      )}

      {canWrite && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="border-t border-zinc-800 px-5 py-3"
        >
          {attachment && (
            <div className="mb-2 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/70 p-2">
              {attachmentPreview ? (
                // biome-ignore lint/performance/noImgElement: local object URL preview of the picked file; next/image cannot optimise blob URLs.
                <img
                  src={attachmentPreview}
                  alt={attachment.name}
                  className="h-14 w-14 rounded object-cover"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-14 w-14 items-center justify-center rounded bg-zinc-800 text-xl"
                >
                  📄
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-100">
                  {attachment.name}
                </p>
                <p className="text-xs text-zinc-500">
                  {formatFileSize(attachment.size)}
                </p>
              </div>
              <button
                type="button"
                onClick={clearAttachment}
                title="Убрать файл"
                aria-label="Убрать файл"
                className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                ✕
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(event) => {
                chooseAttachment(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Прикрепить фото или файл"
              aria-label="Прикрепить фото или файл"
              className="rounded-full border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
            >
              📎
            </button>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
                if (event.key === "Escape") setReplyTo(null);
              }}
              placeholder={
                attachment ? "Подпись к файлу…" : `Сообщение в ${chat.title}`
              }
              autoComplete="off"
              className="flex-1 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
            />
            <button
              type="submit"
              disabled={sending || (!draft.trim() && !attachment)}
              className="rounded-full bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-40"
            >
              {sending ? "Отправка…" : "Отправить"}
            </button>
          </div>
        </form>
      )}

      {forwardIds && (
        <ForwardModal
          chats={forwardTargets}
          accountId={account.id}
          count={forwardIds.length}
          onForward={async (toChatId) => {
            await onForward(toChatId, forwardIds);
            if (selecting) exitSelection();
          }}
          onClose={() => setForwardIds(null)}
        />
      )}

      {threadFor && (
        <CommentThreadDrawer
          key={`thread:${threadFor.id}`}
          accountId={account.id}
          chatId={chat.id}
          messageId={threadFor.id}
          title={chat.title}
          onClose={() => setThreadFor(null)}
          onCommentSent={() => {
            const id = threadFor.id;
            setThreadCounts((previous) => {
              const next = new Map(previous);
              const base = next.get(id) ?? threadFor.thread?.comments ?? 0;
              next.set(id, base + 1);
              return next;
            });
          }}
        />
      )}

      {infoOpen && (
        <ChatInfoPanel
          key={chat.id}
          accountId={account.id}
          chat={chat}
          chats={chats}
          onOpenChat={onOpenChat}
          onClose={closeInfo}
          threadId={threadFor?.id ?? 0}
        />
      )}
    </section>
  );
}

type MessageMenuAction = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/**
 * Vertical room the action dropdown needs below its trigger. Roughly its
 * rendered height (up to eight 28px items plus padding and the border), used
 * to decide whether it has to open upwards.
 */
const MESSAGE_MENU_CLEARANCE = 260;

/**
 * Compact "⋯" toggle with the per-message action dropdown. Absolutely placed
 * in the bubble's top-right corner so opening it never shifts the layout; it
 * opens upwards near the bottom of the transcript and closes on an outside
 * click, on Escape and after any action.
 */
function MessageActionsMenu({
  open,
  onToggle,
  onClose,
  actions,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  actions: MessageMenuAction[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dropUp, setDropUp] = useState(false);

  /** True when the dropdown does not fit below the trigger in the transcript. */
  const needsDropUp = useCallback(() => {
    const trigger = toggleRef.current;
    if (!trigger) return false;
    const rect = trigger.getBoundingClientRect();
    const viewport = rootRef.current?.closest<HTMLElement>(
      "[data-transcript-scroll]",
    );
    const bottom = viewport
      ? viewport.getBoundingClientRect().bottom
      : window.innerHeight;
    return bottom - rect.bottom < MESSAGE_MENU_CLEARANCE;
  }, []);

  // Re-measure while open: rotating a phone or resizing the window can move
  // the transcript edge under an already open menu.
  useEffect(() => {
    if (!open) return;
    const onResize = () => setDropUp(needsDropUp());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, needsDropUp]);

  // Move focus into the menu as soon as it opens so keyboard users can pick
  // an item; the toggle keeps `aria-expanded` in sync for screen readers.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      toggleRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : items[(index - 1 + items.length) % items.length];
    next?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="absolute right-1 top-1 z-20 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"
    >
      <button
        ref={toggleRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (!open) setDropUp(needsDropUp());
          onToggle();
        }}
        title="Действия с сообщением"
        aria-label="Действия с сообщением"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-black/35 text-sm leading-none text-white/80 shadow-sm backdrop-blur transition-colors hover:bg-black/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Действия с сообщением"
          onKeyDown={onMenuKeyDown}
          className={`absolute right-0 z-20 w-44 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-left shadow-2xl ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                onClose();
                action.onSelect();
              }}
              className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-800 disabled:opacity-40 ${
                action.danger
                  ? "text-red-300 hover:bg-red-950/50"
                  : "text-zinc-300"
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageMedia({
  message,
  accountId,
  selecting,
  showAiFrames,
  transcript,
  transcribing,
  onTranscribe,
}: {
  message: MessageView;
  accountId: string;
  selecting: boolean;
  showAiFrames: boolean;
  transcript?: MessageTranscriptionView;
  transcribing: boolean;
  onTranscribe: () => void;
}) {
  const media = message.media;
  if (!media) return null;
  // Older API payloads still say `other`; fall back to mime/legacy mediaType
  // so stickers and GIFs render instead of a bare `[sticker]` label.
  const kind = resolveMediaKind(media, message.mediaType);
  if (!media.downloadable && kind === "other") return null;

  const url = mediaUrl(accountId, message.chatId, message.id, media.fileName);

  if (kind === "photo") {
    // The thumbnail endpoint falls back to the full image server-side, so a
    // chat list stays cheap without ever showing a broken preview.
    const previewUrl = mediaUrl(
      accountId,
      message.chatId,
      message.id,
      undefined,
      { thumb: true },
    );
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (selecting) event.preventDefault();
        }}
        className="my-1 block"
        title="Открыть фото"
      >
        {/* biome-ignore lint/performance/noImgElement: media is streamed by our API with a dynamic URL; next/image needs a fixed remote host. */}
        <img
          src={previewUrl}
          alt={media.fileName ?? "Фото"}
          loading="lazy"
          className="max-h-72 max-w-full rounded-lg object-contain"
        />
      </a>
    );
  }

  if (kind === "sticker") {
    return (
      <StickerBubble
        message={message}
        accountId={accountId}
        selecting={selecting}
        showAiFrames={showAiFrames}
      />
    );
  }

  if (kind === "animation") {
    return (
      <AnimationBubble
        message={message}
        accountId={accountId}
        selecting={selecting}
        showAiFrames={showAiFrames}
      />
    );
  }

  if (kind === "video_note") {
    return (
      <VideoNoteBubble
        message={message}
        accountId={accountId}
        selecting={selecting}
        showAiFrames={showAiFrames}
      />
    );
  }

  if (kind === "video") {
    return (
      <VideoBubble
        message={message}
        accountId={accountId}
        selecting={selecting}
        showAiFrames={showAiFrames}
      />
    );
  }

  if (kind === "audio") {
    return (
      <AudioBubble
        message={message}
        accountId={accountId}
        selecting={selecting}
        showAiFrames={showAiFrames}
      />
    );
  }

  if (kind === "voice") {
    return (
      <VoiceBubble
        src={url}
        fileName={media.fileName}
        selecting={selecting}
        transcript={transcript}
        transcribing={transcribing}
        onTranscribe={onTranscribe}
      />
    );
  }

  if (kind === "document") {
    const fileName = media.fileName ?? "Документ";
    const mime = media.mimeType ?? "";
    const previewable = mime.startsWith("image/") || mime.startsWith("video/");
    const thumbUrl = mediaUrl(
      accountId,
      message.chatId,
      message.id,
      undefined,
      { thumb: true },
    );
    return (
      <a
        href={url}
        download={media.fileName ?? undefined}
        onClick={(event) => {
          if (selecting) event.preventDefault();
        }}
        className="my-1 flex max-w-xs items-center gap-3 rounded-lg bg-black/20 px-3 py-2 transition-colors hover:bg-black/30"
        title="Скачать файл"
      >
        {previewable ? (
          <DocumentThumb src={thumbUrl} alt={fileName} />
        ) : (
          <span aria-hidden="true" className="text-xl">
            📄
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{fileName}</span>
          <span className="block text-[11px] opacity-75">
            {formatFileSize(media.size) || media.mimeType || "файл"}
          </span>
        </span>
        <span className="shrink-0 text-[11px] underline underline-offset-2">
          Скачать
        </span>
      </a>
    );
  }

  return null;
}

/** Image/video document preview with a plain-file fallback on error. */
function DocumentThumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span aria-hidden="true" className="text-xl">
        📄
      </span>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: thumbnail is streamed by our API with a dynamic URL; next/image needs a fixed remote host.
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded object-cover"
    />
  );
}

/** Poll body: question, answer buttons with percent bars, quiz solution. */
function PollBlock({
  poll,
  canVote,
  busy,
  onVote,
}: {
  poll: MessagePollView;
  canVote: boolean;
  busy: boolean;
  onVote: (index: number) => void;
}) {
  const total = Math.max(
    poll.voters,
    poll.answers.reduce((sum, answer) => sum + answer.voters, 0),
  );
  const showResults = !poll.hideResultsUntilClose || poll.closed;

  return (
    <div className="my-1 min-w-0 space-y-1.5">
      <p className="text-sm font-medium">{poll.question || "Опрос"}</p>
      <div className="space-y-1">
        {poll.answers.map((answer) => {
          const percent =
            total > 0 ? Math.round((answer.voters / total) * 100) : 0;
          const interactive = canVote && !poll.closed && !busy;
          const correctAnswer = poll.quiz && answer.correct && showResults;
          return (
            <button
              key={answer.index}
              type="button"
              onClick={() => {
                if (interactive) onVote(answer.index);
              }}
              disabled={!interactive}
              aria-pressed={answer.chosen}
              title={
                poll.closed
                  ? "Опрос закрыт"
                  : answer.chosen
                    ? "Отменить голос"
                    : "Голосовать"
              }
              className={`relative block w-full overflow-hidden rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                answer.chosen
                  ? "border-sky-300 bg-sky-500/20"
                  : "border-white/15 bg-black/20 hover:bg-black/30"
              } ${interactive ? "" : "cursor-default"} disabled:opacity-100`}
            >
              {showResults && (
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 ${
                    correctAnswer
                      ? "bg-emerald-400/20"
                      : answer.chosen
                        ? "bg-sky-400/25"
                        : "bg-white/10"
                  }`}
                  style={{ width: `${percent}%` }}
                />
              )}
              <span className="relative flex items-center gap-2">
                {correctAnswer && <span className="text-emerald-300">✓</span>}
                {poll.quiz &&
                  answer.chosen &&
                  !answer.correct &&
                  showResults && <span className="text-red-300">✕</span>}
                <span className="min-w-0 flex-1 break-words">
                  {answer.text}
                </span>
                {showResults && (
                  <span className="shrink-0 text-[11px] opacity-75">
                    {percent}% · {answer.voters}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[11px] opacity-70">
        <span>
          {poll.quiz
            ? "Викторина"
            : poll.multiple
              ? "Несколько ответов"
              : "Опрос"}
          {poll.closed ? " · закрыт" : ""}
        </span>
        <span>{poll.voters} голосов</span>
      </div>
      {poll.solution && (
        <p className="rounded border-l-2 border-emerald-300/60 bg-black/20 px-2 py-1 text-xs">
          {poll.solution}
        </p>
      )}
    </div>
  );
}

function SelectionMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors ${
        checked
          ? "border-sky-400 bg-sky-500 text-white"
          : "border-zinc-600 text-transparent"
      }`}
    >
      ✓
    </span>
  );
}
