"use client";

/**
 * Bipolar `-100…+100` metric bar used by the relationship cards.
 *
 * Zero sits in the middle of the track: positive values fill from the centre to
 * the right, negative ones from the centre to the left, and `0` renders no fill
 * at all (only the centre tick). The current value is printed at the end of the
 * fill, or centred when the value is `0`.
 */

const MIN = -100;
const MAX = 100;

/** `+12` / `−12` / `0`, with a typographic minus like the rest of the UI. */
export function formatBipolarValue(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded > 0) return `+${rounded}`;
  if (rounded < 0) return `−${Math.abs(rounded)}`;
  return "0";
}

export function BipolarMetric({
  label,
  value,
  className = "",
}: {
  label: string;
  value: number;
  className?: string;
}) {
  const safe = Number.isFinite(value) ? value : 0;
  const clamped = Math.max(MIN, Math.min(MAX, safe));
  const pct = clamped / 100;
  const filled = Math.abs(pct) * 50;
  const text = formatBipolarValue(clamped);

  const tone =
    pct > 0
      ? { fill: "bg-sky-500", text: "text-sky-300" }
      : pct < 0
        ? { fill: "bg-red-500", text: "text-red-300" }
        : { fill: "", text: "text-zinc-400" };

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-zinc-400">
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-mono text-[9px] tabular-nums text-zinc-600">
          −100…+100
        </span>
      </div>

      <div className="relative mt-0.5 h-3.5 text-[10px] leading-none">
        <span
          className={`absolute top-0 -translate-x-1/2 whitespace-nowrap font-mono tabular-nums ${tone.text}`}
          // Clamp keeps the label inside the track at ±100: the 1rem padding is
          // wider than half of the widest label (`+100` / `−100`).
          style={{
            left: `clamp(1rem, calc(50% + ${pct * 50}%), calc(100% - 1rem))`,
          }}
        >
          {text}
        </span>
      </div>

      <div
        role="meter"
        aria-label={label}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={clamped}
        aria-valuetext={text}
        className="relative h-1.5 overflow-hidden rounded-full bg-zinc-800"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-600"
        />
        {pct !== 0 && (
          <span
            aria-hidden
            className={`absolute inset-y-0 rounded-full ${tone.fill}`}
            style={{
              left: `${pct > 0 ? 50 : 50 - filled}%`,
              width: `${filled}%`,
              // A value of ±1 would otherwise be a sub-pixel sliver.
              minWidth: "2px",
            }}
          />
        )}
      </div>
    </div>
  );
}
