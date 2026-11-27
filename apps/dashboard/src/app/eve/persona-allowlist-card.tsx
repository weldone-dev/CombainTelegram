"use client";

import { useState } from "react";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
  PrimaryButton,
  Toggle,
} from "../../components/dashboard/ai-ui";
import {
  allowChat,
  type EveChatBindingView,
  eveErrorMessage,
} from "../../lib/eve-api";
import { accountName } from "../../lib/format";
import { resolveChat } from "../../lib/messaging-api";
import type { AccountView } from "../../lib/types";

function labelOf(accountId: string, accounts: AccountView[]): string {
  const account = accounts.find((item) => item.id === accountId);
  return account ? accountName(account) : accountId;
}

export function PersonaAllowlistCard({
  personaId,
  accounts,
  boundAccountIds,
  bindings,
  loading,
  error,
  onReload,
  onNotice,
}: {
  personaId: string;
  accounts: AccountView[];
  boundAccountIds: string[];
  bindings: EveChatBindingView[];
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void> | void;
  onNotice: (message: string) => void;
}) {
  const [account, setAccount] = useState("");
  const [chatId, setChatId] = useState("");
  const [threadId, setThreadId] = useState("0");
  const [note, setNote] = useState("");
  const [allowed, setAllowed] = useState(false);
  const [lookup, setLookup] = useState<"id" | "username">("id");
  const [username, setUsername] = useState("");
  const [resolvedTitle, setResolvedTitle] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const accountId = boundAccountIds.includes(account)
    ? account
    : (boundAccountIds[0] ?? "");

  const blockedCount = bindings.filter((binding) => !binding.allowed).length;
  const allowedCount = bindings.length - blockedCount;

  /**
   * `@username` is resolved through the regular dashboard API
   * (`GET /accounts/:id/chats/resolve`) because the Eve contract addresses
   * chats by numeric id only. A numeric value is accepted in both modes.
   */
  const resolveUsername = async () => {
    setLocalError(null);
    setSaved(null);
    const raw = username.trim().replace(/^@+/, "");
    if (!raw) {
      setLocalError("Укажите @username или числовой chat ID");
      return;
    }
    if (!accountId) {
      setLocalError("Сначала привяжите Telegram-аккаунт к персоне");
      return;
    }
    const numeric = Number(raw);
    if (/^-?\d+$/.test(raw) && Number.isSafeInteger(numeric) && numeric !== 0) {
      setChatId(raw);
      setResolvedTitle(null);
      setSaved(`Это уже числовой ID: ${raw}`);
      return;
    }

    setResolving(true);
    try {
      const chat = await resolveChat(accountId, raw);
      setChatId(String(chat.id));
      setResolvedTitle(
        `${chat.title}${chat.username ? ` · @${chat.username}` : ""}`,
      );
      setSaved(`Найдено: ${chat.title} · chat ID ${chat.id}`);
    } catch (resolveError) {
      setResolvedTitle(null);
      setLocalError(eveErrorMessage(resolveError));
    } finally {
      setResolving(false);
    }
  };

  const create = async () => {
    setLocalError(null);
    setSaved(null);

    let parsedChatId: number;
    let parsedThreadId: number;
    try {
      if (!accountId) {
        throw new Error("Сначала привяжите Telegram-аккаунт к персоне");
      }
      const rawChatId = chatId.trim();
      parsedChatId = Number(rawChatId);
      if (
        !rawChatId ||
        !Number.isSafeInteger(parsedChatId) ||
        parsedChatId === 0
      ) {
        throw new Error(
          lookup === "username" && !rawChatId
            ? "Сначала найдите чат кнопкой «Найти», чтобы получить chat ID"
            : "Chat ID должен быть целым ненулевым числом",
        );
      }
      parsedThreadId = Number(threadId.trim() || "0");
      if (!Number.isInteger(parsedThreadId) || parsedThreadId < 0) {
        throw new Error("Thread ID должен быть целым числом ≥ 0");
      }
    } catch (validationError) {
      setLocalError(
        validationError instanceof Error
          ? validationError.message
          : "Проверьте поля allowlist",
      );
      return;
    }

    setBusy("new");
    try {
      await allowChat(personaId, {
        accountId,
        chatId: parsedChatId,
        threadId: parsedThreadId,
        allowed,
        note: note.trim(),
      });
      setSaved(
        `Чат ${parsedChatId} добавлен: ${allowed ? "разрешён" : "заблокирован"}`,
      );
      onNotice(
        `Allowlist обновлён: чат ${parsedChatId} ${allowed ? "разрешён" : "заблокирован"}`,
      );
      setChatId("");
      setThreadId("0");
      setNote("");
      setUsername("");
      setResolvedTitle(null);
      setAllowed(false);
      await onReload();
    } catch (createError) {
      setLocalError(eveErrorMessage(createError));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (binding: EveChatBindingView) => {
    setLocalError(null);
    setSaved(null);
    setBusy(binding.id);
    try {
      await allowChat(personaId, {
        accountId: binding.accountId,
        chatId: binding.chatId,
        threadId: binding.threadId,
        allowed: !binding.allowed,
        note: binding.note ?? "",
      });
      setSaved(
        `Чат ${String(binding.chatId)} ${binding.allowed ? "заблокирован" : "разрешён"}`,
      );
      onNotice("Allowlist обновлён");
      await onReload();
    } catch (toggleError) {
      setLocalError(eveErrorMessage(toggleError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Allowlist чатов"
      description="Явный список чатов, в которых Eve может отвечать. Запись создаётся и для заблокированных чатов."
    >
      <div className="mb-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
        Новые чаты <strong>блокируются по умолчанию</strong>: без строки в этом
        списке или с <code>allowed = false</code> Eve не ответит. Включайте чат
        только осознанно.
      </div>

      {bindings.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <Pill tone="green">разрешено: {allowedCount}</Pill>
          <Pill tone={blockedCount > 0 ? "red" : "zinc"}>
            заблокировано: {blockedCount}
          </Pill>
          <span>по умолчанию новый чат = blocked</span>
        </div>
      )}

      <ErrorBanner message={localError} />
      <ErrorBanner message={error} />
      <OkBanner message={saved} />
      {error && (
        <div className="-mt-1 mb-3">
          <GhostButton onClick={() => void onReload()} disabled={loading}>
            {loading ? "Загрузка…" : "Повторить"}
          </GhostButton>
        </div>
      )}

      {boundAccountIds.length === 0 ? (
        <p className="text-xs text-zinc-500">
          Сначала привяжите аккаунт выше — allowlist привязан к паре аккаунт +
          chat ID.
        </p>
      ) : loading && bindings.length === 0 ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1].map((row) => (
            <div
              key={row}
              className="h-12 animate-pulse rounded-md bg-zinc-800/60"
            />
          ))}
        </div>
      ) : error && bindings.length === 0 ? (
        <p className="text-xs text-zinc-500">
          Список allowlist не загрузился — повторите запрос выше.
        </p>
      ) : bindings.length === 0 ? (
        <p className="text-xs text-zinc-500">
          Allowlist пуст: Eve не ответит ни в один чат. Добавьте чат ниже.
        </p>
      ) : (
        <div className="space-y-2">
          {bindings.map((binding) => (
            <div
              key={binding.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/30 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm text-zinc-200">
                    {labelOf(binding.accountId, accounts)}
                  </span>
                  <Pill tone={binding.allowed ? "green" : "red"}>
                    {binding.allowed ? "allowed" : "blocked"}
                  </Pill>
                </div>
                <div className="truncate font-mono text-[11px] text-zinc-500">
                  chat {String(binding.chatId)} · thread {binding.threadId}
                  {binding.note ? ` · ${binding.note}` : ""}
                </div>
              </div>
              <GhostButton
                onClick={() => void toggle(binding)}
                disabled={busy !== null}
                danger={binding.allowed}
              >
                {busy === binding.id
                  ? "…"
                  : binding.allowed
                    ? "Заблокировать"
                    : "Разрешить"}
              </GhostButton>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field label="Аккаунт">
          <select
            value={accountId}
            onChange={(event) => {
              setAccount(event.target.value);
              setResolvedTitle(null);
              setLocalError(null);
              setSaved(null);
            }}
            disabled={boundAccountIds.length === 0 || busy !== null}
            className={inputClass}
          >
            {boundAccountIds.length === 0 && (
              <option value="">Нет привязанных аккаунтов</option>
            )}
            {boundAccountIds.map((id) => (
              <option key={id} value={id}>
                {labelOf(id, accounts)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Как добавить"
          hint="По @username дашборд сам получит числовой chat ID через Telegram."
        >
          <select
            value={lookup}
            onChange={(event) => {
              const next =
                event.target.value === "username" ? "username" : "id";
              setLookup(next);
              setLocalError(null);
              setSaved(null);
            }}
            disabled={boundAccountIds.length === 0 || busy !== null}
            className={inputClass}
          >
            <option value="id">По числовому chat ID</option>
            <option value="username">По @username</option>
          </select>
        </Field>
        {lookup === "id" ? (
          <Field
            label="Chat ID"
            hint="Число из Telegram; для групп и каналов обычно отрицательное."
          >
            <input
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              className={`${inputClass} font-mono`}
              placeholder="-1001234567890"
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
        ) : (
          <Field
            label="@username"
            hint={
              resolvedTitle
                ? `${resolvedTitle} · chat_id ${chatId || "—"}`
                : "Нажмите «Найти» — username резолвится через аккаунт Telegram."
            }
          >
            <input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setResolvedTitle(null);
              }}
              className={`${inputClass} font-mono`}
              placeholder="@durov"
              autoComplete="off"
              disabled={busy !== null || resolving}
            />
          </Field>
        )}
        <Field
          label="Thread ID"
          hint="0 = весь чат; для топиков укажите id темы."
        >
          <input
            type="number"
            min={0}
            step={1}
            value={threadId}
            onChange={(event) => setThreadId(event.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </Field>
        <Field
          label="Заметка"
          hint="Необязательно: зачем этот чат в allowlist."
        >
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={inputClass}
            placeholder="личный чат"
            autoComplete="off"
          />
        </Field>
        <div className="sm:col-span-2">
          <Toggle
            checked={allowed}
            onChange={setAllowed}
            disabled={busy !== null}
            label="Разрешить ответы сразу"
            hint="Выключено = чат добавлен в список, но Eve в нём молчит."
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {lookup === "username" && (
          <GhostButton
            onClick={() => void resolveUsername()}
            disabled={
              busy !== null || resolving || !accountId || !username.trim()
            }
          >
            {resolving ? "Поиск…" : "Найти chat ID"}
          </GhostButton>
        )}
        <PrimaryButton
          onClick={() => void create()}
          disabled={busy !== null || resolving || !accountId}
        >
          {busy === "new" ? "Сохранение…" : "Добавить чат"}
        </PrimaryButton>
      </div>
    </Card>
  );
}
