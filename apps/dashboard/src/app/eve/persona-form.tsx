"use client";

import { type ReactNode, useMemo, useState } from "react";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  PrimaryButton,
  textareaClass,
} from "../../components/dashboard/ai-ui";
import {
  createPersona,
  type EvePersonaInput,
  type EvePersonaView,
  eveErrorMessage,
  updatePersona,
} from "../../lib/eve-api";
import { EVE_STAGES } from "../../lib/eve-stages";
import {
  type CardOption,
  ChoiceCards,
  selectClass,
  SliderField,
  TimezoneCombobox,
} from "./persona-form-controls";

interface Draft {
  name: string;
  age: string;
  nationality: string;
  timezone: string;
  stage: string;
  mode: string;
  sleepFrom: string;
  sleepTo: string;
  nightWakeChance: string;
  ignoreTendency: string;
  communication: string;
  vibe: string;
}

/**
 * Коды из `apps/api/src/eve/eve-persona-gen.service.ts` (`CITIES` /
 * `NATIONALITY_LABEL`) и `eve-persona-llm.ts`. Других значений генератор не
 * понимает: неизвестный код он подставит как есть, без города.
 */
const NATIONALITIES = [
  { code: "RU", label: "Россия" },
  { code: "UA", label: "Украина" },
  { code: "BY", label: "Беларусь" },
  { code: "KZ", label: "Казахстан" },
] as const;

/**
 * `apps/eve/agent/lib/persona/communication.ts` (`DEFAULT_COMMUNICATION` и
 * `normalizeCommunicationProfile`). Порядок и набор значений — как в движке.
 */
interface CommunicationGroup {
  key: "messageStyle" | "notifications" | "initiative" | "lifeSharing";
  legend: string;
  hint: string;
  fallback: string;
  options: readonly CardOption[];
}

const COMMUNICATION_GROUPS: readonly CommunicationGroup[] = [
  {
    key: "messageStyle",
    legend: "Ритм сообщений",
    hint: "Как она разбивает текст на сообщения.",
    fallback: "balanced",
    options: [
      {
        value: "one-liners",
        label: "Однострочники",
        description: "Одна короткая реплика, часто одно слово.",
      },
      {
        value: "balanced",
        label: "Сбалансированно",
        description: "Обычные короткие сообщения на одну-две мысли.",
      },
      {
        value: "bursty",
        label: "Очередями",
        description: "Несколько быстрых пузырей подряд, как будто не останавливается.",
      },
      {
        value: "longform",
        label: "Длинно",
        description: "Реже, но длиннее: абзац, если тема зацепила.",
      },
    ],
  },
  {
    key: "notifications",
    legend: "Уведомления",
    hint: "Насколько быстро она замечает сообщения.",
    fallback: "normal",
    options: [
      {
        value: "muted",
        label: "Беззвучно",
        description: "Заходит в телеграм редко, уведомления почти не видит.",
      },
      {
        value: "normal",
        label: "Обычно",
        description: "Стандартный режим уведомлений.",
      },
      {
        value: "priority",
        label: "В приоритете",
        description: "Его сообщения замечает быстрее остальных.",
      },
    ],
  },
  {
    key: "initiative",
    legend: "Инициатива",
    hint: "Пишет ли она первой.",
    fallback: "medium",
    options: [
      {
        value: "low",
        label: "Низкая",
        description: "Почти не пишет первой, ждёт его шага.",
      },
      {
        value: "medium",
        label: "Средняя",
        description: "Иногда пишет первой, если есть повод.",
      },
      {
        value: "high",
        label: "Высокая",
        description: "Часто пишет первой, легко зовёт созвониться.",
      },
    ],
  },
  {
    key: "lifeSharing",
    legend: "Своя жизнь",
    hint: "Сколько она рассказывает о себе.",
    fallback: "medium",
    options: [
      {
        value: "low",
        label: "Мало",
        description: "О себе рассказывает только если спросят.",
      },
      {
        value: "medium",
        label: "В меру",
        description: "Делится событиями дня без потока.",
      },
      {
        value: "high",
        label: "Много",
        description: "Охотно рассказывает, что происходит, и спрашивает о нём.",
      },
    ],
  },
];

const DEFAULT_COMMUNICATION: Record<string, string> = Object.fromEntries(
  COMMUNICATION_GROUPS.map((group) => [group.key, group.fallback]),
);

const COMMUNICATION_KEYS = new Set<string>(
  COMMUNICATION_GROUPS.map((group) => group.key),
);

