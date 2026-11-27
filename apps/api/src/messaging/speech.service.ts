import { Injectable, Logger } from '@nestjs/common';
import { Blob } from 'node:buffer';
import * as childProcess from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Agent, FormData, fetch as httpFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { emitLog } from '../logs/log-sink.js';

/** Engine selection from `STT_ENGINE`. */
export type SttSelection = 'remote' | 'local' | 'disabled';
/** Engine that actually produced a transcript (whisper is internal only). */
export type SttEngine = 'remote' | 'parakeet' | 'whisper';

export interface SpeechInput {
  data: Buffer;
  mimeType: string;
  fileName?: string | null;
}

export interface SpeechResult {
  text: string;
  /** Detected/requested language, or `null` when the engine does not report it. */
  language: string | null;
  /** Audio length in milliseconds, `0` when the engine does not report it. */
  durationMs: number;
}

/** Minimal shape of the `sherpa-onnx-node` offline recognizer we use. */
export interface ParakeetStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

export interface ParakeetRecognizer {
  createStream(): ParakeetStream;
  decode(stream: ParakeetStream): void;
  decodeAsync?(stream: ParakeetStream): Promise<{ text?: unknown; lang?: unknown }>;
  getResult(stream: ParakeetStream): { text?: unknown; lang?: unknown };
}

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
}

/** Inclusive-exclusive region of the audio that contains speech. */
export interface SpeechSpan {
  startMs: number;
  endMs: number;
}

