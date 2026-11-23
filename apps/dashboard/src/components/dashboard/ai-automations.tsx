"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type AutomationRun,
  type AutomationView,
  createAutomation,
  deleteAutomation,
  getAutomationRuns,
  listAutomations,
  runAutomation,
  updateAutomation,
} from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
import { Card, Field, inputClass, Pill, textareaClass } from "./ai-ui";
import { useAppData } from "./app-data";

interface Draft {
  id: string | null;
  name: string;
  description: string;
  accountId: string;
  enabled: boolean;
  triggerKind: "every" | "daily" | "incoming_message" | "manual";
  minutes: string;
  at: string;
  keywords: string;
  triggerChatIds: string;
  actionType: "agent" | "send_message" | "summarize";
  prompt: string;
  chatId: string;
  text: string;
  sendOutput: boolean;
}

function parseIds(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item !== 0);
}

function draftOf(automation: AutomationView | null): Draft {
  const trigger = automation?.trigger ?? {};
  const action = automation?.action ?? {};
  return {
    id: automation?.id ?? null,
    name: automation?.name ?? "",
    description: automation?.description ?? "",
    accountId: automation?.accountId ?? "",
    enabled: automation?.enabled ?? false,
    triggerKind:
      (trigger.kind as Draft["triggerKind"]) ??
      (automation?.triggerType === "incoming_message"
        ? "incoming_message"
        : "every"),
    minutes: String(trigger.minutes ?? 30),
    at: String(trigger.at ?? "09:00"),
    keywords: Array.isArray(trigger.keywords)
      ? trigger.keywords.join(", ")
      : "",
    triggerChatIds: Array.isArray(trigger.chatIds)
      ? trigger.chatIds.join(", ")
      : "",
    actionType:
      (action.type as Draft["actionType"]) ??
      (automation?.actionType as Draft["actionType"]) ??
      "agent",
    prompt: String(action.prompt ?? ""),
    chatId: action.chatId ? String(action.chatId) : "",
    text: String(action.text ?? ""),
    sendOutput: action.send === true || action.sendOutput !== false,
  };
}

function triggerSummary(automation: AutomationView): string {
  const trigger = automation.trigger;
  if (automation.triggerType === "incoming_message") {
    const keywords = Array.isArray(trigger.keywords)
      ? trigger.keywords.join(", ")
      : "";
    return keywords ? `входящее: ${keywords}` : "любое входящее сообщение";
  }
  if (trigger.kind === "daily") return `ежедневно в ${String(trigger.at)}`;
  if (trigger.kind === "every") return `каждые ${String(trigger.minutes)} мин`;
  return "вручную";
}

