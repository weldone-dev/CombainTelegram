"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AccountAiSettingsView,
  type AiCapabilities,
  type AiCapabilityPatch,
  aiErrorMessage,
  getAccountAiSettings,
  patchAccountAiSettings,
} from "../../lib/ai-api";
import {
  Card,
  ErrorBanner,
  GhostButton,
  OkBanner,
  Pill,
  PrimaryButton,
} from "./ai-ui";

/** Russian labels for known capabilities; unknown keys fall back to the key. */
const CAPABILITY_LABELS: Record<string, string> = {
  read: "Чтение",
  send: "Отправка сообщений",
  sendUnknown: "Писать незнакомым",
  edit: "Редактирование",
  delete: "Удаление",
  react: "Реакции",
  admin: "Администрирование",
  souls: "Души и память",
  skills: "Скиллы",
  automations: "Автоматизации",
  bots: "Боты",
  policy: "Изменение разрешений",
  mcp: "MCP-доступ",
};

const CAPABILITY_HINTS: Record<string, string> = {
  read: "История, поиск и чтение переписок.",
  send: "Без этого ИИ и MCP не могут отправлять сообщения от имени аккаунта.",
  sendUnknown:
    "Писать в чаты, где ещё нет диалога. Обычно выключено глобально.",
  edit: "Правка уже отправленных сообщений.",
  delete: "Удаление сообщений у всех. Включайте осознанно.",
  react: "Ставить и убирать реакции.",
  admin: "Участники, баны, ссылки-приглашения. Очень опасное право.",
  souls: "Менять душу, память и персональные настройки.",
  skills: "Создавать и менять скиллы.",
  automations: "Создавать и запускать автоматизации.",
  bots: "Управлять Telegram-ботами.",
  policy: "Позволяет ИИ менять собственные разрешения.",
  mcp: "Полный выключатель внешнего доступа по HTTP.",
};

type Overrides = Record<string, boolean>;

function overridesOf(permissions: Partial<Record<string, boolean>>): Overrides {
  const result: Overrides = {};
  for (const [key, value] of Object.entries(permissions)) {
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

function has(map: Overrides, key: string): boolean {
  return Object.hasOwn(map, key);
}

function sameOverrides(a: Overrides, b: Overrides): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (has(a, key) !== has(b, key)) return false;
    if (has(a, key) && a[key] !== b[key]) return false;
  }
  return true;
}

function diffKeys(a: Overrides, b: Overrides): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => {
    if (has(a, key) !== has(b, key)) return true;
    return has(a, key) && a[key] !== b[key];
  });
}

function plural(value: number, forms: [string, string, string]): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function labelOf(key: string): string {
  return CAPABILITY_LABELS[key] ?? key;
}

/**
 * Per-account overrides of the global AI capabilities. Three states per
 * capability: inherit the global default, allow, or deny. Only the changed
 * keys are PATCHed; `null` removes an override.
 */