/** OpenAI-compatible HTTP engine, configured from `STT_BASE_URL`. */
interface RemoteSpeechTarget {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

/** Biggest voice note accepted for transcription. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
/** The recognizer is CPU-bound, so at most two jobs run at once. */
const MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const SAMPLE_RATE = 16_000;
/** Longer clips are cut at silences before decoding: 30 s in one pass loses quality. */
const SPLIT_THRESHOLD_MS = 20_000;
/** Biggest decoded chunk, milliseconds. */
const MAX_CHUNK_MS = 15_000;
/** Hard cap on chunks, so a broken silence scan cannot fan out forever. */
const MAX_CHUNKS = 40;
/** Silence detection sensitivity for the split pass. */
const SILENCE_FILTER = 'silencedetect=noise=-45dB:d=0.25';
const DEFAULT_PARAKEET_DIR = '~/.local/share/combain/parakeet-tdt-0.6b-v3';
const DEFAULT_WHISPER_MODEL = '~/.local/share/combain/whisper/ggml-small.bin';
const DEFAULT_STT_MODEL = 'parakeet-tdt-0.6b-v3';
/** Long notes take a while on the LAN service, so the remote call gets its own budget. */
const REMOTE_TIMEOUT_MS = 300_000;
const REMOTE_PROBE_TIMEOUT_MS = 5_000;
/** A failed probe is remembered so every note does not pay for it. */
const REMOTE_PROBE_TTL_MS = 60_000;
/** Model files the local Parakeet recognizer needs; also used by the probe. */
export const PARAKEET_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
] as const;

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `~` and `~/x` expand to the current user's home directory. */
export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function absolutePath(value: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/**
 * Whether a command/path is usable. A bare name (`whisper-cli`) is assumed to
 * be on `PATH`: resolving it here would duplicate what `execFile` does, and the
 * spawn failure is handled as a normal transcription failure.
 */
function commandExists(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!trimmed.includes('/')) return true;
  try {
    accessSync(absolutePath(trimmed), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(value: string): boolean {
  const path = absolutePath(value);
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Directory of the local Parakeet ONNX model (`PARAKEET_MODEL_DIR`). */
export function parakeetModelDirectory(): string {
  return absolutePath(envValue('PARAKEET_MODEL_DIR') ?? DEFAULT_PARAKEET_DIR);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Whether an address is on the local network. The workstation sets
 * `HTTP(S)_PROXY` to a corporate proxy that answers 503 for the LAN, so these
 * requests must bypass it explicitly; public endpoints keep the default path.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return (
    first === 10 ||
    first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254)
  );
}

/** `base` + the OpenAI-compatible transcription path, tolerating both forms. */
export function remoteEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/audio/transcriptions')) return base;
  if (base.endsWith('/v1')) return `${base}/audio/transcriptions`;
  return `${base}/v1/audio/transcriptions`;
}

function healthEndpoint(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/health`;
  } catch {
    return `${baseUrl.trim().replace(/\/+$/, '')}/health`;
  }
}

let directAgent: Agent | null = null;

/**
 * A dispatcher that connects without any proxy. It is created once and reused:
 * the LAN STT service must never be routed through `HTTP_PROXY`.
 */
function directDispatcher(): Agent {
  directAgent ??= new Agent({ connect: { timeout: 10_000 } });
  return directAgent;
}

/** Request init for the STT endpoints, adding the bypass for private hosts. */
function sttRequestInit(
  url: string,
  init: UndiciRequestInit,
): UndiciRequestInit {
  const result: UndiciRequestInit = { ...init };
  try {
    if (isPrivateHost(new URL(url).hostname)) {
      result.dispatcher = directDispatcher();
    }
  } catch {
    // A malformed URL fails at fetch() with a readable error.
  }
  return result;
}

/** Joins whisper segments and collapses all whitespace into single spaces. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** `HH:MM:SS,mmm` / `HH:MM:SS.mmm` → milliseconds. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (
    Number(h) * 3_600_000 +
    Number(m) * 60_000 +
    Number(s) * 1_000 +
    Number(ms.padEnd(3, '0'))
  );
}

/**
 * Reads `whisper-cli -oj` output defensively. Documented shape is
 * `{ transcription: [{ text, timestamps? }], result?: { language } }`, but a
 * plain `{ text }` is accepted as well.
 */
export function parseWhisperJson(
  raw: string,
  requestedLanguage: string,
): SpeechResult {
  const json = JSON.parse(raw) as Record<string, unknown>;
  if (!json || typeof json !== 'object') {
    throw new Error('whisper output is not an object');
  }
  const parts: string[] = [];
  let audioMs = 0;
  const segments = Array.isArray(json.transcription) ? json.transcription : [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const item = segment as Record<string, unknown>;
    if (typeof item.text === 'string' && item.text.trim()) {
      parts.push(item.text);
    }
    const timestamps = item.timestamps;
    if (timestamps && typeof timestamps === 'object') {
      const to = parseTimestamp((timestamps as Record<string, unknown>).to);
      if (to !== null) audioMs = Math.max(audioMs, to);
    }
    const offsets = item.offsets;
    if (offsets && typeof offsets === 'object') {
      const to = (offsets as Record<string, unknown>).to;
      if (typeof to === 'number' && Number.isFinite(to)) {
        audioMs = Math.max(audioMs, to);
      }
    }
  }
  if (parts.length === 0 && typeof json.text === 'string') {
    parts.push(json.text);
  }
  const result =
    json.result && typeof json.result === 'object'
      ? (json.result as Record<string, unknown>)
      : {};
  const params =
    json.params && typeof json.params === 'object'
      ? (json.params as Record<string, unknown>)
      : {};
  const detected =
    typeof result.language === 'string'
      ? result.language
      : typeof params.language === 'string'
        ? params.language
        : null;
  const language =
    detected && detected !== 'auto'
      ? detected
      : requestedLanguage !== 'auto'
        ? requestedLanguage
        : null;
  return {
    text: collapseWhitespace(parts.join(' ')),
    language,
    durationMs: audioMs,
  };
}

/**
 * Minimal RIFF/WAVE reader for the 16 kHz mono PCM that ffmpeg writes for us.
 * Used when the native `readWave` export is unavailable; returns `null` for
 * anything the recognizer cannot consume.
 */
export function readWavSamples(buffer: Buffer): WavData | null {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }
  let format = 1;
  let channels = 1;
  let sampleRate = SAMPLE_RATE;
  let bitsPerSample = 16;
  let data: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) break;
    if (id === 'fmt ' && size >= 16) {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2) || 1;
      sampleRate = buffer.readUInt32LE(body + 4) || SAMPLE_RATE;
      bitsPerSample = buffer.readUInt16LE(body + 14) || 16;
      if (format === 0xfffe && size >= 26) {
        // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of
        // the sub-format GUID at the end of the fmt chunk.
        format = buffer.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!data) return null;
  const frames = Math.floor(data.length / (channels * (bitsPerSample / 8)));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    // ffmpeg is asked for mono, but a stereo file still reads its first
    // channel instead of failing.
    const index = frame * channels;
    if (format === 3 && bitsPerSample === 32) {
      samples[frame] = data.readFloatLE(index * 4);
    } else if (bitsPerSample === 16) {
      samples[frame] = data.readInt16LE(index * 2) / 32_768;
    } else if (bitsPerSample === 32) {
      samples[frame] = data.readInt32LE(index * 4) / 2_147_483_648;
    } else if (bitsPerSample === 8) {
      samples[frame] = (data.readUInt8(index) - 128) / 128;
    } else if (bitsPerSample === 24) {
      const at = index * 3;
      const value =
        data[at] |
        (data[at + 1] << 8) |
        (data[at + 2] << 16) |
        (data[at + 2] << 24);
      samples[frame] = value / 8_388_608;
    } else {
      return null;
    }
  }
  return { samples, sampleRate };
}

/**
 * Turns `silencedetect` stderr into the regions that contain speech. Unpaired
 * markers are clamped to the clip, and a trailing silence ends the speech span.
 */
export function speechSpans(
  stderr: string,
  durationMs: number,
): SpeechSpan[] {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (start) starts.push(Number(start[1]) * 1000);
    if (end) ends.push(Number(end[1]) * 1000);
  }
  const silences: SpeechSpan[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const startMs = clamp(starts[index], 0, durationMs);
    const endMs = clamp(ends[index] ?? durationMs, startMs, durationMs);
    silences.push({ startMs, endMs });
  }
  const spans: SpeechSpan[] = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.startMs - cursor >= 200) {
      spans.push({ startMs: cursor, endMs: silence.startMs });
    }
    cursor = Math.max(cursor, silence.endMs);
  }
  if (durationMs - cursor >= 200) {
    spans.push({ startMs: cursor, endMs: durationMs });
  }
  return spans;
}

/**
 * Groups speech spans into decode windows of at most `maxMs`. Continuous
 * speech is cut into fixed windows; a single span that already fits is kept.
 */
export function planChunks(
  spans: SpeechSpan[],
  durationMs: number,
  maxMs = MAX_CHUNK_MS,
  maxChunks = MAX_CHUNKS,
): SpeechSpan[] {
  const chunks: SpeechSpan[] = [];
  let current: SpeechSpan | null = null;
  for (const span of spans) {
    const endMs = clamp(span.endMs, 0, durationMs);
    const startMs = clamp(span.startMs, 0, endMs);
    if (endMs - startMs < 200) continue;
    if (endMs - startMs > maxMs) {
      if (current) {
        chunks.push(current);
        current = null;
      }
      for (let start = startMs; start < endMs; start += maxMs) {
        chunks.push({ startMs: start, endMs: Math.min(start + maxMs, endMs) });
      }
      continue;
    }
    if (!current) {
      current = { startMs, endMs };
      continue;
    }
    if (endMs - current.startMs <= maxMs) {
      current.endMs = endMs;
      continue;
    }
    chunks.push(current);
    current = { startMs, endMs };
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) {
    for (let start = 0; start < durationMs; start += maxMs) {
      chunks.push({ startMs: start, endMs: Math.min(start + maxMs, durationMs) });
    }
  }
  return chunks.slice(0, maxChunks);
}

/**
 * Loads the Parakeet TDT recognizer from `sherpa-onnx-node`.
 *
 * The package is a native CommonJS addon, so it is imported dynamically and
 * resolved through `default` when the named export is not hoisted. Everything
 * is checked before use: the module and model are installed by a separate
 * process and may be absent on a fresh machine.
 */
async function loadSherpaRecognizer(directory: string): Promise<{
  recognizer: ParakeetRecognizer;
  readWave: ((path: string) => WavData) | null;
}> {
  const moduleName = 'sherpa-onnx-node';
  const loaded = (await import(moduleName)) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const namespace = (loaded.default ?? loaded) as Record<string, unknown>;
  const Constructor = namespace.OfflineRecognizer as
    | (new (config: unknown) => ParakeetRecognizer) & {
        createAsync?: (config: unknown) => Promise<ParakeetRecognizer>;
      }
    | undefined;
  if (typeof Constructor !== 'function') {
    throw new Error('sherpa-onnx-node does not export OfflineRecognizer');
  }
  const config = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(directory, 'encoder.int8.onnx'),
        decoder: join(directory, 'decoder.int8.onnx'),
        joiner: join(directory, 'joiner.int8.onnx'),
      },
      tokens: join(directory, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  };
  // 2.x has an async factory that keeps the event loop responsive while the
  // encoder loads; older builds only have the blocking constructor.
  const recognizer =
    typeof Constructor.createAsync === 'function'
      ? await Constructor.createAsync(config)
      : new Constructor(config);
  if (
    typeof recognizer.createStream !== 'function' ||
    typeof recognizer.decode !== 'function' ||
    typeof recognizer.getResult !== 'function'
  ) {
    throw new Error('sherpa-onnx-node recognizer has an unexpected API');
  }
  const readWave =
    typeof namespace.readWave === 'function'
      ? (namespace.readWave as (path: string) => WavData)
      : null;
  return { recognizer, readWave };
}

/**
 * Speech-to-text for voice notes: Parakeet TDT 0.6B v3, remote or local.
 *
 * Everything is configured from the environment (`STT_*`); there is no
 * settings row and no dashboard override:
 *
 * - `STT_ENGINE=remote`   — the Parakeet HTTP service only. A failure returns
 *                `null` unless `STT_LOCAL_FALLBACK=on`, so a misconfigured
 *                service is visible instead of silently turning into local
 *                decoding;
 * - `STT_ENGINE=local`    — the local Parakeet TDT recognizer only;
 * - `STT_ENGINE=disabled` — transcription is off;
 * - unset                 — remote when `STT_BASE_URL` is set, local
 *                Parakeet when the model files are installed, otherwise off
 *                (graceful degrade: `transcribe` returns `null`).
 *
 * Whisper is an internal last resort: it is reachable only through
 * `STT_ENGINE=whisper` or the opt-in `STT_LOCAL_FALLBACK=on` chain.
 * `STT_REMOTE=off` removes the remote engine from every selection.
 *
 * Telegram's own transcription needs Premium, so everything happens in this
 * process: ffmpeg converts the note to 16 kHz mono WAV and the chosen engine
 * turns that into text.
 *
 * `transcribe` never throws: a missing binary, a dead model, a timeout or an
 * empty result all return `null` so the caller can answer the peer anyway.
 */
@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);
  private active = 0;
  private readonly queue: Array<() => void> = [];
  /** Loaded once per process; the ONNX encoder costs ~2 GB RSS to load. */
  private recognizer: ParakeetRecognizer | null = null;
  private readWaveFile: ((path: string) => WavData) | null = null;
  private recognizerPromise: Promise<ParakeetRecognizer> | null = null;
  /** Flipped when the native module turns out to be unusable. */
  private parakeetBroken = false;
  private parakeetLoader: () => Promise<ParakeetRecognizer> = async () => {
    const loaded = await loadSherpaRecognizer(this.parakeetDirectory());
    this.readWaveFile = loaded.readWave;
    return loaded.recognizer;
  };
  /** Cached HTTP engine config; `null` means the remote engine is off. */
  private readonly remote: RemoteSpeechTarget | null;
  /** Result of the last `/health` probe and when it ran. */
  private remoteProbe: { at: number; ok: boolean } | null = null;

  constructor() {
    this.remote = this.remoteTarget();
  }

  /**
   * Test seam: replaces the native recognizer loader so the pipeline can be
   * exercised without the ONNX model. `null` restores the real loader.
   */
  setParakeetLoader(
    loader: (() => Promise<ParakeetRecognizer>) | null,
  ): void {
    this.parakeetLoader =
      loader ??
      (async () => {
        const loaded = await loadSherpaRecognizer(this.parakeetDirectory());
        this.readWaveFile = loaded.readWave;
        return loaded.recognizer;
      });
    this.recognizer = null;
    this.readWaveFile = null;
    this.recognizerPromise = null;
    this.parakeetBroken = false;
  }

  /** Whether any configured engine can transcribe right now. */
  available(): boolean {
    return this.engines().length > 0;
  }

  async transcribe(input: SpeechInput): Promise<SpeechResult | null> {
    const started = Date.now();
    const bytes = input.data.length;
    const mime = input.mimeType || 'application/octet-stream';
    const engines = this.engines();
    if (engines.length === 0) {
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'speech.transcribe',
        message: 'Speech transcription unavailable: no engine is installed',
        status: 'failed',
        details: { bytes, mime, reason: 'unavailable' },
      });
      return null;
    }
    if (bytes === 0) {
      this.logFailure(bytes, mime, 'empty input', started);
      return null;
    }
    if (bytes > MAX_INPUT_BYTES) {
      this.logFailure(
        bytes,
        mime,
        `input is ${bytes} bytes, limit is ${MAX_INPUT_BYTES}`,
        started,
      );
      return null;
    }

    await this.acquire();
    let directory: string | null = null;
    try {
      const timeoutMs = envInt('WHISPER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
      const deadline = started + timeoutMs;
      let lastError: unknown = null;

      // The HTTP engine takes the original file, so no ffmpeg pass is needed.
      const remote = this.remote;
      if (remote && engines.includes('remote') && (await this.remoteUsable(remote))) {
        try {
          const result = await this.transcribeRemote(
            remote,
            input,
          );
          if (!result.text) throw new Error('remote returned no text');
          return this.finish('remote', result, bytes, mime, started);
        } catch (error) {
          lastError = error;
          this.logger.warn(
            `Speech engine remote failed: ${(error as Error).message}`,
          );
        }
      }

      const locals = engines.filter((engine) => engine !== 'remote');
      if (locals.length === 0) {
        this.logFailure(
          bytes,
          mime,
          lastError instanceof Error ? lastError.message : 'no engine worked',
          started,
        );
        return null;
      }

      directory = await mkdtemp(join(tmpdir(), 'combain-speech-'));
      const inputPath = join(
        directory,
        `input${this.extensionFor(mime, input.fileName)}`,
      );
      const wavPath = join(directory, 'audio.wav');
      await writeFile(inputPath, input.data);
      await this.runCommand(
        envValue('FFMPEG_BIN') ?? 'ffmpeg',
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          inputPath,
          '-ar',
          String(SAMPLE_RATE),
          '-ac',
          '1',
          wavPath,
        ],
        deadline - Date.now(),
      );

      for (const engine of locals) {
        try {
          const result =
            engine === 'parakeet'
              ? await this.runParakeet(directory, wavPath, deadline)
              : await this.runWhisper(directory, wavPath, deadline);
          if (!result.text) {
            lastError = new Error(`${engine} returned no text`);
            this.logger.warn(`Speech engine ${engine} returned no text`);
            continue;
          }
          return this.finish(engine, result, bytes, mime, started);
        } catch (error) {
          lastError = error;
          if (engine === 'parakeet') this.parakeetBroken = true;
          this.logger.warn(
            `Speech engine ${engine} failed: ${(error as Error).message}`,
          );
        }
      }
      this.logFailure(
        bytes,
        mime,
        lastError instanceof Error ? lastError.message : 'no engine worked',
        started,
      );
      return null;
    } catch (error) {
      this.logFailure(
        bytes,
        mime,
        error instanceof Error ? error.message : String(error),
        started,
      );
      return null;
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      this.release();
    }
  }

  /** Shared success path: empty text is a failure, not a transcript. */
  private finish(
    engine: SttEngine,
    result: SpeechResult,
    bytes: number,
    mime: string,
    started: number,
  ): SpeechResult | null {
    if (!result.text) {
      this.logFailure(bytes, mime, `${engine} returned no text`, started);
      return null;
    }
    const elapsed = Date.now() - started;
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'speech.transcribe',
      message: result.durationMs
        ? `Transcribed ${result.durationMs} ms of audio in ${elapsed} ms with ${engine}`
        : `Transcribed audio in ${elapsed} ms with ${engine}`,
      status: 'ok',
      durationMs: elapsed,
      details: {
        engine,
        bytes,
        ms: elapsed,
        chars: result.text.length,
      },
    });
    return result;
  }

  /**
   * Engines that can run, in preference order.
   *
   * `STT_ENGINE` decides (legacy names are mapped). Unset means `auto`:
   * remote when `STT_BASE_URL` is configured, otherwise local Parakeet when
   * its model is installed, otherwise no engine at all. `remote` stays
   * remote-only unless `STT_LOCAL_FALLBACK=on` explicitly re-enables the local
   * chain, and `local` never reaches for whisper.
   */
  private engines(): SttEngine[] {
    const env = this.envSelection();
    if (env === 'disabled') return [];
    if (env === 'whisper') return this.whisperReady() ? ['whisper'] : [];
    if (env === 'remote') return this.remoteChain();
    if (env === 'local') return this.parakeetReady() ? ['parakeet'] : [];
    // Unset/unknown: `auto`.
    if (this.remote) return this.remoteChain();
    return this.parakeetReady() ? ['parakeet'] : [];
  }

  /**
   * The remote engine, optionally followed by the local chain when
   * `STT_LOCAL_FALLBACK=on`. Off by default so a dead LXC is visible.
   */
  private remoteChain(): SttEngine[] {
    if (!this.remote) return [];
    if (!this.localFallback()) return ['remote'];
    const engines: SttEngine[] = ['remote'];
    if (this.parakeetReady()) engines.push('parakeet');
    // Whisper stays an internal last resort, never a selectable engine.
    if (this.whisperReady()) engines.push('whisper');
    return engines;
  }

  /**
   * `STT_ENGINE` as a selection, or `null` when it is unset/unusable.
   * `whisper` is kept for the internal env-only path; `auto`, `parakeet` and
   * unknown values are mapped onto the three supported choices.
   */
  private envSelection(): SttSelection | 'whisper' | null {
    const env = envValue('STT_ENGINE')?.toLowerCase();
    if (!env) return null;
    if (env === 'whisper') return 'whisper';
    if (env === 'remote' || env === 'local' || env === 'disabled') return env;
    if (env === 'parakeet') return 'local';
    if (env === 'auto') return this.remote ? 'remote' : 'local';
    return null;
  }

  /** `STT_LOCAL_FALLBACK=on` re-enables local decoding after a remote failure. */
  private localFallback(): boolean {
    const value = envValue('STT_LOCAL_FALLBACK')?.toLowerCase();
    return value === 'on' || value === 'true' || value === '1' || value === 'yes';
  }

  private parakeetDirectory(): string {
    return parakeetModelDirectory();
  }

  private parakeetReady(): boolean {
    if (this.parakeetBroken) return false;
    const directory = this.parakeetDirectory();
    if (!PARAKEET_FILES.every((name) => fileExists(join(directory, name)))) {
      return false;
    }
    return this.ffmpegReady();
  }

  private whisperReady(): boolean {
    const binary = envValue('WHISPER_BIN') ?? 'whisper-cli';
    const model = envValue('WHISPER_MODEL') ?? DEFAULT_WHISPER_MODEL;
    return commandExists(binary) && fileExists(model) && this.ffmpegReady();
  }

  private ffmpegReady(): boolean {
    return commandExists(envValue('FFMPEG_BIN') ?? 'ffmpeg');
  }

  /**
   * Builds the HTTP engine target from `STT_*`. The engine is off when
   * `STT_ENGINE=disabled`, `STT_REMOTE=off`, or no `STT_BASE_URL` is set: the
   * service then degrades to local engines or to "not configured".
   */
  private remoteTarget(): RemoteSpeechTarget | null {
    // `disabled` and `STT_REMOTE=off` remove the network engine entirely.
    if (envValue('STT_ENGINE')?.toLowerCase() === 'disabled') return null;
    if (envValue('STT_REMOTE')?.toLowerCase() === 'off') return null;
    const baseUrl = envValue('STT_BASE_URL');
    if (!baseUrl) return null;
    // The engine is fixed to Parakeet, so legacy model ids are not forwarded.
    const storedModel = envValue('STT_MODEL') ?? '';
    const model = /^parakeet/i.test(storedModel)
      ? storedModel
      : DEFAULT_STT_MODEL;
    return {
      baseUrl,
      model,
      apiKey: envValue('STT_API_KEY') ?? null,
    };
  }

  /**
   * Fast `/health` probe. A failure is cached for a minute so a dead LXC costs
   * one probe, not one per voice note; every other engine keeps working.
   */
  private async remoteUsable(target: RemoteSpeechTarget): Promise<boolean> {
    const cached = this.remoteProbe;
    if (cached && Date.now() - cached.at < REMOTE_PROBE_TTL_MS) {
      return cached.ok;
    }
    const url = healthEndpoint(target.baseUrl);
    let ok = false;
    try {
      const response = await httpFetch(
        url,
        sttRequestInit(url, {
          method: 'GET',
          signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
        }),
      );
      ok = response.ok;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      this.logger.warn(
        `STT health probe ${url} failed: ${(error as Error).message}`,
      );
    }
    this.remoteProbe = { at: Date.now(), ok };
    if (!ok) {
      this.logger.warn(
        `Skipping the remote STT engine for ${REMOTE_PROBE_TTL_MS / 1000}s`,
      );
    }
    return ok;
  }

  /** OpenAI-compatible `/v1/audio/transcriptions` call. */
  private async transcribeRemote(
    target: RemoteSpeechTarget,
    input: SpeechInput,
  ): Promise<SpeechResult> {
    const url = remoteEndpoint(target.baseUrl);
    const mime = input.mimeType || 'application/octet-stream';
    const name =
      (input.fileName ? basename(input.fileName) : '') ||
      `voice${this.extensionFor(mime, input.fileName)}`;
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(input.data)], { type: mime }),
      name,
    );
    form.append('model', target.model);
    form.append('response_format', 'json');
    // A language hint is optional; `auto` means the provider default.
    const requested = envValue('STT_LANGUAGE');
    const language = requested && requested !== 'auto' ? requested : null;
    if (language) form.append('language', language);
    const headers: Record<string, string> = {};
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    const response = await httpFetch(
      url,
      sttRequestInit(url, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      }),
    );
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`remote STT answered ${response.status}: ${body}`);
    }
    const payload = (await response.json()) as { text?: unknown };
    return {
      text: collapseWhitespace(
        typeof payload.text === 'string' ? payload.text : '',
      ),
      // The LXC hardcodes `language: "english"`; report only the hint we sent.
      language,
      durationMs: 0,
    };
  }

  private async runParakeet(
    directory: string,
    wavPath: string,
    deadline: number,
  ): Promise<SpeechResult> {
    const recognizer = await this.loadRecognizer();
    const audio = await this.loadWav(wavPath);
    const durationMs = Math.round(
      (audio.samples.length / audio.sampleRate) * 1000,
    );
    const decode = async (
      samples: Float32Array,
      sampleRate: number,
    ): Promise<string> => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate });
      let decoded: { text?: unknown } | undefined;
      if (typeof recognizer.decodeAsync === 'function') {
        decoded = (await recognizer.decodeAsync(stream)) ?? undefined;
      } else {
        recognizer.decode(stream);
      }
      const settled = recognizer.getResult(stream);
      const text =
        typeof decoded?.text === 'string' && decoded.text.trim()
          ? decoded.text
          : typeof settled.text === 'string'
            ? settled.text
            : '';
      return collapseWhitespace(text);
    };

    if (durationMs <= SPLIT_THRESHOLD_MS) {
      return {
        text: await decode(audio.samples, audio.sampleRate),
        // Paraformer/Parakeet do not report a language; do not invent one.
        language: null,
        durationMs,
      };
    }

    const chunks = await this.splitAtSilences(
      wavPath,
      durationMs,
      deadline,
    );
    const texts: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = join(directory, `chunk-${index}.wav`);
      await this.runCommand(
        envValue('FFMPEG_BIN') ?? 'ffmpeg',
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          (chunk.startMs / 1000).toFixed(3),
          '-to',
          (chunk.endMs / 1000).toFixed(3),
          '-i',
          wavPath,
          '-ar',
          String(SAMPLE_RATE),
          '-ac',
          '1',
          chunkPath,
        ],
        deadline - Date.now(),
      );
      const part = await this.loadWav(chunkPath);
      const text = await decode(part.samples, part.sampleRate);
      if (text) texts.push(text);
    }
    return {
      text: collapseWhitespace(texts.join(' ')),
      language: null,
      durationMs,
    };
  }

  /**
   * Picks chunk boundaries from `silencedetect`. A failed scan is not fatal:
   * fixed windows are used instead, so long notes still get transcribed.
   */
  private async splitAtSilences(
    wavPath: string,
    durationMs: number,
    deadline: number,
  ): Promise<SpeechSpan[]> {
    let stderr = '';
    try {
      const result = await this.runCommand(
        envValue('FFMPEG_BIN') ?? 'ffmpeg',
        [
          '-hide_banner',
          '-nostats',
          '-i',
          wavPath,
          '-af',
          SILENCE_FILTER,
          '-f',
          'null',
          '-',
        ],
        deadline - Date.now(),
      );
      stderr = result.stderr;
    } catch (error) {
      this.logger.warn(
        `Silence scan failed, using fixed windows: ${(error as Error).message}`,
      );
    }
    return planChunks(speechSpans(stderr, durationMs), durationMs);
  }

  private async loadWav(path: string): Promise<WavData> {
    if (this.readWaveFile) {
      const wave = this.readWaveFile(path);
      if (!wave) throw new Error(`${basename(path)} is not a readable WAV`);
      return wave;
    }
    const data = readWavSamples(await readFile(path));
    if (!data) throw new Error(`${basename(path)} is not a readable WAV`);
    return data;
  }

  private loadRecognizer(): Promise<ParakeetRecognizer> {
    if (this.recognizer) return Promise.resolve(this.recognizer);
    if (!this.recognizerPromise) {
      this.recognizerPromise = this.parakeetLoader()
        .then((recognizer) => {
          this.recognizer = recognizer;
          return recognizer;
        })
        .catch((error: unknown) => {
          this.recognizerPromise = null;
          throw error;
        });
    }
    return this.recognizerPromise;
  }

  private async runWhisper(
    directory: string,
    wavPath: string,
    deadline: number,
  ): Promise<SpeechResult> {
    const model = absolutePath(
      envValue('WHISPER_MODEL') ?? DEFAULT_WHISPER_MODEL,
    );
    const language = envValue('WHISPER_LANG') ?? 'auto';
    const outputBase = join(directory, 'transcript');
    await this.runCommand(
      envValue('WHISPER_BIN') ?? 'whisper-cli',
      [
        '-m',
        model,
        '-f',
        wavPath,
        '-l',
        language,
        '-oj',
        '-of',
        outputBase,
        '--no-prints',
      ],
      deadline - Date.now(),
    );
    const raw = await readFile(`${outputBase}.json`, 'utf8');
    return parseWhisperJson(raw, language);
  }

  /** Runs one child process, converting timeouts into readable errors. */
  private runCommand(
    file: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const name = basename(file);
    const timeout = Math.max(1, Math.floor(timeoutMs));
    return new Promise((resolvePromise, reject) => {
      childProcess.execFile(
        file,
        args,
        { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) {
            resolvePromise({
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
            });
            return;
          }
          const spawnError = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
          };
          if (spawnError.killed || spawnError.signal) {
            reject(new Error(`${name} timed out after ${timeout} ms`));
            return;
          }
          reject(new Error(`${name} failed: ${spawnError.message}`));
        },
      );
    });
  }

  private extensionFor(mimeType: string, fileName?: string | null): string {
    const byMime = EXTENSION_BY_MIME[mimeType.toLowerCase()];
    if (byMime) return byMime;
    const fromName = fileName ? extname(fileName).toLowerCase() : '';
    return /^\.[a-z0-9]{1,5}$/.test(fromName) ? fromName : '.bin';
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolvePromise) =>
      this.queue.push(resolvePromise),
    );
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  private logFailure(
    bytes: number,
    mime: string,
    reason: string,
    started: number,
  ): void {
    emitLog({
      level: 'warn',
      source: 'ai',
      action: 'speech.transcribe',
      message: `Speech transcription failed: ${reason}`,
      status: 'failed',
      durationMs: Date.now() - started,
      details: { bytes, mime, reason },
    });
  }
}