interface ParsedCommunication {
  /** Full object, including unknown keys, so they survive card edits. */
  object: Record<string, unknown> | null;
  error: string | null;
  extraKeys: string[];
  badValues: { key: string; value: string }[];
}

function parseCommunication(raw: string): ParsedCommunication {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { object: {}, error: null, extraKeys: [], badValues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      object: null,
      error: "некорректный JSON",
      extraKeys: [],
      badValues: [],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      object: null,
      error: "нужен JSON-объект",
      extraKeys: [],
      badValues: [],
    };
  }
  const object = parsed as Record<string, unknown>;
  const extraKeys = Object.keys(object).filter(
    (key) => !COMMUNICATION_KEYS.has(key),
  );
  const badValues: { key: string; value: string }[] = [];
  for (const group of COMMUNICATION_GROUPS) {
    const value = object[group.key];
    if (
      value !== undefined &&
      !group.options.some((option) => option.value === value)
    ) {
      badValues.push({ key: group.key, value: String(value) });
    }
  }
  return { object, error: null, extraKeys, badValues };
}

function prettyCommunication(raw: string | null | undefined): string {
  const value = raw?.trim() || "{}";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function draftOf(persona: EvePersonaView | null): Draft {
  return {
    name: persona?.name ?? "",
    age: String(persona?.age ?? 22),
    nationality: persona?.nationality ?? "RU",
    timezone: persona?.timezone ?? "Europe/Moscow",
    stage: persona?.stage ?? "tg-given-warming",
    mode: persona?.mode ?? "auto",
    sleepFrom: String(persona?.sleepFrom ?? 23),
    sleepTo: String(persona?.sleepTo ?? 8),
    nightWakeChance: String(persona?.nightWakeChance ?? 0.05),
    ignoreTendency: String(persona?.ignoreTendency ?? 35),
    communication: prettyCommunication(persona?.communication),
    vibe: persona?.vibe ?? "",
  };
}

function parseNumber(
  raw: string,
  label: string,
  options: { min: number; max: number; integer?: boolean },
): number {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${label}: укажите число`);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`${label}: нужно число`);
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${label}: нужно целое число`);
  }
  if (value < options.min || value > options.max) {
    throw new Error(`${label}: допустимо от ${options.min} до ${options.max}`);
  }
  return value;
}

function hourLabel(value: number): string {
  return `${String(Math.round(value)).padStart(2, "0")}:00`;
}

