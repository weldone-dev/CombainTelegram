const SOUND_KEY = "ct:sound";

type AudioContextConstructor = new () => AudioContext;

/** Sound is opt-out: anything but an explicit "0" means enabled. */
export function readSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, enabled ? "1" : "0");
  } catch {
    // Preference persistence is best-effort.
  }
}

let sharedContext: AudioContext | null = null;
let contextUnavailable = false;

function contextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const legacy = (
    window as unknown as { webkitAudioContext?: AudioContextConstructor }
  ).webkitAudioContext;
  return window.AudioContext ?? legacy ?? null;
}

/**
 * One shared context for the whole page. Browsers only allow it to start from
 * a user gesture, so it is created lazily on the first toggle/test click.
 */
function getContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  if (contextUnavailable) return null;
  const Ctor = contextConstructor();
  if (!Ctor) {
    contextUnavailable = true;
    return null;
  }
  try {
    sharedContext = new Ctor();
  } catch {
    contextUnavailable = true;
    return null;
  }
  return sharedContext;
}

/**
 * Creates or resumes the shared context. Call it from a click handler so the
 * autoplay policy lets the chime play later on its own.
 */
export function primeAudio(): void {
  const context = getContext();
  if (!context) return;
  if (context.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
}

function scheduleTone(
  context: AudioContext,
  frequency: number,
  start: number,
  duration: number,
  peak: number,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  // A short fade in/out keeps the tone gentle instead of a click.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.01);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}

/**
 * Two-tone notification chime (880 Hz then 1174 Hz, ~180 ms). A no-op when the
 * user muted the sound or Web Audio is unavailable, so callers need no checks.
 */
export function playChime(): void {
  if (!readSoundEnabled()) return;
  // Never create the context from an incoming message: it could be suspended
  // by the autoplay policy and scheduling tones there plays them all at once
  // as soon as the user finally interacts. It is created by `primeAudio()`.
  const context = sharedContext;
  if (!context) return;
  if (context.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
  const start = context.currentTime + 0.01;
  scheduleTone(context, 880, start, 0.09, 0.1);
  scheduleTone(context, 1174, start + 0.09, 0.09, 0.12);
}
