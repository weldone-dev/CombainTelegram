"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AutomationRun,
  type AutomationView,
  aiErrorMessage,
  createAutomation,
  deleteAutomation,
  getAutomationRuns,
  listAutomations,
  resumeAutomation,
  runAutomation,
  updateAutomation,
} from "../../lib/ai-api";
import {
  browserTimeZone,
  createdByLabel,
  isValidTimeZone,
} from "../../lib/automations-format";
import { accountName } from "../../lib/format";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
  PrimaryButton,
  textareaClass,
} from "./ai-ui";
import { useAppData } from "./app-data";

type TriggerKind = "every" | "daily" | "incoming_message" | "manual";
type ActionType = "agent" | "send_message" | "summarize";

interface Draft {
  id: string | null;
  name: string;
  description: string;
  accountId: string;
  /** Optional chat scope of the automation itself (not the action target). */
  scopeChatId: string;
  scopeThreadId: string;
  timezone: string;
  createdBy: string;
  enabled: boolean;
  triggerKind: TriggerKind;
  minutes: string;
  at: string;
  keywords: string;
  triggerChatIds: string;
  actionType: ActionType;
  prompt: string;
  chatId: string;
  text: string;
  actionSkillSlugs: string;
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
    scopeChatId:
      automation?.chatId !== null && automation?.chatId !== undefined
        ? String(automation.chatId)
        : "",
    scopeThreadId:
      automation?.threadId !== undefined && automation.threadId > 0
        ? String(automation.threadId)
        : "",
    timezone: automation?.timezone ?? browserTimeZone(),
    createdBy: automation?.createdBy ?? "user",
    enabled: automation?.enabled ?? false,
    triggerKind:
      (trigger.kind as TriggerKind) ??
      (automation?.triggerType === "incoming_message"
        ? "incoming_message"
        : automation?.triggerType === "manual"
          ? "manual"
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
      (action.type as ActionType) ??
      (automation?.actionType as ActionType) ??
      "agent",
    prompt: String(action.prompt ?? ""),
    chatId: action.chatId ? String(action.chatId) : "",
    text: String(action.text ?? ""),
    actionSkillSlugs: Array.isArray(action.skillSlugs)
      ? action.skillSlugs.join(", ")
      : "",
    // The runner reads `action.sendOutput`; the old `action.send` key was
    // silently ignored, so every scheduled agent reply was sent.
    sendOutput: action.sendOutput !== false,
  };
}

/** Drop form values that do not belong to the selected trigger kind. */
function withTriggerKind(draft: Draft, kind: TriggerKind): Draft {
  return {
    ...draft,
    triggerKind: kind,
    minutes: kind === "every" ? draft.minutes : "",
    at: kind === "daily" ? draft.at : "",
    keywords: kind === "incoming_message" ? draft.keywords : "",
    triggerChatIds: kind === "incoming_message" ? draft.triggerChatIds : "",
  };
}

/** Drop form values that do not belong to the selected action type. */
function withActionType(draft: Draft, type: ActionType): Draft {
  return {
    ...draft,
    actionType: type,
    prompt: type === "agent" ? draft.prompt : "",
    text: type === "send_message" ? draft.text : "",
    actionSkillSlugs: type === "agent" ? draft.actionSkillSlugs : "",
    sendOutput: type === "agent" ? draft.sendOutput : false,
  };
}

