"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  aiErrorMessage,
  type SkillView,
  type SoulSettings,
  type SoulView,
  saveSoul,
} from "../../lib/ai-api";
import {
  Card,
  ErrorBanner,
  GhostButton,
  inputClass,
  OkBanner,
  PrimaryButton,
  Toggle,
} from "./ai-ui";

/**
 * Default soul of an account that has none yet. Mirrors DEFAULT_SOUL_SETTINGS
 * in apps/api so the first save does not silently change values the user saw.
 */
export const DEFAULT_SOUL_SETTINGS: SoulSettings = {
  allowAllChats: false,
  chatIds: [],
  excludeChatIds: [],
  replyDelayMs: 1200,
  maxPerHour: 12,
  maxPerChatPerDay: 40,
  typing: true,
  typingSpeed: 300,
  peerProfile: true,
  presenceIdleMinutes: 5,
  presenceReadDelaySeconds: 0,
  presenceOnlineDelaySeconds: 5,
  presenceTypingDelaySeconds: 3,
};

export function defaultSoul(accountId: string, name: string): SoulView {
  return {
    id: "",
    accountId,
    name,
    essence: "",
    tone: "",
    goals: "",
    boundaries: "",
    language: "ru",
    systemPrompt: null,
    mode: "off",
    settings: { ...DEFAULT_SOUL_SETTINGS },
    model: null,
    temperature: 0.7,
    skills: [],
    createdAt: "",
    updatedAt: "",
  };
}

type SoulMode = SoulView["mode"];

interface SoulFormState {
  name: string;
  language: string;
  model: string;
  essence: string;
  tone: string;
  goals: string;
  boundaries: string;
  systemPrompt: string;
  mode: SoulMode;
  temperature: string;
  allowAllChats: boolean;
  typing: boolean;
  peerProfile: boolean;
  chatIds: string;
  excludeChatIds: string;
  replyDelayMs: string;
  maxPerHour: string;
  maxPerChatPerDay: string;
  typingSpeed: string;
  presenceIdleMinutes: string;
  presenceReadDelaySeconds: string;
  presenceOnlineDelaySeconds: string;
  presenceTypingDelaySeconds: string;
  skillSlugs: string[];
}

type NumberKey =
  | "temperature"
  | "replyDelayMs"
  | "maxPerHour"
  | "maxPerChatPerDay"
  | "typingSpeed"
  | "presenceIdleMinutes"
  | "presenceReadDelaySeconds"
  | "presenceOnlineDelaySeconds"
  | "presenceTypingDelaySeconds";

interface NumberSpec {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step?: number;
  integer: boolean;
}

const NUMBER_SPECS: Record<NumberKey, NumberSpec> = {
  presenceIdleMinutes: {
    label: "Уходить в оффлайн через, мин",
    hint: "0 — не уходить в оффлайн",
    min: 0,
    max: 180,
    integer: true,
  },
  presenceOnlineDelaySeconds: {
    label: "Выходить в онлайн через, сек",
    hint: "Пауза перед появлением онлайн после сообщения в оффлайне",
    min: 0,
    max: 600,
    integer: true,
  },
  presenceReadDelaySeconds: {
    label: "Читать после возврата, сек",
    hint: "0 — читать сразу после выхода в онлайн",
    min: 0,
    max: 300,
    integer: true,
  },
  presenceTypingDelaySeconds: {
    label: "Начинать печатать через, сек",
    hint: "Пауза между прочтением и «печатает…»",
    min: 0,
    max: 120,
    integer: true,
  },
  replyDelayMs: {
    label: "Пауза перед ответом, мс",
    hint: "0–120000",
    min: 0,
    max: 120_000,
    step: 100,
    integer: true,
  },
  typingSpeed: {
    label: "Скорость печати, симв/мин",
    hint: "40–600; 600 — предел человеческой скорости",
    min: 40,
    max: 600,
    step: 10,
    integer: true,
  },
  maxPerHour: {
    label: "Сообщений в час",
    hint: "0–500; 0 — без лимита",
    min: 0,
    max: 500,
    integer: true,
  },
  maxPerChatPerDay: {
    label: "Сообщений в день на чат",
    hint: "0–5000; 0 — без лимита",
    min: 0,
    max: 5000,
    integer: true,
  },
  temperature: {
    label: "Температура",
    hint: "0–2; ниже — предсказуемее",
    min: 0,
    max: 2,
    step: 0.1,
    integer: false,
  },
};

