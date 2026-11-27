"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { inputClass } from "../../components/dashboard/ai-ui";

export const selectClass = `${inputClass} cursor-pointer`;

const comboboxInputClass = `${inputClass} pr-8`;

const numberInputClass =
  "w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none tabular-nums placeholder:text-zinc-600 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

/* -------------------------------------------------------------------------- */
/* Timezone combobox                                                          */
/* -------------------------------------------------------------------------- */

/** Intl → `Europe/Moscow` list. Falls back to a short list when unavailable. */
const FALLBACK_TIMEZONES = [
  "UTC",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Kyiv",
  "Europe/Minsk",
  "Europe/Moscow",
  "Asia/Almaty",
  "Asia/Tbilisi",
  "Asia/Yerevan",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "America/New_York",
  "America/Los_Angeles",
];

let cachedTimezones: string[] | null = null;

function allTimezones(): string[] {
  if (cachedTimezones) return cachedTimezones;
  let zones: string[] = [];
  try {
    const supported = (
      Intl as typeof Intl & {
        supportedValuesOf?: (key: string) => string[];
      }
    ).supportedValuesOf;
    zones = supported?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  cachedTimezones = zones.length > 0 ? zones : FALLBACK_TIMEZONES;
  return cachedTimezones;
}

const offsetCache = new Map<string, string>();

/** `GMT+3`-style label for the zone, cached per zone. */
function timezoneOffset(timeZone: string): string {
  const cached = offsetCache.get(timeZone);
  if (cached) return cached;
  let label = "";
  try {
    const formatter = new Intl.DateTimeFormat("ru-RU", {
      timeZone,
      timeZoneName: "shortOffset",
    });
    label =
      formatter
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    label = "";
  }
  offsetCache.set(timeZone, label);
  return label;
}

export function TimezoneCombobox({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-timezones`;

  const zones = useMemo(() => {
    const base = allTimezones();
    return value && !base.includes(value) ? [value, ...base] : base;
  }, [value]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return zones;
    const starts: string[] = [];
    const rest: string[] = [];
    for (const zone of zones) {
      const lower = zone.toLowerCase();
      if (lower.startsWith(needle)) starts.push(zone);
      else if (lower.includes(needle)) rest.push(zone);
    }
    return [...starts, ...rest];
  }, [zones, query]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (zone: string) => {
    onChange(zone);
    close();
    inputRef.current?.focus();
  };

  const openList = () => {
    const currentIndex = zones.indexOf(value);
    setQuery("");
    setActive(currentIndex >= 0 ? currentIndex : 0);
    setOpen(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (filtered.length === 0) return;
      setActive((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (filtered.length === 0) return;
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const zone = filtered[active];
      if (zone) choose(zone);
    } else if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      close();
    }
  };

  const activeZone = filtered[active];

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: focus containment only
    <div
      className="relative"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        close();
      }}
    >
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          open && activeZone ? `${listId}-${activeZone}` : undefined
        }
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        value={open ? query : value}
        placeholder={value || "Начните вводить: Europe/Moscow"}
        className={comboboxInputClass}
        onFocus={openList}
        onClick={() => {
          if (!open) openList();
          else inputRef.current?.focus();
        }}
        onChange={(event) => {
          setOpen(true);
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Скрыть список часовых поясов" : "Показать список часовых поясов"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) {
            close();
          } else {
            openList();
            inputRef.current?.focus();
          }
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
      >
        <span aria-hidden="true" className="text-[10px]">
          ▼
        </span>
      </button>

      {open && (
        // biome-ignore lint/a11y/useSemanticElements: ARIA listbox with button options is keyboard-managed by the combobox input
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Часовые пояса"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl shadow-black/40"
        >
          {filtered.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-zinc-500">
              Ничего не найдено
            </p>
          )}
          {filtered.map((zone, index) => {
            const selected = zone === value;
            return (
              <button
                key={zone}
                id={`${listId}-${zone}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(zone)}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs ${
                  index === active ? "bg-sky-500/15 text-sky-100" : "text-zinc-300"
                } ${selected ? "font-medium text-sky-300" : ""}`}
              >
                <span className="truncate">{zone}</span>
                <span className="shrink-0 text-[10px] text-zinc-500 tabular-nums">
                  {timezoneOffset(zone)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Slider + precise number input                                              */
/* -------------------------------------------------------------------------- */

export function SliderField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  numberStep,
  format,
  display,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Raw string so the number input can be empty while typing. */
  value: string;
  onChange: (raw: string) => void;
  min: number;
  max: number;
  step: number;
  numberStep?: number;
  format: (value: number) => string;
  /** Optional override for the big value label (defaults to `format`). */
  display?: string;
  disabled?: boolean;
}) {
  const parsed = Number(value.trim());
  const valid = value.trim() !== "" && Number.isFinite(parsed);
  const inRange = valid && parsed >= min && parsed <= max;
  const sliderValue = inRange ? parsed : min;
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs text-zinc-400">
          {label}
        </label>
        <span className="text-xs font-medium text-zinc-200 tabular-nums">
          {display ?? (inRange ? format(parsed) : "—")}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={sliderValue}
          disabled={disabled}
          aria-valuetext={format(sliderValue)}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
          className="h-4 w-full min-w-0 cursor-pointer accent-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <input
          type="number"
          inputMode="decimal"
          aria-label={`${label}: точное значение`}
          aria-invalid={!inRange}
          aria-describedby={hintId}
          min={min}
          max={max}
          step={numberStep ?? step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={`${numberInputClass} ${
            inRange
              ? ""
              : "border-red-500/70 focus:border-red-400 focus:ring-red-500/30"
          }`}
        />
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-[11px] text-zinc-500">
          {hint}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Communication profile cards                                                */
/* -------------------------------------------------------------------------- */

export interface CardOption {
  value: string;
  label: string;
  description: string;
}

export function ChoiceCards({
  name,
  legend,
  hint,
  options,
  value,
  fallback,
  onChange,
  disabled,
  extra,
}: {
  name: string;
  legend: string;
  hint?: string;
  options: readonly CardOption[];
  value: string | undefined;
  /** Default used when the JSON has no key at all. */
  fallback: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const selected = value ?? fallback;
  const isKnown = options.some((option) => option.value === selected);

  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="text-xs text-zinc-400">{legend}</legend>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
      <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
        {options.map((option) => {
          const checked = option.value === selected;
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-lg border p-2 text-xs transition-colors focus-within:ring-2 focus-within:ring-sky-400/60 ${
                checked
                  ? "border-sky-500 bg-sky-500/10 text-zinc-100"
                  : "border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:border-zinc-600"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange(option.value)}
                  className="h-3 w-3 accent-sky-500"
                />
                <span className="font-medium">{option.label}</span>
                <span className="text-[10px] text-zinc-500">
                  {option.value}
                </span>
              </span>
              <span className="text-[11px] leading-snug text-zinc-500">
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
      {value !== undefined && value !== "" && !isKnown && (
        <p className="mt-1 text-[11px] text-amber-400">
          Текущее значение{" "}
          <code className="rounded bg-zinc-800 px-1">{value}</code> нестандартное:
          оно сохранится, пока вы не выберете карточку.
        </p>
      )}
      {extra}
    </fieldset>
  );
}
