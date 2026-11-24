"use client";

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { errorMessage } from "../../lib/api";
import {
  banChatAdminMember,
  createChatAdminInvite,
  demoteChatAdminMember,
  editChatAdminInvite,
  exportChatAdminPrimaryInvite,
  getChatAdminInvites,
  getChatAdminMembers,
  kickChatAdminMember,
  promoteChatAdminMember,
  revokeChatAdminInvite,
  setChatAdminMemberRank,
  unbanChatAdminMember,
  updateChatAdminSettings,
} from "../../lib/chat-admin-api";
import { copyToClipboard } from "../../lib/clipboard";
import type {
  ChatAdminInviteCreate,
  ChatAdminInviteView,
  ChatAdminMemberFilter,
  ChatAdminMemberView,
  ChatAdminRightKey,
  ChatAdminRights,
  ChatInfoView,
} from "../../lib/types";

type AdminSection = "settings" | "members" | "invites";

const MEMBER_FILTERS: Array<{ id: ChatAdminMemberFilter; label: string }> = [
  { id: "all", label: "Все" },
  { id: "admins", label: "Админы" },
  { id: "banned", label: "Забанены" },
  { id: "recent", label: "Недавние" },
  { id: "bots", label: "Боты" },
];

const SLOW_MODE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Выключен" },
  { value: 10, label: "10 секунд" },
  { value: 30, label: "30 секунд" },
  { value: 60, label: "1 минута" },
  { value: 300, label: "5 минут" },
  { value: 900, label: "15 минут" },
  { value: 3600, label: "1 час" },
  { value: 10800, label: "3 часа" },
  { value: 21600, label: "6 часов" },
  { value: 43200, label: "12 часов" },
  { value: 86400, label: "24 часа" },
];

const RIGHT_LABELS: Array<{ key: ChatAdminRightKey; label: string }> = [
  { key: "changeInfo", label: "Изменять описание" },
  { key: "deleteMessages", label: "Удалять сообщения" },
  { key: "banUsers", label: "Блокировать участников" },
  { key: "inviteUsers", label: "Приглашать участников" },
  { key: "pinMessages", label: "Закреплять сообщения" },
  { key: "manageCall", label: "Управлять звонками" },
  { key: "postMessages", label: "Публиковать сообщения" },
  { key: "editMessages", label: "Редактировать сообщения" },
  { key: "addAdmins", label: "Назначать админов" },
  { key: "anonymous", label: "Анонимный админ" },
  { key: "manageTopics", label: "Управлять темами" },
];

const STATUS_LABELS: Record<string, string> = {
  creator: "Владелец",
  admin: "Админ",
  member: "Участник",
  restricted: "Ограничен",
  banned: "Забанен",
  left: "Вышел",
};

const PAGE_SIZE = 50;

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatUsage(invite: ChatAdminInviteView): string {
  const limit =
    invite.usageLimit === null ? "без лимита" : `из ${invite.usageLimit}`;
  return `${invite.usage} ${limit}`;
}

/**
 * Administration tab of the chat info panel. Only mounted for users who
 * administer a group or channel; each mutation is confirmed for destructive
 * actions and the server re-checks admin rights on every request.
 */