const FIELD_LABELS: Record<keyof SoulFormState, string> = {
  name: "Имя",
  language: "Язык",
  model: "Модель",
  essence: "Кто это по сути",
  tone: "Тон и стиль",
  goals: "Цели",
  boundaries: "Границы",
  systemPrompt: "Инструкции",
  mode: "Режим",
  temperature: "Температура",
  allowAllChats: "Все чаты",
  typing: "«печатает…»",
  peerProfile: "Профиль собеседника",
  chatIds: "Разрешённые чаты",
  excludeChatIds: "Исключения",
  replyDelayMs: "Пауза ответа",
  maxPerHour: "Лимит в час",
  maxPerChatPerDay: "Лимит в день",
  typingSpeed: "Скорость печати",
  presenceIdleMinutes: "Оффлайн",
  presenceReadDelaySeconds: "Задержка чтения",
  presenceOnlineDelaySeconds: "Задержка онлайна",
  presenceTypingDelaySeconds: "Задержка печати",
  skillSlugs: "Скиллы",
};

function formOf(soul: SoulView): SoulFormState {
  return {
    name: soul.name,
    language: soul.language,
    model: soul.model ?? "",
    essence: soul.essence,
    tone: soul.tone,
    goals: soul.goals,
    boundaries: soul.boundaries,
    systemPrompt: soul.systemPrompt ?? "",
    mode: soul.mode,
    // Prisma stores Float 0.7 as 0.699999988079071; show two decimals.
    temperature: String(Number(soul.temperature.toFixed(2))),
    allowAllChats: soul.settings.allowAllChats,
    typing: soul.settings.typing,
    peerProfile: soul.settings.peerProfile,
    chatIds: soul.settings.chatIds.join(", "),
    excludeChatIds: soul.settings.excludeChatIds.join(", "),
    replyDelayMs: String(soul.settings.replyDelayMs),
    maxPerHour: String(soul.settings.maxPerHour),
    maxPerChatPerDay: String(soul.settings.maxPerChatPerDay),
    typingSpeed: String(soul.settings.typingSpeed),
    presenceIdleMinutes: String(soul.settings.presenceIdleMinutes),
    presenceReadDelaySeconds: String(soul.settings.presenceReadDelaySeconds),
    presenceOnlineDelaySeconds: String(
      soul.settings.presenceOnlineDelaySeconds,
    ),
    presenceTypingDelaySeconds: String(
      soul.settings.presenceTypingDelaySeconds,
    ),
    skillSlugs: soul.skills.map((skill) => skill.slug),
  };
}

/** Long ids and empty tokens are rejected instead of silently dropped. */
export function parseIdList(raw: string): {
  ids: number[];
  invalid: string[];
} {
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (!/^-?\d+$/.test(token)) {
      invalid.push(token);
      continue;
    }
    const id = Number(token);
    if (!Number.isSafeInteger(id) || id === 0) {
      invalid.push(token);
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid };
}

function parseNumber(key: NumberKey, raw: string): number | null {
  const spec = NUMBER_SPECS[key];
  const value = Number(raw.trim().replace(",", "."));
  if (!Number.isFinite(value)) return null;
  if (spec.integer && !Number.isInteger(value)) return null;
  if (value < spec.min || value > spec.max) return null;
  return value;
}

function sameField(
  key: keyof SoulFormState,
  a: SoulFormState,
  b: SoulFormState,
): boolean {
  if (key === "skillSlugs") {
    return (
      [...a.skillSlugs].sort().join("|") === [...b.skillSlugs].sort().join("|")
    );
  }
  return a[key] === b[key];
}

function changedLabels(
  current: SoulFormState,
  initial: SoulFormState,
): string[] {
  return (Object.keys(FIELD_LABELS) as Array<keyof SoulFormState>)
    .filter((key) => !sameField(key, current, initial))
    .map((key) => FIELD_LABELS[key]);
}

function Labeled({
  label,
  hint,
  error,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: children is always one control
    <label className={`block min-w-0 text-xs text-zinc-400 ${className}`}>
      <span className="block">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11px] text-red-300">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>
      ) : null}
    </label>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {title}
      </h3>
      {description && (
        <p className="mt-0.5 text-[11px] text-zinc-500">{description}</p>
      )}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export interface SoulSettingsFormProps {
  soul: SoulView;
  skills: SkillView[];
  title?: string;
  description?: string;
  /** Called after a successful save with the payload the server returned. */
  onSaved?: (saved: SoulView, changed: string[]) => void;
  /** Shown next to the save button, e.g. a close action in a dialog. */
  extraActions?: ReactNode;
}

/**
 * The single soul/persona editor: accounts page dialog and the /ai souls tab
 * both render this component, so field order and validation stay identical.
 */