function chatIdOf(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function threadIdOf(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
  const runsRequest = useRef(0);

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
      const request = ++runsRequest.current;
      if (next) {
        const runList = await getAutomationRuns(next.id);
        if (runsRequest.current === request) setRuns(runList.runs);
      } else {
        setRuns([]);
      }
    } catch (loadError) {
      setError(aiErrorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (automation: AutomationView) => {
    setDraft(draftOf(automation));
    setSaved(null);
    setError(null);
    const request = ++runsRequest.current;
    try {
      const runList = await getAutomationRuns(automation.id);
      if (runsRequest.current === request) setRuns(runList.runs);
    } catch (loadError) {
      if (runsRequest.current === request) {
        setError(aiErrorMessage(loadError));
      }
    }
  };

  const validate = (): string | null => {
    if (!draft.name.trim()) return "Нужно название автоматизации";
    if (draft.triggerKind === "every") {
      const minutes = Number(draft.minutes);
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080) {
        return "Интервал — целое число минут от 1 до 10080";
      }
    }
    if (draft.triggerKind === "daily") {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(draft.at.trim())) {
        return "Время должно быть в формате HH:MM, например 09:00";
      }
      if (!draft.timezone.trim()) {
        return "Для ежедневного расписания нужен часовой пояс (IANA)";
      }
    }
    if (draft.timezone.trim() && !isValidTimeZone(draft.timezone.trim())) {
      return "Неизвестный часовой пояс. Укажите IANA, например Europe/Moscow";
    }
    if (draft.scopeChatId.trim() && chatIdOf(draft.scopeChatId) === null) {
      return "Chat id области — целое число или пусто";
    }
    if (draft.scopeChatId.trim() && !draft.accountId) {
      return "Чтобы привязать автоматизацию к чату, выберите аккаунт";
    }
    if (draft.scopeThreadId.trim()) {
      if (!draft.scopeChatId.trim()) {
        return "Thread id задаётся только вместе с chat id";
      }
      if (threadIdOf(draft.scopeThreadId) === null) {
        return "Thread id — неотрицательное целое число";
      }
    }
    if (draft.chatId.trim() && chatIdOf(draft.chatId) === null) {
      return "Chat id — целое число или пусто";
    }
    if (draft.actionType === "agent" && !draft.prompt.trim()) {
      return "Опишите промпт, который получит агент";
    }
    if (draft.actionType === "send_message") {
      if (!draft.accountId) return "Для отправки сообщения выберите аккаунт";
      if (chatIdOf(draft.chatId) === null) {
        return "Для отправки сообщения нужен chat id";
      }
      if (!draft.text.trim()) return "Введите текст сообщения";
    }
    if (draft.actionType === "summarize") {
      if (!draft.accountId) return "Для сжатия памяти выберите аккаунт";
      if (chatIdOf(draft.chatId) === null) {
        return "Для сжатия памяти нужен chat id диалога";
      }
    }
    return null;
  };

  const build = (): Record<string, unknown> => {
    const trigger: Record<string, unknown> = { kind: draft.triggerKind };
    if (draft.triggerKind === "every") {
      trigger.minutes = Number(draft.minutes);
    }
    if (draft.triggerKind === "daily") trigger.at = draft.at.trim();
    if (draft.triggerKind === "incoming_message") {
      trigger.keywords = draft.keywords
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      trigger.chatIds = parseIds(draft.triggerChatIds);
    }
    const action: Record<string, unknown> = { type: draft.actionType };
    if (draft.actionType === "agent") {
      action.prompt = draft.prompt.trim();
      const chatId = chatIdOf(draft.chatId);
      if (chatId !== null) action.chatId = chatId;
      action.sendOutput = draft.sendOutput;
      action.skillSlugs = draft.actionSkillSlugs
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (draft.actionType === "send_message") {
      action.chatId = chatIdOf(draft.chatId);
      action.text = draft.text.trim();
    } else {
      action.chatId = chatIdOf(draft.chatId);
    }
    return {
      accountId: draft.accountId || null,
      chatId: chatIdOf(draft.scopeChatId),
      threadId: threadIdOf(draft.scopeThreadId) ?? 0,
      timezone: draft.timezone.trim() || null,
      createdBy: draft.createdBy,
      name: draft.name.trim(),
      description: draft.description.trim(),
      enabled: draft.enabled,
      trigger,
      action,
    };
  };

  const save = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
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
      await load(next.id);
      setSaved(`Автоматизация «${next.name}» сохранена`);
    } catch (saveError) {
      setError(aiErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!draft.id) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await runAutomation(draft.id);
      await load(draft.id);
      setSaved(
        result.status === "ok"
          ? `Выполнено: ${result.output ?? "готово"}`
          : `Ошибка: ${result.error ?? result.status}`,
      );
    } catch (runError) {
      setError(aiErrorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  const resumeRow = async (automation: AutomationView) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await resumeAutomation(automation.id);
      await load(automation.id);
      setSaved(`Автоматизация «${automation.name}» возобновлена`);
    } catch (resumeError) {
      setError(aiErrorMessage(resumeError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id) return;
    if (!window.confirm(`Удалить «${draft.name}»?`)) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await deleteAutomation(draft.id);
      await load();
      setSaved("Автоматизация удалена");
    } catch (removeError) {
      setError(aiErrorMessage(removeError));
    } finally {
      setBusy(false);
    }
  };

  const selected = draft.id
    ? (automations.find((item) => item.id === draft.id) ?? null)
    : null;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card
        title="Автоматизации"
        description="Триггеры и действия"
        actions={
          <GhostButton
            onClick={() => {
              runsRequest.current += 1;
              setDraft(draftOf(null));
              setRuns([]);
              setSaved(null);
              setError(null);
            }}
          >
            + Новая
          </GhostButton>
        }
      >
        <div className="space-y-1">
          {automations.map((automation) => (
            <div
              key={automation.id}
              className={`flex items-start gap-1 rounded-md ${
                draft.id === automation.id ? "bg-sky-500/10" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => void select(automation)}
                className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-2 text-left text-sm ${
                  draft.id === automation.id
                    ? "text-sky-200"
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
                <span className="flex flex-wrap items-center gap-1">
                  <span className="truncate text-[11px] text-zinc-500">
                    {triggerSummary(automation)}
                  </span>
                  {automation.createdBy === "soul" && (
                    <Pill tone="sky">создано душой</Pill>
                  )}
                  {automation.selfPaused && (
                    <Pill tone="amber">на паузе душой</Pill>
                  )}
                </span>
                {automation.selfPaused && automation.selfPauseReason && (
                  <span
                    className="truncate text-[10px] text-amber-200/80"
                    title={automation.selfPauseReason}
                  >
                    {automation.selfPauseReason}
                  </span>
                )}
              </button>
              {automation.selfPaused && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resumeRow(automation)}
                  title="Снять паузу души"
                  className="mt-1 shrink-0 rounded border border-amber-800/70 px-1.5 py-1 text-[10px] text-amber-200 transition-colors hover:bg-amber-950/40 disabled:opacity-40"
                >
                  Возобновить
                </button>
              )}
            </div>
          ))}
          {automations.length === 0 && (
            <p className="text-xs text-zinc-500">Пока нет автоматизаций.</p>
          )}
        </div>
      </Card>

      <div className="min-w-0 space-y-4">
        <ErrorBanner message={error} />
        <OkBanner message={saved} />

        <Card
          title={draft.id ? "Редактирование" : "Новая автоматизация"}
          description="По умолчанию автоматизация выключена и не пишет никому."
          actions={
            <div className="flex flex-wrap gap-2">
              {selected?.selfPaused && (
                <GhostButton
                  onClick={() => void resumeRow(selected)}
                  disabled={busy}
                >
                  Возобновить
                </GhostButton>
              )}
              {draft.id && (
                <GhostButton onClick={() => void runNow()} disabled={busy}>
                  Запустить
                </GhostButton>
              )}
              {draft.id && (
                <GhostButton
                  onClick={() => void remove()}
                  disabled={busy}
                  danger
                >
                  Удалить
                </GhostButton>
              )}
              <PrimaryButton onClick={() => void save()} disabled={busy}>
                {busy ? "Сохранение…" : "Сохранить"}
              </PrimaryButton>
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
                autoComplete="off"
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
            <Field
              label="Часовой пояс (IANA)"
              hint="Обязателен для ежедневного расписания, например Europe/Moscow"
            >
              <input
                value={draft.timezone}
                onChange={(event) =>
                  setDraft({ ...draft, timezone: event.target.value })
                }
                className={inputClass}
                placeholder="Europe/Moscow"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Чат автоматизации (id)"
              hint="Необязательно: привязать правило к конкретному чату"
            >
              <input
                value={draft.scopeChatId}
                onChange={(event) =>
                  setDraft({ ...draft, scopeChatId: event.target.value })
                }
                className={inputClass}
                inputMode="numeric"
                placeholder="например -1001878340462"
                autoComplete="off"
              />
            </Field>
            <Field
              label="Thread id"
              hint="Только с chat id: форум-тема или тред комментариев"
            >
              <input
                value={draft.scopeThreadId}
                onChange={(event) =>
                  setDraft({ ...draft, scopeThreadId: event.target.value })
                }
                className={inputClass}
                inputMode="numeric"
                placeholder="0 = весь чат"
                autoComplete="off"
              />
            </Field>
            <Field label="Описание" className="sm:col-span-2">
              <input
                value={draft.description}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
                className={inputClass}
                autoComplete="off"
              />
            </Field>
          </div>

          {selected &&
            (selected.createdBy === "soul" || selected.selfPaused) && (
              <div
                className={`mt-3 rounded-md border px-3 py-2 text-xs ${
                  selected.selfPaused
                    ? "border-amber-800/70 bg-amber-950/20 text-amber-200"
                    : "border-sky-800/60 bg-sky-950/20 text-sky-200"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span>{createdByLabel(selected.createdBy)}</span>
                  {selected.selfPaused && (
                    <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px]">
                      на паузе душой
                    </span>
                  )}
                  {selected.selfPauseReason && (
                    <span className="min-w-0 flex-1 truncate opacity-80">
                      {selected.selfPauseReason}
                    </span>
                  )}
                </div>
              </div>
            )}

          <label className="mt-3 flex items-start gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
              className="mt-0.5 h-3.5 w-3.5 accent-sky-500"
              autoComplete="off"
            />
            <span>
              <span className="block">Включена</span>
              <span className="block text-[11px] text-zinc-500">
                Новая автоматизация по умолчанию выключена. Отправка уважает
                dryRun из настроек ИИ.
              </span>
            </span>
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
                  aria-pressed={draft.triggerKind === kind}
                  onClick={() =>
                    setDraft((previous) => withTriggerKind(previous, kind))
                  }
                  className={`rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
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
                    autoComplete="off"
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
                    autoComplete="off"
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
                      autoComplete="off"
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
                      autoComplete="off"
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
                  aria-pressed={draft.actionType === type}
                  onClick={() =>
                    setDraft((previous) => withActionType(previous, type))
                  }
                  className={`rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
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
                <>
                  <Field label="Промпт агенту" className="sm:col-span-2">
                    <textarea
                      value={draft.prompt}
                      onChange={(event) =>
                        setDraft({ ...draft, prompt: event.target.value })
                      }
                      className={textareaClass}
                      placeholder="Проверь новые сообщения и составь короткую сводку."
                      autoComplete="off"
                    />
                  </Field>
                  <Field
                    label="Скиллы действия (slug через запятую)"
                    hint="Необязательно: ограничить агента конкретными скиллами"
                    className="sm:col-span-2"
                  >
                    <input
                      value={draft.actionSkillSlugs}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          actionSkillSlugs: event.target.value,
                        })
                      }
                      className={inputClass}
                      placeholder="telegram-assistant, dm-assistant"
                      autoComplete="off"
                    />
                  </Field>
                </>
              )}
              {draft.actionType === "send_message" && (
                <Field label="Текст" className="sm:col-span-2">
                  <textarea
                    value={draft.text}
                    onChange={(event) =>
                      setDraft({ ...draft, text: event.target.value })
                    }
                    className={textareaClass}
                    autoComplete="off"
                  />
                </Field>
              )}
              <Field
                label="Chat id действия"
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
                  autoComplete="off"
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
                    className="h-3.5 w-3.5 accent-sky-500"
                    autoComplete="off"
                  />
                  <span>
                    Отправить ответ агента в чат (нужен chat id)
                    <span className="block text-[11px] text-zinc-500">
                      При dryRun ответ сохраняется в истории, но в Telegram не
                      уходит.
                    </span>
                  </span>
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
                  className="min-w-0 rounded-md border border-zinc-800 px-2 py-1.5 text-[11px]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-zinc-400">
                      {new Date(run.startedAt).toLocaleString("ru-RU")}
                    </span>
                    <Pill tone={run.status === "ok" ? "green" : "red"}>
                      {run.status}
                    </Pill>
                  </div>
                  <p className="mt-1 break-words text-zinc-300">
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