function SelectControl({
  id,
  label,
  hint,
  value,
  onChange,
  options,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs text-zinc-400">
        {label}
      </label>
      <select
        id={id}
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className={selectClass}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {children}
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

export function PersonaForm({
  persona,
  onSaved,
  onNotice,
}: {
  persona: EvePersonaView | null;
  onSaved: (persona: EvePersonaView) => Promise<void> | void;
  onNotice: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(persona));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // `mode` — свободное поле с дефолтом `auto`; «другое» показывает input.
  const [customMode, setCustomMode] = useState(
    () => Boolean(persona) && !!persona?.mode && persona.mode !== "auto",
  );

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const communication = useMemo(
    () => parseCommunication(draft.communication),
    [draft.communication],
  );

  const nationalityOptions = useMemo(() => {
    const current = draft.nationality.trim();
    const options: { value: string; label: string }[] = NATIONALITIES.map(
      (item) => ({
        value: item.code,
        label: `${item.code} — ${item.label}`,
      }),
    );
    if (current && !NATIONALITIES.some((item) => item.code === current)) {
      options.push({
        value: current,
        label: `${current} — нестандартное значение`,
      });
    }
    return options;
  }, [draft.nationality]);

  const stageOptions = useMemo(() => {
    const current = draft.stage.trim();
    const options: { value: string; label: string }[] = EVE_STAGES.map(
      (stage, index) => ({
        value: stage.id,
        label: `${index + 1}. ${stage.label}`,
      }),
    );
    if (current && !EVE_STAGES.some((stage) => stage.id === current)) {
      options.push({
        value: current,
        label: `${current} — нестандартная стадия`,
      });
    }
    return options;
  }, [draft.stage]);

  const updateCommunication = (key: string, value: string) => {
    if (!communication.object) return;
    set(
      "communication",
      JSON.stringify({ ...communication.object, [key]: value }, null, 2),
    );
  };

  const resetCommunication = () => {
    set(
      "communication",
      JSON.stringify(
        { ...communication.object, ...DEFAULT_COMMUNICATION },
        null,
        2,
      ),
    );
  };

  const reset = () => {
    setDraft(draftOf(persona));
    setCustomMode(
      () => Boolean(persona) && !!persona?.mode && persona.mode !== "auto",
    );
    setError(null);
    setSaved(null);
  };

  const save = async () => {
    setError(null);
    setSaved(null);

    let input: EvePersonaInput;
    try {
      const name = draft.name.trim();
      if (!name) throw new Error("Укажите имя персоны");
      const timezone = draft.timezone.trim();
      if (!timezone) throw new Error("Укажите часовой пояс (IANA)");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        throw new Error(`Часовой пояс: неизвестная IANA-зона «${timezone}»`);
      }

      let communication: Record<string, unknown> = {};
      const rawCommunication = draft.communication.trim();
      if (rawCommunication) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawCommunication);
        } catch {
          throw new Error("Communication: некорректный JSON");
        }
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          throw new Error("Communication: нужен JSON-объект");
        }
        communication = parsed as Record<string, unknown>;
      }

      input = {
        name,
        age: parseNumber(draft.age, "Возраст", {
          min: 0,
          max: 120,
          integer: true,
        }),
        nationality: draft.nationality.trim() || "RU",
        timezone,
        stage: draft.stage.trim() || "tg-given-warming",
        mode: draft.mode.trim() || "auto",
        sleepFrom: parseNumber(draft.sleepFrom, "Сон с", {
          min: 0,
          max: 23,
          integer: true,
        }),
        sleepTo: parseNumber(draft.sleepTo, "Сон до", {
          min: 0,
          max: 23,
          integer: true,
        }),
        nightWakeChance: parseNumber(
          draft.nightWakeChance,
          "Шанс ночного пробуждения",
          { min: 0, max: 1 },
        ),
        ignoreTendency: parseNumber(
          draft.ignoreTendency,
          "Склонность игнорить",
          {
            min: 0,
            max: 100,
            integer: true,
          },
        ),
        communication,
        vibe: draft.vibe.trim(),
      };
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "Проверьте поля формы",
      );
      return;
    }

    setBusy(true);
    try {
      const result = persona
        ? await updatePersona(persona.id, input)
        : await createPersona(input);
      setSaved(`Персона «${result.name}» сохранена`);
      onNotice(`Персона «${result.name}» сохранена`);
      await onSaved(result);
    } catch (saveError) {
      setError(eveErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={persona ? `Персона «${persona.name}»` : "Новая персона"}
      description="Характер, расписание и стиль общения. Eve читает эти поля через Nest-контракт."
      actions={
        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={reset} disabled={busy}>
            Сбросить
          </GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={busy}>
            {busy ? "Сохранение…" : "Сохранить"}
          </PrimaryButton>
        </div>
      }
    >
      <ErrorBanner message={error} />
      <OkBanner message={saved} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Имя">
          <input
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            className={inputClass}
            placeholder="Алиса"
            autoComplete="off"
          />
        </Field>
        <Field label="Возраст">
          <input
            type="number"
            min={0}
            max={120}
            step={1}
            value={draft.age}
            onChange={(event) => set("age", event.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </Field>

        <SelectControl
          id="persona-nationality"
          label="Национальность"
          hint="Код страны, который понимает генератор документов."
          value={draft.nationality}
          onChange={(value) => set("nationality", value)}
          options={nationalityOptions}
        />

        <div className="min-w-0">
          <label
            htmlFor="persona-timezone"
            className="block text-xs text-zinc-400"
          >
            Часовой пояс
          </label>
          <TimezoneCombobox
            id="persona-timezone"
            value={draft.timezone}
            onChange={(value) => set("timezone", value)}
            describedBy="persona-timezone-hint"
          />
          <p id="persona-timezone-hint" className="mt-1 text-[11px] text-zinc-500">
            IANA-зона: начните вводить «Moscow», «Almaty» или «UTC».
          </p>
        </div>

        <SelectControl
          id="persona-stage"
          label="Стадия"
          hint="С какой стадии отношений начинается переписка."
          value={draft.stage}
          onChange={(value) => set("stage", value)}
          options={stageOptions}
        />

        <div className="min-w-0">
          <label htmlFor="persona-mode" className="block text-xs text-zinc-400">
            Режим
          </label>
          <select
            id="persona-mode"
            value={customMode ? "__custom__" : "auto"}
            autoComplete="off"
            onChange={(event) => {
              const value = event.target.value;
              if (value === "__custom__") {
                setCustomMode(true);
                if (draft.mode === "auto") set("mode", "");
              } else {
                setCustomMode(false);
                set("mode", value);
              }
            }}
            className={selectClass}
          >
            <option value="auto">auto — автоматически</option>
            <option value="__custom__">Другое значение…</option>
          </select>
          {customMode && (
            <input
              value={draft.mode}
              onChange={(event) => set("mode", event.target.value)}
              className={`${inputClass} font-mono`}
              placeholder="своё значение, например auto"
              aria-label="Своё значение режима"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <p className="mt-1 text-[11px] text-zinc-500">
            Nest хранит строку как есть; сейчас в коде используется только auto.
          </p>
        </div>

        <SliderField
          id="persona-sleep-from"
          label="Сон с"
          hint="Час местного времени, когда засыпает."
          value={draft.sleepFrom}
          onChange={(raw) => set("sleepFrom", raw)}
          min={0}
          max={23}
          step={1}
          format={hourLabel}
        />

        <SliderField
          id="persona-sleep-to"
          label="Сон до"
          hint="Час местного времени, когда просыпается."
          value={draft.sleepTo}
          onChange={(raw) => set("sleepTo", raw)}
          min={0}
          max={23}
          step={1}
          format={hourLabel}
        />

        <SliderField
          id="persona-night-wake"
          label="Шанс ночного пробуждения"
          hint="0–1; например 0.05 = 5%."
          value={draft.nightWakeChance}
          onChange={(raw) => set("nightWakeChance", raw)}
          min={0}
          max={1}
          step={0.01}
          format={(value) => `${Math.round(value * 100)}%`}
        />

        <SliderField
          id="persona-ignore"
          label="Склонность игнорировать"
          hint="0–100."
          value={draft.ignoreTendency}
          onChange={(raw) => set("ignoreTendency", raw)}
          min={0}
          max={100}
          step={1}
          format={(value) => `${Math.round(value)} / 100`}
        />

        <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3 sm:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-zinc-200">Общение</h3>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                Четыре настройки стиля; сохраняются в том же поле{" "}
                <code className="rounded bg-zinc-800 px-1">communication</code>.
              </p>
            </div>
            <GhostButton
              onClick={resetCommunication}
              disabled={busy || !communication.object}
            >
              Сбросить к дефолту
            </GhostButton>
          </div>

          {communication.error && (
            <p
              role="alert"
              className="mt-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300"
            >
              Communication: {communication.error}. Карточки отключены —
              исправьте JSON в разделе «дополнительно».
            </p>
          )}
          {communication.extraKeys.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-400">
              Есть нестандартные поля:{" "}
              <code className="rounded bg-zinc-800 px-1">
                {communication.extraKeys.join(", ")}
              </code>
              . Они сохранятся как есть.
            </p>
          )}
          {communication.badValues.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-400">
              Есть нестандартные значения:{" "}
              {communication.badValues
                .map((item) => `${item.key} = "${item.value}"`)
                .join(", ")}
              . Они сохранятся, пока вы не выберете карточку.
            </p>
          )}

          <div className="mt-3 grid gap-4">
            {COMMUNICATION_GROUPS.map((group) => {
              const rawValue = communication.object?.[group.key];
              return (
                <ChoiceCards
                  key={group.key}
                  name={`persona-communication-${group.key}`}
                  legend={group.legend}
                  hint={group.hint}
                  options={group.options}
                  value={
                    communication.object
                      ? typeof rawValue === "string"
                        ? rawValue
                        : undefined
                      : ""
                  }
                  fallback={group.fallback}
                  onChange={(value) => updateCommunication(group.key, value)}
                  disabled={busy || !communication.object}
                />
              );
            })}
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer select-none text-xs text-zinc-400 hover:text-zinc-300">
              JSON (для отладки)
            </summary>
            <textarea
              value={draft.communication}
              onChange={(event) => set("communication", event.target.value)}
              className={`${textareaClass} mt-1 min-h-40 font-mono text-xs`}
              spellCheck={false}
              autoComplete="off"
              aria-label="Communication JSON"
            />
          </details>
        </div>

        <Field
          label="Вайб"
          hint="Свободное описание атмосферы, которое получает модель."
          className="sm:col-span-2"
        >
          <textarea
            value={draft.vibe}
            onChange={(event) => set("vibe", event.target.value)}
            className={`${textareaClass} min-h-20`}
            autoComplete="off"
          />
        </Field>
      </div>
    </Card>
  );
}