export function SoulSettingsForm({
  soul,
  skills,
  title = "Душа",
  description = "Персона, которую ИИ использует в переписке и при работе с аккаунтом.",
  onSaved,
  extraActions,
}: SoulSettingsFormProps) {
  const [form, setForm] = useState<SoulFormState>(() => formOf(soul));
  const [initial, setInitial] = useState<SoulFormState>(() => formOf(soul));
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // The parent may hand us a freshly loaded or server-saved soul.
  useEffect(() => {
    const next = formOf(soul);
    setForm(next);
    setInitial(next);
  }, [soul]);

  const update = (patch: Partial<SoulFormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setStatus(null);
  };

  const updateNumber = (key: NumberKey, value: string) => {
    update({ [key]: value } as Partial<SoulFormState>);
  };

  const chatIds = useMemo(() => parseIdList(form.chatIds), [form.chatIds]);
  const excludeChatIds = useMemo(
    () => parseIdList(form.excludeChatIds),
    [form.excludeChatIds],
  );

  const errors = useMemo(() => {
    const result: Partial<Record<keyof SoulFormState, string>> = {};
    if (!form.name.trim()) result.name = "Укажите имя души";
    if (chatIds.invalid.length > 0) {
      result.chatIds = `Не id: ${chatIds.invalid.slice(0, 4).join(", ")}`;
    }
    if (excludeChatIds.invalid.length > 0) {
      result.excludeChatIds = `Не id: ${excludeChatIds.invalid
        .slice(0, 4)
        .join(", ")}`;
    }
    for (const key of Object.keys(NUMBER_SPECS) as NumberKey[]) {
      const spec = NUMBER_SPECS[key];
      const raw = form[key];
      if (!raw.trim()) {
        result[key] = "Укажите число";
        continue;
      }
      if (parseNumber(key, raw) === null) {
        result[key] = `От ${spec.min} до ${spec.max}`;
      }
    }
    return result;
  }, [form, chatIds, excludeChatIds]);

  const changed = useMemo(() => changedLabels(form, initial), [form, initial]);
  const hasErrors = Object.keys(errors).length > 0;

  const toggleSkill = (slug: string) => {
    update({
      skillSlugs: form.skillSlugs.includes(slug)
        ? form.skillSlugs.filter((item) => item !== slug)
        : [...form.skillSlugs, slug],
    });
  };

  const chooseMode = (mode: SoulMode) => {
    if (mode === form.mode) return;
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

  const reset = () => {
    setForm(initial);
    setShowErrors(false);
    setError(null);
    setStatus("Изменения отменены");
  };

  const save = async () => {
    if (saving) return;
    setShowErrors(true);
    setError(null);
    setStatus(null);
    if (hasErrors) {
      setError("Проверьте поля, отмеченные красным.");
      return;
    }
    const number = (key: NumberKey) => parseNumber(key, form[key]) ?? 0;
    const changedNow = changedLabels(form, initial);
    setSaving(true);
    try {
      const saved = await saveSoul(soul.accountId, {
        name: form.name.trim(),
        essence: form.essence,
        tone: form.tone,
        goals: form.goals,
        boundaries: form.boundaries,
        language: form.language.trim() || "ru",
        systemPrompt: form.systemPrompt.trim() || null,
        mode: form.mode,
        model: form.model.trim() || null,
        temperature: number("temperature"),
        settings: {
          allowAllChats: form.allowAllChats,
          typing: form.typing,
          peerProfile: form.peerProfile,
          chatIds: chatIds.ids,
          excludeChatIds: excludeChatIds.ids,
          replyDelayMs: number("replyDelayMs"),
          maxPerHour: number("maxPerHour"),
          maxPerChatPerDay: number("maxPerChatPerDay"),
          typingSpeed: number("typingSpeed"),
          presenceIdleMinutes: number("presenceIdleMinutes"),
          presenceReadDelaySeconds: number("presenceReadDelaySeconds"),
          presenceOnlineDelaySeconds: number("presenceOnlineDelaySeconds"),
          presenceTypingDelaySeconds: number("presenceTypingDelaySeconds"),
        },
        skillSlugs: form.skillSlugs,
      });
      setForm(formOf(saved));
      setInitial(formOf(saved));
      setStatus(
        changedNow.length > 0
          ? `Сохранено: ${changedNow.join(", ")}`
          : "Сохранено",
      );
      onSaved?.(saved, changedNow);
    } catch (saveError) {
      // Edits stay in the form, so the user can retry without losing them.
      setError(aiErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const visibleError = (key: keyof SoulFormState) =>
    showErrors || form[key] !== initial[key] ? errors[key] : undefined;

  const renderNumber = (key: NumberKey, className = "") => {
    const spec = NUMBER_SPECS[key];
    return (
      <Labeled
        label={spec.label}
        hint={spec.hint}
        error={visibleError(key)}
        className={className}
      >
        <input
          type="number"
          inputMode={spec.integer ? "numeric" : "decimal"}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          autoComplete="off"
          value={form[key]}
          aria-invalid={Boolean(visibleError(key))}
          onChange={(event) => updateNumber(key, event.target.value)}
          className={`${inputClass} ${
            visibleError(key) ? "border-red-700 focus:border-red-500" : ""
          }`}
        />
      </Labeled>
    );
  };

  const saveButtons = (
    <>
      <GhostButton onClick={reset} disabled={saving || changed.length === 0}>
        Сбросить
      </GhostButton>
      <PrimaryButton onClick={() => void save()} disabled={saving}>
        {saving ? "Сохранение…" : "Сохранить"}
      </PrimaryButton>
    </>
  );

  return (
    <Card
      title={title}
      description={description}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {extraActions}
          {saveButtons}
        </div>
      }
    >
      <div className="min-w-0 space-y-3">
        {error && <ErrorBanner message={error} />}
        {status && <OkBanner message={status} />}
        {changed.length > 0 && (
          <p
            aria-live="polite"
            className="break-words rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200"
          >
            <span className="font-medium">Не сохранено:</span>{" "}
            {changed.join(", ")}
          </p>
        )}

        <Section title="Персона">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Имя души" error={visibleError("name")}>
              <input
                autoComplete="off"
                value={form.name}
                aria-invalid={Boolean(visibleError("name"))}
                onChange={(event) => update({ name: event.target.value })}
                className={`${inputClass} ${
                  visibleError("name")
                    ? "border-red-700 focus:border-red-500"
                    : ""
                }`}
              />
            </Labeled>
            <Labeled label="Язык" hint="Например ru или en">
              <input
                autoComplete="off"
                spellCheck={false}
                value={form.language}
                onChange={(event) => update({ language: event.target.value })}
                className={inputClass}
              />
            </Labeled>
            <Labeled
              label="Модель души"
              hint="Пусто = модель из настроек ИИ"
              className="sm:col-span-2"
            >
              <input
                autoComplete="off"
                spellCheck={false}
                value={form.model}
                onChange={(event) => update({ model: event.target.value })}
                className={inputClass}
                placeholder="например deepseek-chat"
              />
            </Labeled>
            <Labeled
              label="Кто это по сути"
              hint="2–4 предложения: характер, ценности, роль"
              className="sm:col-span-2"
            >
              <textarea
                autoComplete="off"
                value={form.essence}
                onChange={(event) => update({ essence: event.target.value })}
                className={`${inputClass} min-h-[74px] resize-y`}
              />
            </Labeled>
            <Labeled label="Тон и стиль" className="sm:col-span-2">
              <textarea
                autoComplete="off"
                value={form.tone}
                onChange={(event) => update({ tone: event.target.value })}
                className={`${inputClass} min-h-[74px] resize-y`}
              />
            </Labeled>
            <Labeled label="Цели в общении" className="sm:col-span-2">
              <textarea
                autoComplete="off"
                value={form.goals}
                onChange={(event) => update({ goals: event.target.value })}
                className={`${inputClass} min-h-[74px] resize-y`}
              />
            </Labeled>
            <Labeled
              label="Границы и запреты"
              hint="Что нельзя: темы, обещания, личные данные"
              className="sm:col-span-2"
            >
              <textarea
                autoComplete="off"
                value={form.boundaries}
                onChange={(event) => update({ boundaries: event.target.value })}
                className={`${inputClass} min-h-[74px] resize-y`}
              />
            </Labeled>
            <Labeled
              label="Дополнительные инструкции"
              hint="Необязательно; добавляются после основной персоны"
              className="sm:col-span-2"
            >
              <textarea
                autoComplete="off"
                value={form.systemPrompt}
                onChange={(event) =>
                  update({ systemPrompt: event.target.value })
                }
                className={`${inputClass} min-h-[74px] resize-y`}
              />
            </Labeled>
          </div>
        </Section>

        <Section
          title="Режим"
          description="Выкл — душа только для ручных запросов; черновик — предлагает ответ; авто — отвечает сама."
        >
          <fieldset>
            <legend className="sr-only">Режим души</legend>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {(
                [
                  ["off", "Выключен", "Используется только вручную"],
                  [
                    "draft",
                    "Черновики",
                    "ИИ предлагает ответ, но не отправляет",
                  ],
                  ["auto", "Автоответ", "Отвечает в разрешённых личных чатах"],
                ] as const
              ).map(([mode, label, hint]) => (
                <label
                  key={mode}
                  className={`flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
                    form.mode === mode
                      ? "border-sky-600 bg-sky-500/10 text-zinc-100"
                      : "border-zinc-800 text-zinc-300"
                  }`}
                >
                  <input
                    type="radio"
                    name={`soul-mode-${soul.accountId}`}
                    checked={form.mode === mode}
                    autoComplete="off"
                    onChange={() => chooseMode(mode)}
                    className="mt-0.5 accent-sky-500"
                  />
                  <span>
                    <span className="block text-zinc-200">{label}</span>
                    <span className="text-[11px] text-zinc-500">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {form.mode === "auto" && (
            <p
              aria-live="polite"
              className="mt-2 rounded-md border border-amber-700/40 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200"
            >
              Автоответ пишет живым людям. Проверьте список чатов и лимиты перед
              сохранением.
            </p>
          )}
        </Section>

        <Section
          title="Присутствие"
          description="Имитация человеческого онлайна: уход в оффлайн, возврат, чтение и «печатает…»."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {renderNumber("presenceIdleMinutes")}
            {renderNumber("presenceOnlineDelaySeconds")}
            {renderNumber("presenceReadDelaySeconds")}
            {renderNumber("presenceTypingDelaySeconds")}
          </div>
        </Section>

        <Section
          title="Чаты"
          description="ID пользователей через запятую или пробел. Отрицательные — группы и каналы."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled
              label="Разрешённые chat id"
              hint="Пусто + «все личные чаты» = любой личный чат"
              error={visibleError("chatIds")}
            >
              <input
                autoComplete="off"
                spellCheck={false}
                inputMode="numeric"
                value={form.chatIds}
                aria-invalid={Boolean(visibleError("chatIds"))}
                onChange={(event) => update({ chatIds: event.target.value })}
                className={`${inputClass} ${
                  visibleError("chatIds")
                    ? "border-red-700 focus:border-red-500"
                    : ""
                }`}
                placeholder="например 123456789, -1001234567890"
              />
            </Labeled>
            <Labeled
              label="Исключения"
              hint="Эти чаты игнорируются, даже если разрешены"
              error={visibleError("excludeChatIds")}
            >
              <input
                autoComplete="off"
                spellCheck={false}
                inputMode="numeric"
                value={form.excludeChatIds}
                aria-invalid={Boolean(visibleError("excludeChatIds"))}
                onChange={(event) =>
                  update({ excludeChatIds: event.target.value })
                }
                className={`${inputClass} ${
                  visibleError("excludeChatIds")
                    ? "border-red-700 focus:border-red-500"
                    : ""
                }`}
              />
            </Labeled>
          </div>
          <div className="mt-3 space-y-2 rounded-md border border-zinc-800 px-2.5 py-2">
            <Toggle
              checked={form.allowAllChats}
              onChange={(value) => update({ allowAllChats: value })}
              label="Отвечать во всех личных чатах"
              hint="Кроме списка исключений"
            />
            <Toggle
              checked={form.typing}
              onChange={(value) => update({ typing: value })}
              label="Показывать «печатает…»"
              hint={`Скорость: ${form.typingSpeed || "—"} симв/мин`}
            />
            <Toggle
              checked={form.peerProfile}
              onChange={(value) => update({ peerProfile: value })}
              label="Передавать профиль собеседника"
              hint="Username и описание из профиля Telegram"
            />
          </div>
        </Section>

        <Section
          title="Лимиты и задержки"
          description="Ограничения защищают аккаунт от флуда и слишком быстрых ответов."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {renderNumber("replyDelayMs")}
            {renderNumber("typingSpeed")}
            {renderNumber("maxPerHour")}
            {renderNumber("maxPerChatPerDay")}
            {renderNumber("temperature")}
          </div>
        </Section>

        <Section
          title="Скиллы по умолчанию"
          description="Набор инструментов и инструкций, который душа получает в каждом диалоге этого аккаунта."
        >
          {skills.length === 0 ? (
            <p className="text-[11px] text-zinc-500">
              Скиллов пока нет — создайте их на вкладке «Скиллы».
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {skills.map((skill) => {
                const active = form.skillSlugs.includes(skill.slug);
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
                      disabled={!skill.enabled || saving}
                      autoComplete="off"
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
          <p className="mt-2 text-[11px] text-zinc-500">
            Выбрано: {form.skillSlugs.length}
          </p>
        </Section>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 pt-3">
          {saveButtons}
        </div>
      </div>
    </Card>
  );
}
