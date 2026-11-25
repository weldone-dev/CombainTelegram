"use client";

import { useCallback, useEffect, useState } from "react";
import type { TypingMode } from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
import { getChatAiSettings, setChatAiSettings } from "./chat-ai-api";
import { PanelCard, SMALL_BUTTON } from "./chat-tab-ui";

type OverrideValue = "" | TypingMode;

/** `""` means "no override": the account's soul decides. */
const MODE_OPTIONS: Array<{ value: OverrideValue; label: string }> = [
  { value: "", label: "Как у аккаунта" },
  { value: "off", label: "Никогда (off)" },
  { value: "on_think", label: "Пока думает (on_think)" },
  { value: "on_compose", label: "Когда текст готов (on_compose)" },
  { value: "smart", label: "Умный (smart)" },
];

function modeOf(settings: Record<string, unknown>): OverrideValue {
  const value = settings.typingMode;
  return MODE_OPTIONS.some((item) => item.value === value)
    ? (value as OverrideValue)
    : "";
}

/**
 * Compact per-chat «Печать» override of the «Доступ ИИ» tab. The API replaces
 * the whole settings object, so the editor merges into what it loaded and never
 * duplicates the account-wide typing form.
 */
export function ChatTypingOverride({
  accountId,
  chatId,
  threadId = 0,
}: {
  accountId: string;
  chatId: number;
  threadId?: number;
}) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey retries a failed load
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setStatus(null);
    getChatAiSettings(accountId, chatId, threadId)
      .then((result) => {
        if (!active) return;
        setSettings(result.settings);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, chatId, threadId, reloadKey]);

  const persist = useCallback(
    async (next: Record<string, unknown>, message: string) => {
      setSaving(true);
      setError(null);
      setStatus(null);
      try {
        const saved = await setChatAiSettings(
          accountId,
          chatId,
          next,
          threadId,
        );
        setSettings(saved.settings);
        setStatus(message);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSaving(false);
      }
    },
    [accountId, chatId, threadId],
  );

  const mode = settings ? modeOf(settings) : "";
  const hasOverride = settings !== null && Object.keys(settings).length > 0;

  const chooseMode = (value: OverrideValue) => {
    if (!settings || value === mode) return;
    const next: Record<string, unknown> = { ...settings };
    if (value === "") delete next.typingMode;
    else next.typingMode = value;
    void persist(
      next,
      value === ""
        ? "Печать: как у аккаунта"
        : `Печать для этого места: ${value}`,
    );
  };

  return (
    <PanelCard
      title={
        <>
          <span aria-hidden="true" className="text-sky-400">
            ⌨
          </span>
          Печать
        </>
      }
      hint="«Печатает…» только здесь; остальные настройки — в душе аккаунта"
      actions={
        <button
          type="button"
          onClick={() => void persist({}, "Переопределение печати сброшено")}
          disabled={saving || !hasOverride}
          title={
            hasOverride
              ? "Убрать все переопределения этого чата/треда"
              : "Переопределений уже нет"
          }
          className={SMALL_BUTTON}
        >
          {saving ? "…" : "Сбросить"}
        </button>
      }
    >
      {loading && !settings ? (
        <p className="mt-2 text-[11px] text-zinc-500">Загрузка режима…</p>
      ) : settings === null ? (
        <div className="mt-2 space-y-1.5">
          <p role="alert" className="text-[11px] text-red-300">
            {error ?? "Не удалось загрузить режим печати"}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            title="Повторить загрузку"
            className={SMALL_BUTTON}
          >
            Повторить
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          <label className="block text-[11px] text-zinc-500">
            <span className="mb-1 block">Режим печати</span>
            <select
              value={mode}
              disabled={saving || settings === null}
              onChange={(event) =>
                chooseMode(event.target.value as OverrideValue)
              }
              aria-label="Режим печати для этого чата"
              autoComplete="off"
              className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500 disabled:opacity-50"
            >
              {MODE_OPTIONS.map((item) => (
                <option key={item.value || "inherit"} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-zinc-600">
            {hasOverride
              ? "Здесь сохранено переопределение: значение из души аккаунта не используется."
              : "Переопределения нет — действует режим души аккаунта."}
            {threadId > 0 ? ` Тред #${threadId}.` : ""}
          </p>
          {status && (
            <p aria-live="polite" className="text-[11px] text-emerald-300">
              {status}
            </p>
          )}
          {error && (
            <p role="alert" className="text-[11px] text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </PanelCard>
  );
}
