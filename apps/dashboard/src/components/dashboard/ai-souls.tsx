"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addMemoryFact,
  aiErrorMessage,
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

const MODE_LABELS: Record<SoulView["mode"], string> = {
  off: "выкл",
  draft: "черновик",
  auto: "авто",
};

const MODE_TONES: Record<SoulView["mode"], "zinc" | "sky" | "amber"> = {
  off: "zinc",
  draft: "sky",
  auto: "amber",
};

interface NumberDraft {
  replyDelayMs: string;
  maxPerHour: string;
  maxPerChatPerDay: string;
  typingSpeed: string;
  presenceIdleMinutes: string;
  presenceReadDelaySeconds: string;
  temperature: string;
}

const EMPTY_NUMBERS: NumberDraft = {
  replyDelayMs: "",
  maxPerHour: "",
  maxPerChatPerDay: "",
  typingSpeed: "",
  presenceIdleMinutes: "",
  presenceReadDelaySeconds: "",
  temperature: "",
};

function numbersOf(soul: SoulView): NumberDraft {
  return {
    replyDelayMs: String(soul.settings.replyDelayMs),
    maxPerHour: String(soul.settings.maxPerHour),
    maxPerChatPerDay: String(soul.settings.maxPerChatPerDay),
    typingSpeed: String(soul.settings.typingSpeed),
    presenceIdleMinutes: String(soul.settings.presenceIdleMinutes),
    presenceReadDelaySeconds: String(soul.settings.presenceReadDelaySeconds),
    temperature: String(soul.temperature),
  };
}

function parseIds(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item !== 0);
}

function clampNumber(
  value: string,
  fallback: number,
  min: number,
  max: number,
) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampTemperature(value: string, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(2, Math.max(0, number));
}