export function AutomationsPanel() {
  const { accounts } = useAppData();
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [draft, setDraft] = useState<Draft>(() => draftOf(null));
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async (selectId?: string) => {
    setError(null);
    try {
      const result = await listAutomations();
      setAutomations(result.automations);
      const next =
        result.automations.find((item) => item.id === selectId) ??
        result.automations[0] ??
        null;
      setDraft(draftOf(next));
      if (next) {
        const runList = await getAutomationRuns(next.id);
        setRuns(runList.runs);
      } else {
        setRuns([]);
      }
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (automation: AutomationView) => {
    setDraft(draftOf(automation));
    setSaved(null);
    try {
      const runList = await getAutomationRuns(automation.id);
      setRuns(runList.runs);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  };

  const build = (): Record<string, unknown> => {
    const trigger: Record<string, unknown> = { kind: draft.triggerKind };
    if (draft.triggerKind === "every") {
      trigger.minutes = Math.max(1, Number(draft.minutes) || 30);
    }
    if (draft.triggerKind === "daily") trigger.at = draft.at;
    if (draft.triggerKind === "incoming_message") {
      trigger.keywords = draft.keywords
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      trigger.chatIds = parseIds(draft.triggerChatIds);
    }
    const action: Record<string, unknown> = { type: draft.actionType };
    if (draft.actionType === "agent") {
      action.prompt = draft.prompt;
      if (draft.chatId) action.chatId = Number(draft.chatId);
      action.send = draft.sendOutput;
    } else if (draft.actionType === "send_message") {
      action.chatId = Number(draft.chatId);
      action.text = draft.text;
    } else {
      action.chatId = Number(draft.chatId);
    }
    return {
      accountId: draft.accountId || null,
      name: draft.name,
      description: draft.description,
      enabled: draft.enabled,
      trigger,
      action,
    };
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setError("Нужно название автоматизации");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const body = build();
      const next = draft.id
        ? await updateAutomation(draft.id, body)
        : await createAutomation(body);
      setSaved(`Автоматизация «${next.name}» сохранена`);
      await load(next.id);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!draft.id) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runAutomation(draft.id);
      setSaved(
        result.status === "ok"
          ? `Выполнено: ${result.output ?? "готово"}`
          : `Ошибка: ${result.error ?? result.status}`,
      );
      const runList = await getAutomationRuns(draft.id);
      setRuns(runList.runs);
      await load(draft.id);
    } catch (runError) {
      setError(errorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id) return;
    if (!window.confirm(`Удалить «${draft.name}»?`)) return;
    setBusy(true);
    try {
      await deleteAutomation(draft.id);
      setSaved("Автоматизация удалена");
      await load();
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card
        title="Автоматизации"
        description="Триггеры и действия"
        actions={
          <button
            type="button"
            onClick={() => {
              setDraft(draftOf(null));
              setRuns([]);
              setSaved(null);
            }}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            + Новая
          </button>
        }
      >
        <div className="space-y-1">
          {automations.map((automation) => (
            <button
              key={automation.id}
              type="button"
              onClick={() => void select(automation)}
              className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left text-sm ${
                draft.id === automation.id
                  ? "bg-sky-500/15 text-sky-200"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {automation.name}
                </span>
                <Pill tone={automation.enabled ? "green" : "zinc"}>
                  {automation.enabled ? "on" : "off"}
                </Pill>
              </span>
              <span className="truncate text-[11px] text-zinc-500">
                {triggerSummary(automation)}
              </span>
            </button>
          ))}
          {automations.length === 0 && (
            <p className="text-xs text-zinc-500">Пока нет автоматизаций.</p>
          )}
        </div>
      </Card>

      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {saved && (
          <div className="rounded-md border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
            {saved}
          </div>
        )}

        <Card
          title={draft.id ? "Редактирование" : "Новая автоматизация"}
          description="По умолчанию автоматизация выключена и не пишет никому."
          actions={
            <div className="flex gap-2">
              {draft.id && (
                <button
                  type="button"
                  onClick={() => void runNow()}
                  disabled={busy}
                  className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  Запустить
                </button>
              )}
              {draft.id && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  className="rounded-md border border-red-900/60 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40"
                >
                  Удалить
                </button>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                Сохранить
              </button>
            </div>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Название">
              <input
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Аккаунт">
              <select
                value={draft.accountId}
                onChange={(event) =>
                  setDraft({ ...draft, accountId: event.target.value })
                }
                className={inputClass}
              >
                <option value="">Все аккаунты</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountName(account)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Описание" className="sm:col-span-2">
              <input
                value={draft.description}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
                className={inputClass}
              />
            </Field>
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            Включена
          </label>

          <div className="mt-4 rounded-md border border-zinc-800 p-3">
            <p className="mb-2 text-xs font-medium text-zinc-300">Триггер</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["every", "Каждые N минут"],
                  ["daily", "Ежедневно"],
                  ["incoming_message", "Входящее сообщение"],
                  ["manual", "Вручную"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setDraft({ ...draft, triggerKind: kind })}
                  className={`rounded-md border px-2.5 py-1.5 text-xs ${
                    draft.triggerKind === kind
                      ? "border-sky-500 bg-sky-500/15 text-sky-300"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {draft.triggerKind === "every" && (
                <Field label="Интервал, минут">
                  <input
                    value={draft.minutes}
                    onChange={(event) =>
                      setDraft({ ...draft, minutes: event.target.value })
                    }
                    className={inputClass}
                    inputMode="numeric"
                  />
                </Field>
              )}
              {draft.triggerKind === "daily" && (
                <Field label="Время (HH:MM)">
                  <input
                    value={draft.at}
                    onChange={(event) =>
                      setDraft({ ...draft, at: event.target.value })
                    }
                    className={inputClass}
                    placeholder="09:00"
                  />
                </Field>
              )}
              {draft.triggerKind === "incoming_message" && (
                <>
                  <Field label="Ключевые слова (через запятую)">
                    <input
                      value={draft.keywords}
                      onChange={(event) =>
                        setDraft({ ...draft, keywords: event.target.value })
                      }
                      className={inputClass}
                      placeholder="пусто = любое сообщение"
                    />
                  </Field>
                  <Field label="Только эти chat id">
                    <input
                      value={draft.triggerChatIds}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          triggerChatIds: event.target.value,
                        })
                      }
                      className={inputClass}
                      placeholder="через запятую"
                    />
                  </Field>
                </>
              )}
            </div>
          </div>

          <div className="mt-3 rounded-md border border-zinc-800 p-3">
            <p className="mb-2 text-xs font-medium text-zinc-300">Действие</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["agent", "Запустить агента"],
                  ["send_message", "Отправить сообщение"],
                  ["summarize", "Сжать память"],
                ] as const
              ).map(([type, label]) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setDraft({ ...draft, actionType: type })}
                  className={`rounded-md border px-2.5 py-1.5 text-xs ${
                    draft.actionType === type
                      ? "border-sky-500 bg-sky-500/15 text-sky-300"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {draft.actionType === "agent" && (
                <Field label="Промпт агенту" className="sm:col-span-2">
                  <textarea
                    value={draft.prompt}
                    onChange={(event) =>
                      setDraft({ ...draft, prompt: event.target.value })
                    }
                    className={textareaClass}
                    placeholder="Проверь новые сообщения и составь короткую сводку."
                  />
                </Field>
              )}
              {draft.actionType === "send_message" && (
                <Field label="Текст" className="sm:col-span-2">
                  <textarea
                    value={draft.text}
                    onChange={(event) =>
                      setDraft({ ...draft, text: event.target.value })
                    }
                    className={textareaClass}
                  />
                </Field>
              )}
              <Field
                label="Chat id"
                hint={
                  draft.actionType === "summarize"
                    ? "Чей диалог сжимать"
                    : "Куда отправить (для агента — необязательно)"
                }
              >
                <input
                  value={draft.chatId}
                  onChange={(event) =>
                    setDraft({ ...draft, chatId: event.target.value })
                  }
                  className={inputClass}
                  inputMode="numeric"
                />
              </Field>
              {draft.actionType === "agent" && (
                <label className="flex items-end gap-2 pb-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.sendOutput}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        sendOutput: event.target.checked,
                      })
                    }
                  />
                  Отправить ответ агента в чат
                </label>
              )}
            </div>
          </div>
        </Card>

        {draft.id && (
          <Card title="История запусков" description="Последние 30">
            <div className="space-y-1.5">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="rounded-md border border-zinc-800 px-2 py-1.5 text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-400">
                      {new Date(run.startedAt).toLocaleString("ru-RU")}
                    </span>
                    <Pill tone={run.status === "ok" ? "green" : "red"}>
                      {run.status}
                    </Pill>
                  </div>
                  <p className="mt-1 text-zinc-300">
                    {run.error ?? run.output ?? "—"}
                  </p>
                </div>
              ))}
              {runs.length === 0 && (
                <p className="text-xs text-zinc-500">Запусков ещё не было.</p>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
