"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addMemoryFact,
  clearMemoryChat,
  deleteMemoryFact,
  getMemory,
  getSoul,
  listSkills,
  listSouls,
  type MemoryView,
  type SkillView,
  type SoulView,
  saveSoul,
  summarizeMemory,
} from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
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
  Toggle,
} from "./ai-ui";
import { useAppData } from "./app-data";

const textareaClass = `${inputClass} min-h-[74px] resize-y`;

function parseIds(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item !== 0);
}

export function SoulsPanel() {
  const { accounts } = useAppData();
  const [souls, setSouls] = useState<SoulView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<SoulView | null>(null);
  const [chatIdsText, setChatIdsText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [memoryChatId, setMemoryChatId] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [factText, setFactText] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [soulList, skillList] = await Promise.all([
        listSouls(),
        listSkills(),
      ]);
      setSouls(soulList.souls);
      setSkills(skillList.skills);
      setSelected((current) => {
        if (current) return current;
        return soulList.souls[0]?.accountId ?? "";
      });
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDraft(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const soul = await getSoul(selected);
        if (cancelled) return;
        setDraft(soul);
        setChatIdsText(soul.settings.chatIds.join(", "));
        setExcludeText(soul.settings.excludeChatIds.join(", "));
        setStatus(null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const loadMemory = useCallback(
    async (accountId: string, chatId: number | null) => {
      setMemoryBusy(true);
      setError(null);
      try {
        setMemory(await getMemory(accountId, chatId));
      } catch (loadError) {
        setError(errorMessage(loadError));
      } finally {
        setMemoryBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!selected) return;
    void loadMemory(selected, null);
  }, [selected, loadMemory]);

  const account = useMemo(
    () => accounts.find((item) => item.id === selected) ?? null,
    [accounts, selected],
  );

  const update = (patch: Partial<SoulView>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
  };

  const updateSettings = (patch: Partial<SoulView["settings"]>) => {
    setDraft((previous) =>
      previous
        ? { ...previous, settings: { ...previous.settings, ...patch } }
        : previous,
    );
  };

  const toggleSkill = (slug: string) => {
    setDraft((previous) => {
      if (!previous) return previous;
      const has = previous.skills.some((skill) => skill.slug === slug);
      return {
        ...previous,
        skills: has
          ? previous.skills.filter((skill) => skill.slug !== slug)
          : [
              ...previous.skills,
              ...skills.filter((skill) => skill.slug === slug),
            ],
      };
    });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveSoul(draft.accountId, {
        name: draft.name,
        essence: draft.essence,
        tone: draft.tone,
        goals: draft.goals,
        boundaries: draft.boundaries,
        language: draft.language,
        systemPrompt: draft.systemPrompt,
        mode: draft.mode,
        model: draft.model,
        temperature: draft.temperature,
        settings: {
          ...draft.settings,
          chatIds: parseIds(chatIdsText),
          excludeChatIds: parseIds(excludeText),
        },
        skillSlugs: draft.skills.map((skill) => skill.slug),
      });
      setDraft(saved);
      setSouls((previous) =>
        previous.map((soul) =>
          soul.accountId === saved.accountId ? saved : soul,
        ),
      );
      setStatus("Душа сохранена");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const showMemory = async () => {
    if (!selected) return;
    const chatId = Number(memoryChatId);
    await loadMemory(
      selected,
      Number.isSafeInteger(chatId) && chatId !== 0 ? chatId : null,
    );
  };

  const compact = async () => {
    if (!selected) return;
    const chatId = Number(memoryChatId);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      setError("Укажите chat id, чтобы сжать память конкретного диалога");
      return;
    }
    setMemoryBusy(true);
    setError(null);
    try {
      const result = await summarizeMemory(selected, chatId);
      setStatus(
        `Память сжата: ${result.turnsUsed} реплик, новых фактов ${result.factsAdded}`,
      );
      await loadMemory(selected, chatId);
    } catch (compactError) {
      setError(errorMessage(compactError));
    } finally {
      setMemoryBusy(false);
    }
  };

  const addFact = async () => {
    if (!selected || !factText.trim()) return;
    const chatId = Number(memoryChatId);
    setMemoryBusy(true);
    setError(null);
    try {
      await addMemoryFact(selected, {
        content: factText.trim(),
        chatId: Number.isSafeInteger(chatId) && chatId !== 0 ? chatId : null,
      });
      setFactText("");
      await showMemory();
    } catch (factError) {
      setError(errorMessage(factError));
    } finally {
      setMemoryBusy(false);
    }
  };

  const removeFact = async (factId: string) => {
    if (!selected) return;
    setMemoryBusy(true);
    try {
      await deleteMemoryFact(selected, factId);
      await showMemory();
    } catch (factError) {
      setError(errorMessage(factError));
    } finally {
      setMemoryBusy(false);
    }
  };

  const clearChat = async () => {
    if (!selected) return;
    const chatId = Number(memoryChatId);
    if (!Number.isSafeInteger(chatId) || chatId === 0) return;
    if (!window.confirm("Удалить всю память этого диалога?")) return;
    setMemoryBusy(true);
    try {
      await clearMemoryChat(selected, chatId);
      await showMemory();
    } catch (clearError) {
      setError(errorMessage(clearError));
    } finally {
      setMemoryBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
      <Card title="Души" description="По одной на аккаунт">
        <div className="space-y-1.5">
          {souls.length === 0 && (
            <p className="text-xs text-zinc-500">
              Добавьте Telegram-аккаунт — душа появится автоматически.
            </p>
          )}
          {souls.map((soul) => {
            const item = accounts.find(
              (candidate) => candidate.id === soul.accountId,
            );
            return (
              <button
                key={soul.accountId}
                type="button"
                onClick={() => setSelected(soul.accountId)}
                className={`flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${
                  selected === soul.accountId
                    ? "border-sky-600 bg-sky-500/10 text-zinc-100"
                    : "border-zinc-800 text-zinc-300 hover:bg-zinc-800/60"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {item ? accountName(item) : soul.accountId}
                  </span>
                  <Pill tone={soul.mode === "auto" ? "green" : "zinc"}>
                    {soul.mode}
                  </Pill>
                </span>
                <span className="truncate text-[11px] text-zinc-500">
                  {soul.name || "без имени"}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {draft ? (
        <div className="grid gap-4">
          <Card
            title={`Душа · ${account ? accountName(account) : draft.accountId}`}
            description="Персона, которую ИИ использует в переписке и при работе с аккаунтом."
            actions={
              <PrimaryButton onClick={save} disabled={busy}>
                Сохранить душу
              </PrimaryButton>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Имя души">
                <input
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="Язык">
                <input
                  value={draft.language}
                  onChange={(event) => update({ language: event.target.value })}
                  className={inputClass}
                />
              </Field>
            </div>

            <div className="mt-3 grid gap-3">
              <Field
                label="Кто это по сути"
                hint="2–4 предложения: характер, ценности, роль"
              >
                <textarea
                  value={draft.essence}
                  onChange={(event) => update({ essence: event.target.value })}
                  className={textareaClass}
                />
              </Field>
              <Field label="Тон и стиль">
                <textarea
                  value={draft.tone}
                  onChange={(event) => update({ tone: event.target.value })}
                  className={textareaClass}
                />
              </Field>
              <Field label="Цели в общении">
                <textarea
                  value={draft.goals}
                  onChange={(event) => update({ goals: event.target.value })}
                  className={textareaClass}
                />
              </Field>
              <Field
                label="Границы и запреты"
                hint="Что нельзя: темы, обещания, личные данные"
              >
                <textarea
                  value={draft.boundaries}
                  onChange={(event) =>
                    update({ boundaries: event.target.value })
                  }
                  className={textareaClass}
                />
              </Field>
              <Field label="Дополнительные инструкции" hint="Необязательно">
                <textarea
                  value={draft.systemPrompt ?? ""}
                  onChange={(event) =>
                    update({ systemPrompt: event.target.value || null })
                  }
                  className={textareaClass}
                />
              </Field>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs text-zinc-400">Режим</p>
                <div className="space-y-1.5 rounded-md border border-zinc-800 p-2">
                  {(
                    [
                      ["off", "Выключен", "Душа используется только вручную"],
                      [
                        "draft",
                        "Черновики",
                        "ИИ предлагает ответ, но не отправляет",
                      ],
                      [
                        "auto",
                        "Автоответ",
                        "Отвечает в разрешённых личных чатах",
                      ],
                    ] as const
                  ).map(([mode, label, hint]) => (
                    <label
                      key={mode}
                      className="flex items-start gap-2 text-xs text-zinc-300"
                    >
                      <input
                        type="radio"
                        name="soul-mode"
                        checked={draft.mode === mode}
                        onChange={() => update({ mode })}
                        className="mt-0.5 accent-sky-500"
                      />
                      <span>
                        <span className="block text-zinc-200">{label}</span>
                        <span className="text-[11px] text-zinc-500">
                          {hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {draft.mode === "auto" && (
                  <p className="mt-2 rounded-md border border-amber-700/40 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200">
                    Автоответ пишет живым людям. Проверьте список чатов и
                    лимиты.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Toggle
                  checked={draft.settings.allowAllChats}
                  onChange={(value) => updateSettings({ allowAllChats: value })}
                  label="Отвечать во всех личных чатах"
                  hint="Кроме списка исключений"
                />
                <Toggle
                  checked={draft.settings.typing}
                  onChange={(value) => updateSettings({ typing: value })}
                  label="Показывать «печатает…»"
                />
                <Field
                  label="Разрешённые chat id"
                  hint="ID пользователей, через запятую"
                >
                  <input
                    value={chatIdsText}
                    onChange={(event) => setChatIdsText(event.target.value)}
                    className={inputClass}
                    placeholder="например 123456789"
                  />
                </Field>
                <Field label="Исключения">
                  <input
                    value={excludeText}
                    onChange={(event) => setExcludeText(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Пауза, мс">
                    <input
                      value={String(draft.settings.replyDelayMs)}
                      onChange={(event) =>
                        updateSettings({
                          replyDelayMs: Number(event.target.value) || 0,
                        })
                      }
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="В час">
                    <input
                      value={String(draft.settings.maxPerHour)}
                      onChange={(event) =>
                        updateSettings({
                          maxPerHour: Number(event.target.value) || 0,
                        })
                      }
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="В день на чат">
                    <input
                      value={String(draft.settings.maxPerChatPerDay)}
                      onChange={(event) =>
                        updateSettings({
                          maxPerChatPerDay: Number(event.target.value) || 0,
                        })
                      }
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Температура">
                    <input
                      value={String(draft.temperature)}
                      onChange={(event) =>
                        update({ temperature: Number(event.target.value) || 0 })
                      }
                      inputMode="decimal"
                      className={inputClass}
                    />
                  </Field>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <p className="mb-1 text-xs text-zinc-400">Скиллы души</p>
              <div className="flex flex-wrap gap-1.5">
                {skills.map((skill) => {
                  const active = draft.skills.some(
                    (item) => item.slug === skill.slug,
                  );
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => toggleSkill(skill.slug)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        active
                          ? "border-sky-600 bg-sky-500/15 text-sky-300"
                          : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                      }`}
                    >
                      {skill.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {status && <OkBanner message={status} />}
              {error && <ErrorBanner message={error} />}
            </div>
          </Card>

          <Card
            title="Память"
            description="Краткосрочная память — последние реплики, долгосрочная — сводка и факты. Сжатие вызывает модель."
            actions={
              <div className="flex gap-2">
                <GhostButton
                  onClick={() => void showMemory()}
                  disabled={memoryBusy}
                >
                  Загрузить
                </GhostButton>
                <GhostButton
                  onClick={() => void compact()}
                  disabled={memoryBusy}
                >
                  Сжать память
                </GhostButton>
              </div>
            }
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field
                label="Chat id диалога"
                hint="Личный чат = id пользователя. Пусто = только факты аккаунта."
              >
                <input
                  value={memoryChatId}
                  onChange={(event) => setMemoryChatId(event.target.value)}
                  inputMode="numeric"
                  className={inputClass}
                  placeholder="например 123456789"
                />
              </Field>
              <div className="flex items-end gap-2">
                <GhostButton
                  onClick={() => void clearChat()}
                  disabled={memoryBusy}
                >
                  Очистить чат
                </GhostButton>
              </div>
            </div>

            {memory && (
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-zinc-400">
                    Долгосрочная сводка
                  </p>
                  <div className="min-h-[80px] whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs text-zinc-300">
                    {memory.summary || "Сводки пока нет"}
                  </div>
                  <p className="mt-2 text-[11px] text-zinc-500">
                    Реплик: {memory.stats.turns} · фактов: {memory.stats.facts}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs text-zinc-400">Факты</p>
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
                    {memory.facts.length === 0 && (
                      <p className="text-[11px] text-zinc-600">Пока пусто</p>
                    )}
                    {memory.facts.map((fact) => (
                      <div
                        key={fact.id}
                        className="flex items-start justify-between gap-2 text-[11px] text-zinc-300"
                      >
                        <span>
                          <Pill tone="zinc">{fact.kind}</Pill> {fact.content}
                        </span>
                        <button
                          type="button"
                          onClick={() => void removeFact(fact.id)}
                          className="shrink-0 text-zinc-600 hover:text-red-400"
                          title="Удалить факт"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={factText}
                      onChange={(event) => setFactText(event.target.value)}
                      className={`${inputClass} mt-0`}
                      placeholder="Добавить факт вручную"
                    />
                    <GhostButton onClick={() => void addFact()}>
                      Добавить
                    </GhostButton>
                  </div>
                </div>
              </div>
            )}

            {memory && memory.turns.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-zinc-400">
                  Краткосрочная память (последние реплики)
                </p>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
                  {memory.turns.map((turn) => (
                    <div key={turn.id} className="text-[11px]">
                      <span
                        className={
                          turn.role === "assistant"
                            ? "text-sky-300"
                            : turn.role === "draft"
                              ? "text-amber-300"
                              : "text-zinc-500"
                        }
                      >
                        {turn.role === "assistant"
                          ? "Я"
                          : turn.role === "draft"
                            ? "Черновик"
                            : "Собеседник"}
                      </span>
                      <span className="ml-2 text-zinc-300">{turn.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      ) : (
        <Card>
          <p className="text-sm text-zinc-500">
            Выберите аккаунт слева, чтобы отредактировать душу.
          </p>
        </Card>
      )}
    </div>
  );
}