export function ChatAdminPanel({
  accountId,
  chatId,
  info,
}: {
  accountId: string;
  chatId: number;
  info: ChatInfoView;
}) {
  const [section, setSection] = useState<AdminSection>("settings");
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg bg-zinc-950/60 p-1">
        {(
          [
            { id: "settings", label: "Настройки" },
            { id: "members", label: "Участники" },
            { id: "invites", label: "Ссылки" },
          ] as Array<{ id: AdminSection; label: string }>
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setSection(item.id);
              setNotice(null);
            }}
            className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${
              section === item.id
                ? "bg-sky-500/15 font-medium text-sky-300"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {notice && (
        <p className="rounded-md border border-zinc-800 bg-zinc-800/50 px-2.5 py-1.5 text-xs text-amber-300">
          {notice}
        </p>
      )}

      {section === "settings" && (
        <SettingsSection
          accountId={accountId}
          chatId={chatId}
          info={info}
          onNotice={setNotice}
        />
      )}
      {section === "members" && (
        <MembersSection
          accountId={accountId}
          chatId={chatId}
          onNotice={setNotice}
        />
      )}
      {section === "invites" && (
        <InvitesSection
          accountId={accountId}
          chatId={chatId}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

function SettingsSection({
  accountId,
  chatId,
  info,
  onNotice,
}: {
  accountId: string;
  chatId: number;
  info: ChatInfoView;
  onNotice: (text: string | null) => void;
}) {
  const [title, setTitle] = useState(info.title);
  const [about, setAbout] = useState(info.about ?? "");
  // Empty string means "leave slow mode untouched": the info payload does not
  // include the current interval, and silently sending 0 would disable it.
  const [slowMode, setSlowMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onNotice(null);
    setError(null);
    setSaved(false);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Название не может быть пустым");
      return;
    }
    const patch: {
      title?: string;
      about?: string;
      slowModeSeconds?: number;
    } = {};
    if (trimmedTitle !== info.title) patch.title = trimmedTitle;
    if (about.trim() !== (info.about ?? "")) patch.about = about.trim();
    if (slowMode !== "") patch.slowModeSeconds = Number(slowMode);
    if (Object.keys(patch).length === 0) {
      setError("Нет изменений для сохранения");
      return;
    }

    setBusy(true);
    try {
      const result = await updateChatAdminSettings(accountId, chatId, patch);
      setTitle(result.title);
      setAbout(result.about);
      setSlowMode("");
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Название
        </span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={255}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
          autoComplete="off"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Описание
        </span>
        <textarea
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          rows={4}
          maxLength={255}
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
          autoComplete="off"
        />
        <span className="mt-0.5 block text-right text-[10px] text-zinc-600">
          {about.trim().length}/255
        </span>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Медленный режим
        </span>
        <select
          value={slowMode}
          onChange={(event) => setSlowMode(event.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
        >
          <option value="">Не менять</option>
          {SLOW_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="mt-0.5 block text-[10px] text-zinc-600">
          Текущее значение не отображается: выберите вариант, чтобы изменить.
        </span>
      </label>

      {error && <p className="text-xs text-red-300">{error}</p>}
      {saved && <p className="text-xs text-emerald-400">Сохранено</p>}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "Сохранение…" : "Сохранить"}
      </button>
    </form>
  );
}

function MembersSection({
  accountId,
  chatId,
  onNotice,
}: {
  accountId: string;
  chatId: number;
  onNotice: (text: string | null) => void;
}) {
  const [filter, setFilter] = useState<ChatAdminMemberFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ChatAdminMemberView[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<ChatAdminMemberView | null>(null);
  const [rankEditing, setRankEditing] = useState<ChatAdminMemberView | null>(
    null,
  );
  const requestRef = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const ticket = ++requestRef.current;
      const more = offset > 0;
      if (more) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await getChatAdminMembers(accountId, chatId, {
          query,
          type: filter,
          limit: PAGE_SIZE,
          offset,
        });
        if (ticket !== requestRef.current) return;
        setItems((previous) =>
          more ? [...previous, ...page.items] : page.items,
        );
        setTotal(page.total);
      } catch (cause) {
        if (ticket !== requestRef.current) return;
        setError(errorMessage(cause));
      } finally {
        if (ticket === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [accountId, chatId, filter, query],
  );

  useEffect(() => {
    setItems([]);
    setTotal(null);
    void load(0);
  }, [load]);

  const replaceItem = (member: ChatAdminMemberView) => {
    setItems((previous) =>
      previous.map((item) => (item.id === member.id ? member : item)),
    );
  };

  const act = async (
    member: ChatAdminMemberView,
    action: () => Promise<ChatAdminMemberView>,
    confirmation?: string,
  ) => {
    if (confirmation && !window.confirm(confirmation)) return;
    onNotice(null);
    setBusyUserId(member.id);
    try {
      replaceItem(await action());
    } catch (cause) {
      onNotice(errorMessage(cause));
    } finally {
      setBusyUserId(null);
    }
  };

  const canLoadMore =
    items.length > 0 &&
    (total === null ? items.length % PAGE_SIZE === 0 : items.length < total);

  return (
    <div className="space-y-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(searchInput.trim());
        }}
        className="flex gap-1.5"
      >
        <input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Поиск по имени"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
          autoComplete="off"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:border-zinc-500"
        >
          Найти
        </button>
      </form>

      <div className="flex gap-1 overflow-x-auto">
        {MEMBER_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setFilter(option.id)}
            className={`shrink-0 rounded-md px-2 py-1 text-[11px] transition-colors ${
              filter === option.id
                ? "bg-sky-500/15 text-sky-300"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {total !== null && (
        <p className="text-[11px] text-zinc-500">
          Найдено: {total.toLocaleString("ru-RU")}
        </p>
      )}
      {loading && (
        <p className="py-4 text-center text-xs text-zinc-500">Загрузка…</p>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="py-6 text-center text-xs text-zinc-500">
          Никого не найдено.
        </p>
      )}

      <ul className="space-y-1.5">
        {items.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            busy={busyUserId === member.id}
            onBan={() =>
              void act(
                member,
                () => banChatAdminMember(accountId, chatId, member.id),
                `Заблокировать ${member.name}? Они не смогут писать и войти по ссылке, пока вы не снимете бан (или разрешите войти вручную).`,
              )
            }
            onUnban={() =>
              void act(member, () =>
                unbanChatAdminMember(accountId, chatId, member.id),
              )
            }
            onKick={() =>
              void act(
                member,
                () => kickChatAdminMember(accountId, chatId, member.id),
                `Исключить ${member.name}? Их удалят из чата, но они смогут вернуться по ссылке.`,
              )
            }
            onDemote={() =>
              void act(
                member,
                () => demoteChatAdminMember(accountId, chatId, member.id),
                `Снять ${member.name} с должности администратора? Права будут отозваны сразу.`,
              )
            }
            onPromote={() => setPromoting(member)}
            onRank={() => setRankEditing(member)}
          />
        ))}
      </ul>

      {canLoadMore && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void load(items.length)}
          className="w-full rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-50"
        >
          {loadingMore ? "Загрузка…" : "Показать ещё"}
        </button>
      )}

      {promoting && (
        <PromoteModal
          member={promoting}
          onClose={() => setPromoting(null)}
          onSubmit={async (rights, rank) => {
            const updated = await promoteChatAdminMember(
              accountId,
              chatId,
              promoting.id,
              { rights, rank },
            );
            replaceItem(updated);
            setPromoting(null);
          }}
        />
      )}

      {rankEditing && (
        <RankModal
          member={rankEditing}
          onClose={() => setRankEditing(null)}
          onSubmit={async (rank) => {
            const updated = await setChatAdminMemberRank(
              accountId,
              chatId,
              rankEditing.id,
              rank,
            );
            replaceItem(updated);
            setRankEditing(null);
          }}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  busy,
  onBan,
  onUnban,
  onKick,
  onPromote,
  onDemote,
  onRank,
}: {
  member: ChatAdminMemberView;
  busy: boolean;
  onBan: () => void;
  onUnban: () => void;
  onKick: () => void;
  onPromote: () => void;
  onDemote: () => void;
  onRank: () => void;
}) {
  const banned = member.status === "banned";
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm text-zinc-200">{member.name}</p>
          <p className="truncate text-[11px] text-zinc-500">
            {member.username ? `@${member.username} · ` : ""}
            {statusLabel(member.status)}
            {member.rank ? ` · ${member.rank}` : ""}
          </p>
        </div>
        {member.isCreator && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
            Владелец
          </span>
        )}
      </div>
      {!member.isCreator && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {banned ? (
            <RowButton label="Разбанить" onClick={onUnban} disabled={busy} />
          ) : (
            <RowButton
              label="Забанить"
              onClick={onBan}
              disabled={busy}
              danger
            />
          )}
          <RowButton label="Кикнуть" onClick={onKick} disabled={busy} danger />
          {member.isAdmin ? (
            <RowButton
              label="Снять админа"
              onClick={onDemote}
              disabled={busy}
              danger
            />
          ) : (
            <RowButton label="Админ" onClick={onPromote} disabled={busy} />
          )}
          <RowButton label="Ранг" onClick={onRank} disabled={busy} />
        </div>
      )}
      {busy && <p className="mt-1 text-[11px] text-zinc-500">Выполняется…</p>}
    </li>
  );
}

function RowButton({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
        danger
          ? "border-red-900/60 text-red-300 hover:border-red-700"
          : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
      }`}
    >
      {label}
    </button>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold text-zinc-100">{title}</h4>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1 text-sm text-zinc-400 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PromoteModal({
  member,
  onClose,
  onSubmit,
}: {
  member: ChatAdminMemberView;
  onClose: () => void;
  onSubmit: (rights: ChatAdminRights, rank: string | null) => Promise<void>;
}) {
  const [rights, setRights] = useState<ChatAdminRights>({});
  const [rank, setRank] = useState(member.rank ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(rights, rank.trim() || null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Назначить админом: ${member.name}`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
          {RIGHT_LABELS.map((item) => (
            <label
              key={item.key}
              className="flex items-center gap-2 text-xs text-zinc-300"
            >
              <input
                type="checkbox"
                checked={rights[item.key] === true}
                onChange={(event) =>
                  setRights((previous) => ({
                    ...previous,
                    [item.key]: event.target.checked,
                  }))
                }
                className="accent-sky-500"
                autoComplete="off"
              />
              {item.label}
            </label>
          ))}
        </div>
        <p className="text-[10px] text-zinc-500">
          Без отмеченных прав участник станет админом без дополнительных
          возможностей (просмотр статистики и журнала действий).
        </p>
        <label className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
            Свой ранг (до 16 символов)
          </span>
          <input
            value={rank}
            onChange={(event) => setRank(event.target.value)}
            maxLength={16}
            placeholder="Модератор"
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
            autoComplete="off"
          />
        </label>
        {error && <p className="text-xs text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Сохранение…" : "Назначить"}
        </button>
      </form>
    </Modal>
  );
}

function RankModal({
  member,
  onClose,
  onSubmit,
}: {
  member: ChatAdminMemberView;
  onClose: () => void;
  onSubmit: (rank: string | null) => Promise<void>;
}) {
  const [rank, setRank] = useState(member.rank ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(rank.trim() || null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Ранг: ${member.name}`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <input
          value={rank}
          onChange={(event) => setRank(event.target.value)}
          maxLength={16}
          placeholder="Пусто — убрать ранг"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
          autoComplete="off"
        />
        {error && <p className="text-xs text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Сохранение…" : "Сохранить"}
        </button>
      </form>
    </Modal>
  );
}

function InvitesSection({
  accountId,
  chatId,
  onNotice,
}: {
  accountId: string;
  chatId: number;
  onNotice: (text: string | null) => void;
}) {
  const [items, setItems] = useState<ChatAdminInviteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyLink, setBusyLink] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [usageLimit, setUsageLimit] = useState("");
  const [expires, setExpires] = useState("");
  const [withApproval, setWithApproval] = useState(false);
  const [editing, setEditing] = useState<ChatAdminInviteView | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getChatAdminInvites(accountId, chatId);
      setItems(result.items);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [accountId, chatId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const copy = async (link: string) => {
    if (await copyToClipboard(link)) {
      onNotice(null);
      setCopied(link);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1600);
    } else {
      onNotice("Не удалось скопировать ссылку");
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    onNotice(null);
    setCreating(true);
    try {
      const input: ChatAdminInviteCreate = {};
      if (usageLimit.trim()) input.usageLimit = Number(usageLimit);
      if (expires) input.expiresAt = new Date(expires).getTime();
      if (withApproval) input.withApproval = true;
      if (name.trim()) input.name = name.trim();
      const link = await createChatAdminInvite(accountId, chatId, input);
      setItems((previous) => [link, ...previous]);
      setName("");
      setUsageLimit("");
      setExpires("");
      setWithApproval(false);
    } catch (cause) {
      onNotice(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (invite: ChatAdminInviteView) => {
    if (
      !window.confirm(
        "Отозвать эту ссылку? Все, кто ещё не вошёл по ней, не смогут присоединиться.",
      )
    ) {
      return;
    }
    onNotice(null);
    setBusyLink(invite.link);
    try {
      await revokeChatAdminInvite(accountId, chatId, invite.link);
      await load();
    } catch (cause) {
      onNotice(errorMessage(cause));
    } finally {
      setBusyLink(null);
    }
  };

  const exportPrimary = async () => {
    if (
      !window.confirm(
        "Получить основную ссылку заново? Текущая основная ссылка перестанет работать.",
      )
    ) {
      return;
    }
    onNotice(null);
    setBusyLink("primary");
    try {
      const link = await exportChatAdminPrimaryInvite(accountId, chatId);
      setItems((previous) => {
        const rest = previous.filter((item) => !item.isPrimary);
        return [link, ...rest];
      });
    } catch (cause) {
      onNotice(errorMessage(cause));
    } finally {
      setBusyLink(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void exportPrimary()}
          disabled={busyLink === "primary"}
          className="flex-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-50"
        >
          {busyLink === "primary" ? "Получение…" : "Основная ссылка"}
        </button>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-50"
        >
          Обновить
        </button>
      </div>

      <form
        onSubmit={(event) => void create(event)}
        className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5"
      >
        <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Новая ссылка
        </p>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Название (необязательно)"
          maxLength={32}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500"
          autoComplete="off"
        />
        <div className="flex gap-1.5">
          <input
            value={usageLimit}
            onChange={(event) => setUsageLimit(event.target.value)}
            inputMode="numeric"
            placeholder="Лимит входов"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500"
            autoComplete="off"
          />
          <input
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500"
            autoComplete="off"
          />
        </div>
        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={withApproval}
            onChange={(event) => setWithApproval(event.target.checked)}
            className="accent-sky-500"
            autoComplete="off"
          />
          Требовать одобрение админа
        </label>
        <button
          type="submit"
          disabled={creating}
          className="w-full rounded-md bg-sky-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          {creating ? "Создание…" : "Создать ссылку"}
        </button>
      </form>

      {loading && (
        <p className="py-4 text-center text-xs text-zinc-500">Загрузка…</p>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="py-6 text-center text-xs text-zinc-500">
          Пригласительных ссылок пока нет.
        </p>
      )}

      <ul className="space-y-1.5">
        {items.map((invite) => (
          <li
            key={invite.link}
            className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2"
          >
            <p className="break-all text-[11px] text-sky-400">{invite.link}</p>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {invite.isPrimary ? "Основная · " : ""}
              {invite.creatorName ? `${invite.creatorName} · ` : ""}
              входов: {formatUsage(invite)}
            </p>
            <p className="text-[11px] text-zinc-600">
              {invite.expiresAt
                ? `до ${formatDate(invite.expiresAt)}`
                : "бессрочная"}
              {invite.approvalNeeded ? " · с одобрением" : ""}
              {invite.isRevoked ? " · отозвана" : ""}
              {invite.pendingJoinRequests > 0
                ? ` · заявок: ${invite.pendingJoinRequests}`
                : ""}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <RowButton
                label={copied === invite.link ? "Скопировано" : "Копировать"}
                onClick={() => void copy(invite.link)}
                disabled={false}
              />
              {!invite.isPrimary && !invite.isRevoked && (
                <>
                  <RowButton
                    label="Изменить"
                    onClick={() => setEditing(invite)}
                    disabled={busyLink === invite.link}
                  />
                  <RowButton
                    label="Отозвать"
                    onClick={() => void revoke(invite)}
                    disabled={busyLink === invite.link}
                    danger
                  />
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <InviteEditModal
          invite={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (patch) => {
            const updated = await editChatAdminInvite(
              accountId,
              chatId,
              editing.link,
              patch,
            );
            setItems((previous) =>
              previous.map((item) =>
                item.link === updated.link ? updated : item,
              ),
            );
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function InviteEditModal({
  invite,
  onClose,
  onSubmit,
}: {
  invite: ChatAdminInviteView;
  onClose: () => void;
  onSubmit: (patch: {
    expiresAt?: number;
    usageLimit?: number;
    withApproval?: boolean;
  }) => Promise<void>;
}) {
  const [usageLimit, setUsageLimit] = useState(
    invite.usageLimit === null ? "" : String(invite.usageLimit),
  );
  const [expires, setExpires] = useState("");
  const [withApproval, setWithApproval] = useState(invite.approvalNeeded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const patch: {
        expiresAt?: number;
        usageLimit?: number;
        withApproval?: boolean;
      } = {};
      if (usageLimit.trim()) patch.usageLimit = Number(usageLimit);
      if (expires) patch.expiresAt = new Date(expires).getTime();
      if (withApproval !== invite.approvalNeeded) {
        patch.withApproval = withApproval;
      }
      if (Object.keys(patch).length === 0) {
        setError("Нет изменений");
        return;
      }
      await onSubmit(patch);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Изменить ссылку" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
            Лимит входов
          </span>
          <input
            value={usageLimit}
            onChange={(event) => setUsageLimit(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
            Действует до
          </span>
          <input
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
            autoComplete="off"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={withApproval}
            onChange={(event) => setWithApproval(event.target.checked)}
            className="accent-sky-500"
            autoComplete="off"
          />
          Требовать одобрение админа
        </label>
        {error && <p className="text-xs text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Сохранение…" : "Сохранить"}
        </button>
      </form>
    </Modal>
  );
}