export function SoulsPanel() {
  const { accounts } = useAppData();
  const [souls, setSouls] = useState<SoulView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<SoulView | null>(null);
  const [soulLoading, setSoulLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [chatIdsText, setChatIdsText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [numbers, setNumbers] = useState<NumberDraft>(EMPTY_NUMBERS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [memoryChatId, setMemoryChatId] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [factText, setFactText] = useState("");
  const memoryRequest = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [soulList, skillList] = await Promise.all([
        listSouls(),
        listSkills(),
      ]);
      setSouls(soulList.souls);
      setSkills(skillList.skills);
      setSelected((current) =>
        current && soulList.souls.some((soul) => soul.accountId === current)
          ? current
          : (soulList.souls[0]?.accountId ?? ""),
      );
    } catch (loadError) {
      setError(aiErrorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applySoul = useCallback((soul: SoulView) => {
    setDraft(soul);
    setChatIdsText(soul.settings.chatIds.join(", "));
    setExcludeText(soul.settings.excludeChatIds.join(", "));
    setNumbers(numbersOf(soul));
  }, []);

  // Switching accounts must never keep the previous account's editor or
  // memory on screen while the new soul is still loading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey retries a failed load
  useEffect(() => {
    memoryRequest.current += 1;
    setDraft(null);
    setChatIdsText("");
    setExcludeText("");
    setNumbers(EMPTY_NUMBERS);
    setStatus(null);
    setError(null);
    setMemory(null);
    setMemoryError(null);
    setMemoryLoading(false);
    setMemoryChatId("");
    setFactText("");
    if (!selected) return;
    let cancelled = false;
    setSoulLoading(true);
    void (async () => {
      try {
        const soul = await getSoul(selected);
        if (cancelled) return;
        applySoul(soul);
      } catch (loadError) {
        if (!cancelled) {
          setError(`Не удалось загрузить душу: ${aiErrorMessage(loadError)}`);
        }
      } finally {
        if (!cancelled) setSoulLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, reloadKey, applySoul]);

  const loadMemory = useCallback(
    async (accountId: string, chatId: number | null) => {
      const request = ++memoryRequest.current;
      setMemoryLoading(true);
      setMemoryError(null);
      try {
        const next = await getMemory(accountId, chatId);
        if (memoryRequest.current === request) setMemory(next);
      } catch (loadError) {
        if (memoryRequest.current === request) {
          setMemory(null);
          setMemoryError(aiErrorMessage(loadError));
        }
      } finally {
        if (memoryRequest.current === request) setMemoryLoading(false);
      }
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey reloads memory after a retry
  useEffect(() => {
    if (!selected) return;
    void loadMemory(selected, null);
  }, [selected, reloadKey, loadMemory]);

  const account = useMemo(
    () => accounts.find((item) => item.id === selected) ?? null,
    [accounts, selected],
  );

  const freshDraft = draft && draft.accountId === selected ? draft : null;
  const parsedMemoryChat = Number(memoryChatId.trim());
  const hasMemoryChat =
    memoryChatId.trim() !== "" &&
    Number.isSafeInteger(parsedMemoryChat) &&
    parsedMemoryChat !== 0;

  const selectAccount = (accountId: string) => {
    if (accountId === selected) return;
    // Hide the previous editor immediately, not one effect tick later.
    setDraft(null);
    setError(null);
    setStatus(null);
    setSoulLoading(true);
    setSelected(accountId);
  };

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

  const updateNumber = (key: keyof NumberDraft, value: string) => {
    setNumbers((previous) => ({ ...previous, [key]: value }));
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

  const chooseMode = (mode: SoulView["mode"]) => {
    if (!draft || mode === draft.mode) return;
    if (
      mode === "auto" &&
      !window.confirm(
        "Включить автоответ? Душа начнёт сама отвечать живым людям в разрешённых чатах.",
      )
    ) {
      return;
    }
    update({ mode });
  };

  const save = async () => {
    if (!freshDraft) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveSoul(freshDraft.accountId, {
        name: freshDraft.name.trim(),
        essence: freshDraft.essence,
        tone: freshDraft.tone,
        goals: freshDraft.goals,
        boundaries: freshDraft.boundaries,
        language: freshDraft.language.trim() || "ru",
        systemPrompt: freshDraft.systemPrompt?.trim() || null,
        mode: freshDraft.mode,
        model: freshDraft.model?.trim() || null,
        temperature: clampTemperature(
          numbers.temperature,
          freshDraft.temperature,
        ),
        settings: {
          allowAllChats: freshDraft.settings.allowAllChats,
          typing: freshDraft.settings.typing,
          peerProfile: freshDraft.settings.peerProfile,
          chatIds: parseIds(chatIdsText),
          excludeChatIds: parseIds(excludeText),
          replyDelayMs: clampNumber(
            numbers.replyDelayMs,
            freshDraft.settings.replyDelayMs,
            0,
            120_000,
          ),
          maxPerHour: clampNumber(
            numbers.maxPerHour,
            freshDraft.settings.maxPerHour,
            0,
            500,
          ),
          maxPerChatPerDay: clampNumber(
            numbers.maxPerChatPerDay,
            freshDraft.settings.maxPerChatPerDay,
            0,
            5000,
          ),
          typingSpeed: clampNumber(
            numbers.typingSpeed,
            freshDraft.settings.typingSpeed,
            40,
            600,
          ),
          presenceIdleMinutes: clampNumber(
            numbers.presenceIdleMinutes,
            freshDraft.settings.presenceIdleMinutes,
            0,
            180,
          ),
          presenceReadDelaySeconds: clampNumber(
            numbers.presenceReadDelaySeconds,
            freshDraft.settings.presenceReadDelaySeconds,
            0,
            300,
          ),
        },
        skillSlugs: freshDraft.skills.map((skill) => skill.slug),
      });
      applySoul(saved);
      await load();
      setStatus("Душа сохранена");
    } catch (saveError) {
      setError(aiErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const showMemory = () => {
    if (!selected || memoryBusy) return;
    void loadMemory(selected, hasMemoryChat ? parsedMemoryChat : null);
  };

  const compact = async () => {
    if (!selected || !hasMemoryChat || memoryBusy) return;
    setMemoryBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await summarizeMemory(selected, parsedMemoryChat);
      await loadMemory(selected, parsedMemoryChat);
      setStatus(
        `Память сжата: ${result.turnsUsed} реплик, новых фактов ${result.factsAdded}`,
      );
    } catch (compactError) {
      setMemoryError(aiErrorMessage(compactError));
    } finally {
      setMemoryBusy(false);
    }
  };

  const addFact = async () => {
    if (!selected || !factText.trim() || memoryBusy) return;
    const targetChat = hasMemoryChat ? parsedMemoryChat : null;
    setMemoryBusy(true);
    setMemoryError(null);
    try {
      await addMemoryFact(selected, {
        content: factText.trim(),
        chatId: targetChat,
      });
      setFactText("");
      await loadMemory(selected, targetChat);
    } catch (factError) {
      setMemoryError(aiErrorMessage(factError));
    } finally {
      setMemoryBusy(false);
    }
  };

  const removeFact = async (factId: string) => {
    if (!selected || memoryBusy) return;
    setMemoryBusy(true);
    setMemoryError(null);
    try {
      await deleteMemoryFact(selected, factId);
      await loadMemory(selected, memory?.chatId ?? null);
    } catch (factError) {
      setMemoryError(aiErrorMessage(factError));
    } finally {
      setMemoryBusy(false);
    }
  };

  const clearChat = async () => {
    if (!selected || !hasMemoryChat || memoryBusy) return;
    if (!window.confirm("Удалить всю память этого диалога?")) return;
    setMemoryBusy(true);
    setMemoryError(null);
    try {
      await clearMemoryChat(selected, parsedMemoryChat);
      await loadMemory(selected, parsedMemoryChat);
    } catch (clearError) {
      setMemoryError(aiErrorMessage(clearError));
    } finally {
      setMemoryBusy(false);
    }
  };

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
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
            const active = selected === soul.accountId;
            return (
              <button
                key={soul.accountId}
                type="button"
                onClick={() => selectAccount(soul.accountId)}
                aria-pressed={active}
                className={`flex w-full min-w-0 flex-col gap-1 rounded-md border px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                  active
                    ? "border-sky-600 bg-sky-500/10 text-zinc-100"
                    : "border-zinc-800 text-zinc-300 hover:bg-zinc-800/60"
                }`}
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate">
                    {item ? accountName(item) : soul.accountId}
                  </span>
                  <Pill tone={MODE_TONES[soul.mode]}>
                    {MODE_LABELS[soul.mode]}
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

      <div className="grid min-w-0 content-start gap-4">
        {error && <ErrorBanner message={error} />}
        {status && <OkBanner message={status} />}

        {!selected ? (
          <Card>
            <p className="text-sm text-zinc-500">
              Добавьте Telegram-аккаунт, чтобы настроить душу.
            </p>
          </Card>
        ) : freshDraft ? (
          <div className="grid min-w-0 gap-4">
            <Card
              title={`Душа · ${account ? accountName(account) : freshDraft.accountId}`}
              description="Персона, которую ИИ использует в переписке и при работе с аккаунтом."
              actions={
                <PrimaryButton onClick={() => void save()} disabled={busy}>
                  {busy ? "Сохранение…" : "Сохранить душу"}
                </PrimaryButton>
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Имя души">
                  <input
                    value={freshDraft.name}
                    onChange={(event) => update({ name: event.target.value })}
                    className={inputClass}
                  />
                </Field>
                <Field label="Язык">
                  <input
                    value={freshDraft.language}
                    onChange={(event) =>
                      update({ language: event.target.value })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field
                  label="Модель души"
                  hint="Пусто = модель из настроек ИИ"
                  className="sm:col-span-2"
                >
                  <input
                    value={freshDraft.model ?? ""}
                    onChange={(event) =>
                      update({ model: event.target.value || null })
                    }
                    className={inputClass}
                    placeholder="например deepseek-chat"
                  />
                </Field>
              </div>

              <div className="mt-3 grid gap-3">
                <Field
                  label="Кто это по сути"
                  hint="2–4 предложения: характер, ценности, роль"
                >
                  <textarea
                    value={freshDraft.essence}
                    onChange={(event) =>
                      update({ essence: event.target.value })
                    }
                    className={textareaClass}
                  />
                </Field>
                <Field label="Тон и стиль">
                  <textarea
                    value={freshDraft.tone}
                    onChange={(event) => update({ tone: event.target.value })}
                    className={textareaClass}
                  />
                </Field>
                <Field label="Цели в общении">
                  <textarea
                    value={freshDraft.goals}
                    onChange={(event) => update({ goals: event.target.value })}
                    className={textareaClass}
                  />
                </Field>
                <Field
                  label="Границы и запреты"
                  hint="Что нельзя: темы, обещания, личные данные"
                >
                  <textarea
                    value={freshDraft.boundaries}
                    onChange={(event) =>
                      update({ boundaries: event.target.value })
                    }
                    className={textareaClass}
                  />
                </Field>
                <Field label="Дополнительные инструкции" hint="Необязательно">
                  <textarea
                    value={freshDraft.systemPrompt ?? ""}
                    onChange={(event) =>
                      update({ systemPrompt: event.target.value || null })
                    }
                    className={textareaClass}
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <fieldset>
                  <legend className="mb-1 text-xs text-zinc-400">Режим</legend>
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
                          checked={freshDraft.mode === mode}
                          onChange={() => chooseMode(mode)}
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
                  {freshDraft.mode === "auto" && (
                    <p
                      aria-live="polite"
                      className="mt-2 rounded-md border border-amber-700/40 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200"
                    >
                      Автоответ пишет живым людям. Проверьте список чатов и
                      лимиты перед сохранением.
                    </p>
                  )}
                </fieldset>

                <div className="space-y-2">
                  <Toggle
                    checked={freshDraft.settings.allowAllChats}
                    onChange={(value) =>
                      updateSettings({ allowAllChats: value })
                    }
                    label="Отвечать во всех личных чатах"
                    hint="Кроме списка исключений"
                  />
                  <Toggle
                    checked={freshDraft.settings.typing}
                    onChange={(value) => updateSettings({ typing: value })}
                    label="Показывать «печатает…»"
                  />
                  <Toggle
                    checked={freshDraft.settings.peerProfile}
                    onChange={(value) => updateSettings({ peerProfile: value })}
                    label="Передавать профиль собеседника"
                    hint="Username и описание из профиля Telegram"
                  />
                  <Field
                    label="Уходить в оффлайн через, мин"
                    hint="0 — не уходить в оффлайн"
                  >
                    <input
                      value={numbers.presenceIdleMinutes}
                      onChange={(event) =>
                        updateNumber("presenceIdleMinutes", event.target.value)
                      }
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                  <Field
                    label="Читать после возврата, сек"
                    hint="Задержка чтения сообщения, пришедшего в оффлайн"
                  >
                    <input
                      value={numbers.presenceReadDelaySeconds}
                      onChange={(event) =>
                        updateNumber(
                          "presenceReadDelaySeconds",
                          event.target.value,
                        )
                      }
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                  <Field
                    label="Разрешённые chat id"
                    hint="ID пользователей через запятую"
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
                        value={numbers.replyDelayMs}
                        onChange={(event) =>
                          updateNumber("replyDelayMs", event.target.value)
                        }
                        inputMode="numeric"
                        className={inputClass}
                      />
                    </Field>
                    <Field
                      label="Скорость печати, симв/мин"
                      hint="40–600; 600 — предел человеческой скорости"
                    >
                      <input
                        value={numbers.typingSpeed}
                        onChange={(event) =>
                          updateNumber("typingSpeed", event.target.value)
                        }
                        inputMode="numeric"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="В час">
                      <input
                        value={numbers.maxPerHour}
                        onChange={(event) =>
                          updateNumber("maxPerHour", event.target.value)
                        }
                        inputMode="numeric"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="В день на чат">
                      <input
                        value={numbers.maxPerChatPerDay}
                        onChange={(event) =>
                          updateNumber("maxPerChatPerDay", event.target.value)
                        }
                        inputMode="numeric"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Температура">
                      <input
                        value={numbers.temperature}
                        onChange={(event) =>
                          updateNumber("temperature", event.target.value)
                        }
                        inputMode="decimal"
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
              </div>

              <fieldset className="mt-4">
                <legend className="mb-1 text-xs text-zinc-400">
                  Скиллы души
                </legend>
                {skills.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">
                    Скиллов пока нет — создайте их на вкладке «Скиллы».
                  </p>
                ) : (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {skills.map((skill) => {
                      const active = freshDraft.skills.some(
                        (item) => item.slug === skill.slug,
                      );
                      return (
                        <label
                          key={skill.id}
                          className={`flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
                            skill.enabled
                              ? active
                                ? "border-sky-700/70 bg-sky-500/10 text-sky-200"
                                : "border-zinc-800 text-zinc-400"
                              : "border-zinc-800 text-zinc-600 opacity-60"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={active}
                            disabled={!skill.enabled}
                            onChange={() => toggleSkill(skill.slug)}
                            className="h-3.5 w-3.5 shrink-0 accent-sky-500"
                          />
                          <span className="truncate">{skill.name}</span>
                          <span className="ml-auto truncate text-[10px] text-zinc-600">
                            {skill.enabled ? skill.slug : "выключен"}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            </Card>

            <Card
              title="Память"
              description="Краткосрочная память — последние реплики, долгосрочная — сводка и факты. Сжатие вызывает модель."
              actions={
                <div className="flex flex-wrap gap-2">
                  <GhostButton
                    onClick={showMemory}
                    disabled={memoryBusy || memoryLoading}
                  >
                    Загрузить
                  </GhostButton>
                  <GhostButton
                    onClick={() => void compact()}
                    disabled={memoryBusy || !hasMemoryChat}
                  >
                    Сжать память
                  </GhostButton>
                </div>
              }
            >
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <Field
                  label="Chat id диалога"
                  hint="Личный чат = id пользователя. Пусто = только факты аккаунта. Сжатие и очистка требуют chat id."
                >
                  <input
                    value={memoryChatId}
                    onChange={(event) => setMemoryChatId(event.target.value)}
                    inputMode="numeric"
                    className={inputClass}
                    placeholder="например 123456789"
                  />
                </Field>
                <div className="flex items-end">
                  <GhostButton
                    onClick={() => void clearChat()}
                    disabled={memoryBusy || !hasMemoryChat}
                  >
                    Очистить чат
                  </GhostButton>
                </div>
              </div>

              {memoryError && (
                <div className="mt-3">
                  <ErrorBanner message={memoryError} />
                </div>
              )}

              {memoryLoading && (
                <p className="mt-3 text-xs text-zinc-500" aria-live="polite">
                  Загрузка памяти…
                </p>
              )}

              {!memoryLoading && !memoryError && !memory && (
                <p className="mt-3 text-xs text-zinc-500">
                  Память этого аккаунта пока не загружена.
                </p>
              )}

              {!memoryLoading && memory && (
                <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
                  <div className="min-w-0">
                    <p className="mb-1 text-xs text-zinc-400">
                      Долгосрочная сводка
                    </p>
                    <div className="min-h-[80px] whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs text-zinc-300">
                      {memory.summary || "Сводки пока нет"}
                    </div>
                    <p className="mt-2 text-[11px] text-zinc-500">
                      Реплик: {memory.stats.turns} · фактов:{" "}
                      {memory.stats.facts}
                      {memory.updatedAt
                        ? ` · обновлено ${new Date(memory.updatedAt).toLocaleString("ru-RU")}`
                        : ""}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1 text-xs text-zinc-400">Факты</p>
                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
                      {memory.facts.length === 0 && (
                        <p className="text-[11px] text-zinc-600">
                          Фактов пока нет
                        </p>
                      )}
                      {memory.facts.map((fact) => (
                        <div
                          key={fact.id}
                          className="flex min-w-0 items-start justify-between gap-2 text-[11px] text-zinc-300"
                        >
                          <span className="min-w-0 break-words">
                            <Pill tone="zinc">{fact.kind}</Pill> {fact.content}
                          </span>
                          <button
                            type="button"
                            onClick={() => void removeFact(fact.id)}
                            disabled={memoryBusy}
                            className="shrink-0 rounded px-1 text-zinc-600 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-40"
                            aria-label={`Удалить факт: ${fact.content}`}
                            title="Удалить факт"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-end gap-2">
                      <Field label="Добавить факт" className="flex-1">
                        <input
                          value={factText}
                          onChange={(event) => setFactText(event.target.value)}
                          className={inputClass}
                          placeholder="Например: живёт в Берлине"
                        />
                      </Field>
                      <GhostButton
                        onClick={() => void addFact()}
                        disabled={memoryBusy || !factText.trim()}
                      >
                        Добавить
                      </GhostButton>
                    </div>
                  </div>
                </div>
              )}

              {!memoryLoading && memory && memory.turns.length > 0 && (
                <div className="mt-3 min-w-0">
                  <p className="mb-1 text-xs text-zinc-400">
                    Краткосрочная память (последние реплики)
                  </p>
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
                    {memory.turns.map((turn) => (
                      <div
                        key={turn.id}
                        className="min-w-0 break-words text-[11px]"
                      >
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
                        <span className="ml-2 text-zinc-300">
                          {turn.content}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!memoryLoading && memory && memory.turns.length === 0 && (
                <p className="mt-3 text-[11px] text-zinc-500">
                  Краткосрочной памяти по этому чату пока нет.
                </p>
              )}
            </Card>
          </div>
        ) : (
          <Card>
            {soulLoading || !error ? (
              <p className="text-sm text-zinc-500" aria-live="polite">
                Загрузка души…
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-red-300">
                  Душу не удалось загрузить.
                </p>
                <GhostButton onClick={() => setReloadKey((key) => key + 1)}>
                  Повторить
                </GhostButton>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
