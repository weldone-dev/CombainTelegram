"use client";

import { useEffect, useRef, useState } from "react";
import type { MessageTranscriptionView } from "../../lib/types";

/** Playback rates offered by the cycle button. */
const PLAYBACK_RATES = [1, 1.5, 2] as const;

/** Opus granule positions count 48 kHz samples. */
const OPUS_SAMPLE_RATE = 48_000;

/**
 * Duration of an Ogg/Opus file, read from the granule position of its last
 * page. Chromium reports `Infinity` for a Telegram voice note until the whole
 * file is buffered, so this keeps the total time visible while streaming.
 */
async function readOggOpusDuration(
  src: string,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetch(src, { cache: "force-cache", signal });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // "OggS" magic, then version(1) type(1) granule(8) serial(4) ...
    for (let index = bytes.length - 14; index >= 0; index -= 1) {
      if (
        bytes[index] !== 0x4f ||
        bytes[index + 1] !== 0x67 ||
        bytes[index + 2] !== 0x67 ||
        bytes[index + 3] !== 0x53
      ) {
        continue;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + index, 14);
      // Two 32-bit halves keep this independent of ES2020 BigInt literals.
      const low = view.getUint32(6, true);
      const high = view.getUint32(10, true);
      const samples = high * 0x1_0000_0000 + low;
      if (samples <= 0) break;
      const seconds = samples / OPUS_SAMPLE_RATE;
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
      break;
    }
  } catch {
    // A cancelled probe or an opaque response: the player still works, it just
    // shows `--:--` until the browser learns the duration itself.
  }
  return null;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function PlayIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-4 w-4 translate-x-px fill-current"
    >
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-4 w-4 fill-current"
    >
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5 stroke-current"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}

/**
 * Compact voice-note player. The native `<audio controls>` collapses to a
 * ~37 px pill inside a shrink-to-fit message bubble, so the player is drawn
 * with our own markup and a fixed minimum width. Colours come from the
 * surrounding bubble (`currentColor`), which keeps it readable in both the
 * sky outgoing and the zinc incoming bubble.
 */
export function VoiceBubble({
  src,
  fileName,
  selecting,
  transcript,
  transcribing,
  onTranscribe,
}: {
  src: string;
  fileName?: string | null;
  selecting: boolean;
  transcript?: MessageTranscriptionView;
  transcribing: boolean;
  onTranscribe: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const probeRef = useRef<AbortController | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    return () => probeRef.current?.abort();
  }, []);

  const applyDuration = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0)
      return false;
    setDuration(value);
    return true;
  };

  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setLoading(false);
    if (applyDuration(audio.duration)) return;
    // Chromium keeps `Infinity` for a partially buffered Ogg stream; read the
    // real length from the file instead of showing a forever-empty timeline.
    probeRef.current?.abort();
    const controller = new AbortController();
    probeRef.current = controller;
    void readOggOpusDuration(src, controller.signal).then((seconds) => {
      if (seconds !== null) setDuration(seconds);
    });
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch {
      setFailed(true);
    }
  };

  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || duration === null) return;
    const next = Math.min(Math.max(seconds, 0), duration);
    audio.currentTime = next;
    setCurrent(next);
  };

  const cycleRate = () => {
    const audio = audioRef.current;
    const index = PLAYBACK_RATES.indexOf(
      rate as (typeof PLAYBACK_RATES)[number],
    );
    const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
    setRate(next);
    if (audio) audio.playbackRate = next;
  };

  // Clicks and keys inside the player must never select the message.
  const keepLocal = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };

  const progress =
    duration && duration > 0 ? Math.min(current / duration, 1) : 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only stops clicks and keys from reaching the message-selection handler; every control inside is a real button/link/range.
    <div
      className={`my-1 w-[240px] max-w-full rounded-xl bg-black/20 px-2 py-1.5 text-current ${
        selecting ? "cursor-default" : ""
      }`}
      onClick={keepLocal}
      onKeyDown={keepLocal}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={(event) => {
          applyDuration(event.currentTarget.duration);
        }}
        onCanPlay={() => setLoading(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
        className="hidden"
      >
        <track kind="captions" />
      </audio>

      {failed ? (
        <div className="flex items-center gap-2 py-0.5 text-xs" role="alert">
          <span aria-hidden="true" className="text-sm">
            ⚠
          </span>
          <span className="min-w-0 flex-1">Не удалось загрузить голосовое</span>
          <a
            href={src}
            download={fileName ?? "voice.ogg"}
            onClick={keepLocal}
            className="shrink-0 underline underline-offset-2 opacity-80 hover:opacity-100"
          >
            Скачать
          </a>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void togglePlayback()}
              title={playing ? "Пауза" : "Слушать"}
              aria-label={playing ? "Пауза" : "Слушать голосовое"}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-current/15 transition-colors hover:bg-current/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>

            <div className="min-w-0 flex-1">
              <div className="relative flex h-4 items-center">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-current/20">
                  <div
                    className="h-full rounded-full bg-current/70"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration ?? 0}
                  step={0.01}
                  value={duration === null ? 0 : Math.min(current, duration)}
                  disabled={duration === null}
                  onChange={(event) => seek(Number(event.target.value))}
                  aria-label="Позиция воспроизведения"
                  title="Перемотать"
                  className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-default"
                  autoComplete="off"
                />
              </div>
              <div className="flex items-center justify-between text-[11px] leading-tight tabular-nums opacity-75">
                <span>{formatClock(current)}</span>
                <span>
                  {duration === null ? "--:--" : formatClock(duration)}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px]">
            <button
              type="button"
              onClick={cycleRate}
              title="Скорость воспроизведения"
              aria-label={`Скорость воспроизведения ${rate}×`}
              className="rounded px-1 py-0.5 tabular-nums opacity-75 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-current/40"
            >
              {rate}×
            </button>
            <a
              href={src}
              download={fileName ?? "voice.ogg"}
              onClick={keepLocal}
              title="Скачать голосовое"
              aria-label="Скачать голосовое"
              className="rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-current/40"
            >
              <DownloadIcon />
            </a>
          </div>

          <div className="mt-1 border-t border-current/15 pt-1">
            {transcribing || transcript?.pending ? (
              <span className="flex items-center gap-1.5 text-[11px] opacity-75">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 animate-spin rounded-full border border-current/30 border-t-current"
                />
                Расшифровка…
              </span>
            ) : (
              <button
                type="button"
                onClick={onTranscribe}
                className="text-[11px] underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-current/40"
              >
                Расшифровать
              </button>
            )}
            {transcript && !transcript.pending && (
              <p
                className={`mt-1 text-xs leading-snug ${
                  transcript.unavailable ? "italic opacity-60" : ""
                }`}
              >
                {transcript.text || "Пустая расшифровка"}
              </p>
            )}
          </div>
        </>
      )}

      {loading && !failed && duration === null && (
        <output className="sr-only">Загружаем голосовое</output>
      )}
    </div>
  );
}
