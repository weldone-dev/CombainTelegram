"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { errorMessage, mediaUrl } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import {
  getChatInfo,
  getChatInfoMedia,
  getChatInfoSimilar,
} from "../../lib/chat-info-api";
import { copyToClipboard } from "../../lib/clipboard";
import {
  chatKindLabel,
  formatDay,
  formatMemberCount,
  formatTime,
} from "../../lib/format";
import type {
  ChatInfoMediaItemView,
  ChatInfoMediaKind,
  ChatInfoPollView,
  ChatInfoSimilarChatView,
  ChatInfoView,
  ChatView,
} from "../../lib/types";
import { Avatar } from "../avatar";
import { ChatAdminPanel } from "./chat-admin-panel";

type InfoTab = "overview" | ChatInfoMediaKind | "similar" | "admin";

interface SectionState {
  items: ChatInfoMediaItemView[];
  nextOffsetId: number | null;
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  error: string | null;
}

type Sections = Record<ChatInfoMediaKind, SectionState>;

function emptySection(): SectionState {
  return {
    items: [],
    nextOffsetId: null,
    loading: false,
    loadingMore: false,
    loaded: false,
    error: null,
  };
}

function emptySections(): Sections {
  return {
    media: emptySection(),
    links: emptySection(),
    polls: emptySection(),
  };
}

/** Only http(s) and Telegram links are rendered as anchors. */
function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "tg:"
    ) {
      return url;
    }
  } catch {
    // Fall through: not a URL, render as plain text.
  }
  return null;
}

function itemDate(iso: string): string {
  const day = formatDay(iso);
  const time = formatTime(iso);
  return [day, time].filter(Boolean).join(", ");
}

/**
 * Right-side chat info drawer. Rendered inside the chat window so the
 * three-column dashboard layout stays untouched.
 */