export function AccountAiPermissions({
  accountId,
  onNotice,
}: {
  accountId: string;
  onNotice?: (message: string) => void;
}) {
  const [view, setView] = useState<AccountAiSettingsView | null>(null);
  const [draft, setDraft] = useState<Overrides>({});
  const [saved, setSaved] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const apply = useCallback((next: AccountAiSettingsView) => {
    setView(next);
    const overrides = overridesOf(next.permissions);
    setDraft(overrides);
    setSaved(overrides);
  }, []);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setLoadError(null);
      setError(null);
      setStatus(null);
      try {
        apply(await getAccountAiSettings(id));
      } catch (loadFailure) {
        setLoadError(aiErrorMessage(loadFailure));
      } finally {
        setLoading(false);
      }
    },
    [apply],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey retries a failed load
  useEffect(() => {
    void load(accountId);
  }, [load, accountId, reloadKey]);

  const defaultOf = (key: string) =>
    view?.defaults[key as keyof AiCapabilities] === true;
  const keys = useMemo(() => {
    if (!view) return [];
    const ordered = Object.keys(view.defaults);
    for (const key of Object.keys(draft)) {
      if (!ordered.includes(key)) ordered.push(key);
    }
    return ordered;
  }, [view, draft]);

  const dirty = useMemo(() => diffKeys(draft, saved), [draft, saved]);
  const overrideCount = Object.keys(draft).length;
  const changedCount = useMemo(() => {
    if (!view) return 0;
    const defaults = view.defaults;
    return Object.keys(draft).filter(
      (key) => draft[key] !== defaults[key as keyof AiCapabilities],
    ).length;
  }, [draft, view]);

  const setState = (key: string, state: "default" | "allow" | "deny") => {
    setStatus(null);
    setDraft((previous) => {
      const next = { ...previous };
      if (state === "default") delete next[key];
      else next[key] = state === "allow";
      return next;
    });
  };

  const resetKey = (key: string) => {
    setStatus(null);
    setDraft((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  const resetAll = () => {
    setStatus(null);
    setDraft({});
  };

  const save = async () => {
    if (saving || !view) return;
    setError(null);
    setStatus(null);
    if (sameOverrides(draft, saved)) {
      setStatus("Изменений нет");
      return;
    }
    const patch: Record<string, boolean | null> = {};
    for (const key of diffKeys(draft, saved)) {
      patch[key] = has(draft, key) ? draft[key] : null;
    }
    setSaving(true);
    try {
      const next = await patchAccountAiSettings(
        accountId,
        patch as AiCapabilityPatch,
      );
      const labels = Object.keys(patch).map(labelOf);
      apply(next);
      setStatus(
        labels.length > 0 ? `Сохранено: ${labels.join(", ")}` : "Сохранено",
      );
      onNotice?.("Права ИИ аккаунта сохранены");
    } catch (saveFailure) {
      // Draft stays as is, so the same patch can be retried.
      setError(aiErrorMessage(saveFailure));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !view) {
    return (
      <Card title="Права ИИ" description="Индивидуальные разрешения аккаунта.">
        <p className="text-sm text-zinc-500" aria-live="polite">
          Загрузка прав ИИ…
        </p>
      </Card>
    );
  }

  if (!view) {
    return (
      <Card title="Права ИИ" description="Индивидуальные разрешения аккаунта.">
        <ErrorBanner message={loadError} />
        <GhostButton onClick={() => setReloadKey((key) => key + 1)}>
          Повторить
        </GhostButton>
      </Card>
    );
  }

  return (
    <Card
      title="Права ИИ"
      description="Что ИИ и MCP-клиенты могут делать именно с этим аккаунтом. Ключ без переопределения наследует глобальные настройки."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <GhostButton
            onClick={resetAll}
            disabled={saving || overrideCount === 0}
          >
            Сбросить всё
          </GhostButton>
          <PrimaryButton
            onClick={() => void save()}
            disabled={saving || dirty.length === 0}
          >
            {saving ? "Сохранение…" : "Сохранить права"}
          </PrimaryButton>
        </div>
      }
    >
      <div className="min-w-0 space-y-3">
        {error && <ErrorBanner message={error} />}
        {status && <OkBanner message={status} />}
        {loadError && (
          <p className="break-words rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            Не удалось обновить список: {loadError}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <p className="text-xs text-zinc-400">
            <span className="font-medium text-zinc-200">{changedCount}</span>{" "}
            {plural(changedCount, ["отличие", "отличия", "отличий"])} от
            глобальных настроек
            {overrideCount !== changedCount && (
              <span className="text-zinc-500">
                {" "}
                · переопределено: {overrideCount}
              </span>
            )}
          </p>
          <p className="text-[11px] text-zinc-500">
            Глобальные значения — в{" "}
            <Link
              href="/settings/ai"
              className="text-sky-400 hover:text-sky-300 hover:underline"
            >
              Настройки → AI
            </Link>
            ; здесь только отличия этого аккаунта.
          </p>
        </div>

        {dirty.length > 0 && (
          <p
            aria-live="polite"
            className="break-words rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200"
          >
            <span className="font-medium">Не сохранено:</span>{" "}
            {dirty.map(labelOf).join(", ")}
          </p>
        )}

        <div className="space-y-1.5">
          {keys.map((key) => {
            const defaultValue = defaultOf(key);
            const hasOverride = has(draft, key);
            const value = hasOverride
              ? draft[key]
                ? "allow"
                : "deny"
              : "default";
            const effective = hasOverride ? draft[key] : defaultValue;
            const changed = hasOverride && draft[key] !== defaultValue;
            const hint = CAPABILITY_HINTS[key];
            return (
              <div
                key={key}
                className={`rounded-md border px-2.5 py-2 ${
                  changed
                    ? "border-amber-700/50 bg-amber-950/10"
                    : "border-zinc-800"
                }`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm text-zinc-200">
                        {labelOf(key)}
                      </span>
                      {changed && <Pill tone="amber">изменено</Pill>}
                      {hasOverride && !changed && (
                        <Pill tone="zinc">переопределено</Pill>
                      )}
                    </div>
                    <p className="mt-0.5 break-words text-[11px] text-zinc-500">
                      По умолчанию: {defaultValue ? "включено" : "выключено"} ·
                      действует: {effective ? "разрешено" : "запрещено"}
                      {key !== labelOf(key) && (
                        <span className="text-zinc-600"> · {key}</span>
                      )}
                    </p>
                    {hint && (
                      <p className="mt-0.5 break-words text-[11px] text-zinc-600">
                        {hint}
                      </p>
                    )}
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:shrink-0">
                    <select
                      value={value}
                      disabled={saving}
                      autoComplete="off"
                      aria-label={`Права ИИ: ${labelOf(key)}`}
                      onChange={(event) =>
                        setState(
                          key,
                          event.target.value as "default" | "allow" | "deny",
                        )
                      }
                      className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:opacity-50 sm:flex-none"
                    >
                      <option value="default">
                        По умолчанию ({defaultValue ? "вкл" : "выкл"})
                      </option>
                      <option value="allow">Разрешено</option>
                      <option value="deny">Запрещено</option>
                    </select>
                    <GhostButton
                      onClick={() => resetKey(key)}
                      disabled={saving || !hasOverride}
                    >
                      Сбросить
                    </GhostButton>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 pt-3">
          <GhostButton
            onClick={resetAll}
            disabled={saving || overrideCount === 0}
          >
            Сбросить всё
          </GhostButton>
          <PrimaryButton
            onClick={() => void save()}
            disabled={saving || dirty.length === 0}
          >
            {saving ? "Сохранение…" : "Сохранить права"}
          </PrimaryButton>
        </div>
      </div>
    </Card>
  );
}