export function ChatInfoPanel({
  accountId,
  chat,
  chats,
  onOpenChat,
  onClose,
}: {
  accountId: string;
  chat: ChatView;
  /** Chats currently loaded in the list, used to resolve "Похожие". */
  chats: ChatView[];
  onOpenChat?: (chatId: number) => void;
  onClose: () => void;
}) {
  const chatId = chat.id;
  const [info, setInfo] = useState<ChatInfoView | null>(null);
  const [infoLoading, setInfoLoading] = useState(true);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<ChatInfoSimilarChatView[] | null>(
    null,
  );
  const [tab, setTab] = useState<InfoTab>("overview");
  const [sections, setSections] = useState<Sections>(emptySections);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loadedKinds = useRef<Set<ChatInfoMediaKind>>(new Set());
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Profile card and similar chats load together: the "Похожие" tab only
  // exists once the endpoint returned at least one chat.
  useEffect(() => {
    let cancelled = false;
    setInfoLoading(true);
    setInfoError(null);

    getChatInfo(accountId, chatId)
      .then((result) => {
        if (cancelled) return;
        setInfo(result);
        setInfoLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInfoError(errorMessage(error));
        setInfoLoading(false);
      });

    getChatInfoSimilar(accountId, chatId)
      .then((result) => {
        if (!cancelled) setSimilar(result.chats);
      })
      .catch(() => {
        if (!cancelled) setSimilar([]);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, chatId]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const loadSection = useCallback(
    async (kind: ChatInfoMediaKind, offsetId: number | null = null) => {
      const more = offsetId !== null;
      setSections((previous) => ({
        ...previous,
        [kind]: {
          ...previous[kind],
          loading: !more,
          loadingMore: more,
          error: null,
        },
      }));
      try {
        const page = await getChatInfoMedia(accountId, chatId, kind, {
          offsetId,
        });
        loadedKinds.current.add(kind);
        setSections((previous) => {
          const current = previous[kind];
          return {
            ...previous,
            [kind]: {
              items: more ? [...current.items, ...page.items] : page.items,
              nextOffsetId: page.nextOffsetId,
              loading: false,
              loadingMore: false,
              loaded: true,
              error: null,
            },
          };
        });
      } catch (error) {
        setSections((previous) => ({
          ...previous,
          [kind]: {
            ...previous[kind],
            loading: false,
            loadingMore: false,
            error: errorMessage(error),
          },
        }));
      }
    },
    [accountId, chatId],
  );

  // Tabs fetch lazily on first activation and keep their page afterwards.
  useEffect(() => {
    if (tab !== "media" && tab !== "links" && tab !== "polls") return;
    if (loadedKinds.current.has(tab)) return;
    void loadSection(tab);
  }, [tab, loadSection]);

  const copyInvite = async () => {
    if (!info?.inviteLink) return;
    const ok = await copyToClipboard(info.inviteLink);
    if (!ok) {
      setNotice("Не удалось скопировать ссылку");
      return;
    }
    setNotice(null);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  const openSimilar = (target: ChatInfoSimilarChatView) => {
    const loaded = chats.some((item) => item.id === target.id);
    if (!loaded || !onOpenChat) {
      setNotice("Чат не загружен");
      return;
    }
    setNotice(null);
    onOpenChat(target.id);
  };

  const kind = chatKindLabel(info ?? chat);
  const title = info?.title ?? chat.title;
  const username = info?.username ?? chat.username;
  const tabs: Array<{ id: InfoTab; label: string }> = [
    { id: "overview", label: "Обзор" },
    { id: "media", label: "Медиа" },
    { id: "links", label: "Ссылки" },
    { id: "polls", label: "Опросы" },
  ];
  if (similar && similar.length > 0) {
    tabs.push({ id: "similar", label: "Похожие" });
  }
  if (
    info &&
    (info.isAdmin || info.isCreator) &&
    (info.isGroup || info.isChannel)
  ) {
    tabs.push({ id: "admin", label: "Управление" });
  }

  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      <button
        type="button"
        onClick={onClose}
        title="Закрыть информацию о чате"
        aria-label="Закрыть информацию о чате"
        className="absolute inset-0 bg-black/50"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Информация о чате ${title}`}
        className="relative flex h-full w-[360px] max-w-full flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2 border-b border-zinc-800 px-4 py-3">
          <span className="text-sm font-semibold text-zinc-200">
            Информация
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть информацию о чате"
            className="rounded-md px-1.5 py-0.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>

        <div className="border-b border-zinc-800 px-4 py-4">
          <div className="flex items-start gap-3">
            <Avatar
              src={chatAvatarUrl(accountId, chatId)}
              label={title}
              className="h-16 w-16 text-lg"
            />
            <div className="min-w-0 flex-1">
              <h3 className="break-words text-base font-semibold text-zinc-100">
                {title}
              </h3>
              {username && (
                <p className="truncate text-xs text-sky-400">@{username}</p>
              )}
              <p className="mt-0.5 text-xs text-zinc-500">{kind}</p>
              {(info?.isAdmin || info?.isCreator) && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {info.isAdmin && <Badge>Админ</Badge>}
                  {info.isCreator && <Badge>Владелец</Badge>}
                </div>
              )}
              {(info?.memberCount ?? null) !== null && (
                <p className="mt-1.5 text-xs text-zinc-400">
                  {formatMemberCount(info?.memberCount ?? null)}
                  {info?.onlineCount
                    ? ` · ${info.onlineCount.toLocaleString("ru-RU")} онлайн`
                    : ""}
                </p>
              )}
            </div>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Разделы информации о чате"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors ${
                tab === item.id
                  ? "bg-sky-500/15 font-medium text-sky-300"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {notice && (
          <p className="border-b border-zinc-800 bg-zinc-800/50 px-4 py-1.5 text-xs text-amber-300">
            {notice}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === "overview" && (
            <OverviewTab
              info={info}
              loading={infoLoading}
              error={infoError}
              copied={copied}
              onCopyInvite={() => void copyInvite()}
              onRetry={() => {
                setInfoLoading(true);
                setInfoError(null);
                getChatInfo(accountId, chatId)
                  .then((result) => {
                    setInfo(result);
                    setInfoLoading(false);
                  })
                  .catch((error: unknown) => {
                    setInfoError(errorMessage(error));
                    setInfoLoading(false);
                  });
              }}
            />
          )}

          {tab === "media" && (
            <MediaTab
              section={sections.media}
              accountId={accountId}
              chatId={chatId}
              onLoadMore={() =>
                void loadSection("media", sections.media.nextOffsetId)
              }
            />
          )}

          {tab === "links" && (
            <LinksTab
              section={sections.links}
              onLoadMore={() =>
                void loadSection("links", sections.links.nextOffsetId)
              }
            />
          )}

          {tab === "polls" && (
            <PollsTab
              section={sections.polls}
              onLoadMore={() =>
                void loadSection("polls", sections.polls.nextOffsetId)
              }
            />
          )}

          {tab === "similar" && (
            <SimilarTab
              accountId={accountId}
              chats={similar ?? []}
              onOpen={openSimilar}
            />
          )}

          {tab === "admin" && info && (
            <ChatAdminPanel accountId={accountId} chatId={chatId} info={info} />
          )}
        </div>
      </aside>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
      {children}
    </span>
  );
}

function OverviewTab({
  info,
  loading,
  error,
  copied,
  onCopyInvite,
  onRetry,
}: {
  info: ChatInfoView | null;
  loading: boolean;
  error: string | null;
  copied: boolean;
  onCopyInvite: () => void;
  onRetry: () => void;
}) {
  if (loading && !info) return <RowsSkeleton rows={3} />;
  if (error) {
    return (
      <div className="space-y-2 text-sm text-red-300">
        <p>{error}</p>
        <button
          type="button"
          onClick={onRetry}
          title="Повторить загрузку"
          className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:border-zinc-500"
        >
          Повторить
        </button>
      </div>
    );
  }
  if (!info) return null;

  return (
    <div className="space-y-4">
      {info.about ? (
        <section>
          <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Описание
          </h4>
          <p className="whitespace-pre-wrap break-words text-sm text-zinc-300">
            {info.about}
          </p>
        </section>
      ) : (
        <p className="text-xs text-zinc-500">Описание не указано.</p>
      )}

      {info.inviteLink && (
        <section>
          <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Пригласительная ссылка
          </h4>
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
            <a
              href={info.inviteLink}
              target="_blank"
              rel="noreferrer"
              title="Открыть пригласительную ссылку"
              className="min-w-0 flex-1 truncate text-xs text-sky-400 hover:text-sky-300"
            >
              {info.inviteLink}
            </a>
            <button
              type="button"
              onClick={onCopyInvite}
              title="Скопировать ссылку"
              aria-label="Скопировать пригласительную ссылку"
              className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-zinc-500"
            >
              {copied ? "Скопировано" : "Копировать"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function MediaTab({
  section,
  accountId,
  chatId,
  onLoadMore,
}: {
  section: SectionState;
  accountId: string;
  chatId: number;
  onLoadMore: () => void;
}) {
  if (section.loading) return <GridSkeleton />;
  if (section.error) return <SectionError text={section.error} />;

  const photos = section.items.filter((item) => item.media?.kind === "photo");

  if (photos.length === 0 && section.nextOffsetId === null) {
    return <EmptyState text="В этом чате пока нет фотографий." />;
  }

  return (
    <div className="space-y-3">
      {photos.length === 0 ? (
        <EmptyState text="В этом чате пока нет фотографий." />
      ) : (
        <div className="grid grid-cols-3 gap-1">
          {photos.map((item) => {
            const url = mediaUrl(
              accountId,
              chatId,
              item.messageId,
              item.media?.fileName ?? null,
            );
            return (
              <a
                key={item.messageId}
                href={url}
                target="_blank"
                rel="noreferrer"
                title={item.text || "Открыть фото"}
                className="block aspect-square overflow-hidden rounded bg-zinc-800"
              >
                {/* biome-ignore lint/performance/noImgElement: chat media is streamed by our API with a dynamic URL; next/image needs a fixed remote host. */}
                <img
                  src={url}
                  alt={item.text || "Фото"}
                  loading="lazy"
                  className="h-full w-full object-cover transition-opacity hover:opacity-80"
                />
              </a>
            );
          })}
        </div>
      )}
      <LoadMore
        nextOffsetId={section.nextOffsetId}
        loading={section.loadingMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

function LinksTab({
  section,
  onLoadMore,
}: {
  section: SectionState;
  onLoadMore: () => void;
}) {
  if (section.loading) return <RowsSkeleton rows={4} />;
  if (section.error) return <SectionError text={section.error} />;

  const links = section.items.filter((item) => item.url);
  if (links.length === 0) {
    return <EmptyState text="В этом чате пока нет ссылок." />;
  }

  return (
    <div className="space-y-2">
      {links.map((item) => {
        const href = safeHref(item.url);
        return (
          <div
            key={item.messageId}
            className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
          >
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                title="Открыть ссылку"
                className="block break-all text-xs text-sky-400 hover:text-sky-300"
              >
                {item.url}
              </a>
            ) : (
              <p className="break-all text-xs text-zinc-300">{item.url}</p>
            )}
            {item.text && (
              <p className="mt-1 line-clamp-2 break-words text-xs text-zinc-400">
                {item.text}
              </p>
            )}
            <p className="mt-1 text-[11px] text-zinc-600">
              {itemDate(item.date)}
            </p>
          </div>
        );
      })}
      <LoadMore
        nextOffsetId={section.nextOffsetId}
        loading={section.loadingMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

function PollsTab({
  section,
  onLoadMore,
}: {
  section: SectionState;
  onLoadMore: () => void;
}) {
  if (section.loading) return <RowsSkeleton rows={3} />;
  if (section.error) return <SectionError text={section.error} />;

  const polls = section.items.filter(
    (item): item is ChatInfoMediaItemView & { poll: ChatInfoPollView } =>
      item.poll !== null,
  );
  if (polls.length === 0) {
    return <EmptyState text="В этом чате пока нет опросов." />;
  }

  return (
    <div className="space-y-2">
      {polls.map((item) => (
        <article
          key={item.messageId}
          className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
        >
          <h4 className="break-words text-sm font-medium text-zinc-200">
            {item.poll.question || "Опрос"}
          </h4>
          <ul className="mt-1.5 space-y-1">
            {item.poll.options.map((option, index) => (
              <li
                // Options are plain strings and may repeat; the index is stable.
                key={`${item.messageId}:${index}`}
                className="rounded bg-zinc-800/60 px-2 py-1 text-xs text-zinc-300"
              >
                {option}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-zinc-500">
            Всего голосов: {item.poll.totalVoters.toLocaleString("ru-RU")}
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-600">
            {itemDate(item.date)}
          </p>
        </article>
      ))}
      <LoadMore
        nextOffsetId={section.nextOffsetId}
        loading={section.loadingMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

function SimilarTab({
  accountId,
  chats,
  onOpen,
}: {
  accountId: string;
  chats: ChatInfoSimilarChatView[];
  onOpen: (chat: ChatInfoSimilarChatView) => void;
}) {
  return (
    <ul className="space-y-1">
      {chats.map((chat) => (
        <li key={chat.id}>
          <button
            type="button"
            onClick={() => onOpen(chat)}
            title={`Открыть ${chat.title}`}
            className="flex w-full items-center gap-3 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
          >
            <Avatar
              src={chatAvatarUrl(accountId, chat.id)}
              label={chat.title}
              className="h-9 w-9 text-xs"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-zinc-200">
                {chat.title}
              </span>
              <span className="block truncate text-xs text-zinc-500">
                {chat.username ? `@${chat.username}` : "без username"}
                {chat.memberCount !== null
                  ? ` · ${formatMemberCount(chat.memberCount)}`
                  : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function LoadMore({
  nextOffsetId,
  loading,
  onLoadMore,
}: {
  nextOffsetId: number | null;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (nextOffsetId === null) return null;
  return (
    <div className="flex justify-center pt-1">
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loading}
        title="Загрузить ещё"
        className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-50"
      >
        {loading ? "Загрузка…" : "Показать ещё"}
      </button>
    </div>
  );
}

function SectionError({ text }: { text: string }) {
  return <p className="text-sm text-red-300">{text}</p>;
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{text}</p>;
}

function GridSkeleton() {
  return (
    <div aria-hidden="true" className="grid animate-pulse grid-cols-3 gap-1">
      {Array.from({ length: 9 }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders.
          key={`skeleton-${index}`}
          className="aspect-square rounded bg-zinc-800"
        />
      ))}
    </div>
  );
}

function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className="animate-pulse space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders.
          key={`row-${index}`}
          className="h-12 rounded-lg bg-zinc-800"
        />
      ))}
    </div>
  );
}
