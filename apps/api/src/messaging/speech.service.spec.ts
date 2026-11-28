import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, FormData as UndiciFormData, fetch as httpFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '../logs/log-sink.js';
import type { LogInput } from '../logs/log-sink.js';
import {
  NORMALIZE_FILTERS,
  SpeechService,
  normalizeArgs,
  parseWhisperJson,
  planChunks,
  readWavSamples,
  speechSpans,
} from './speech.service.js';
import type { ParakeetRecognizer } from './speech.service.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

/** 16-bit PCM WAV with the given samples, as ffmpeg would write it. */
function wavFile(
  samples: Int16Array,
  sampleRate = 16_000,
  channels = 1,
): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }
  return buffer;
}

const WAV = wavFile(new Int16Array([0, 1000, -1000, 0]));
const INPUT = { data: Buffer.from('voice-bytes'), mimeType: 'audio/ogg' };

interface ExecCall {
  file: string;
  args: string[];
  done: () => void;
}

let execCalls: ExecCall[] = [];

function execFileMock(): void {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null) => void,
  ) => {
    execCalls.push({
      file,
      args,
      done: () => callback(null),
    });
    return {} as never;
  }) as never);
}

/** Executes every child process immediately, in order. */
function execSucceeds(): void {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null) => void,
  ) => {
    execCalls.push({ file, args, done: () => callback(null) });
    callback(null);
    return {} as never;
  }) as never);
}

function execFails(match: string, error: Error): void {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null) => void,
  ) => {
    execCalls.push({ file, args, done: () => callback(error) });
    if (file === match || file.endsWith(`/${match}`)) callback(error);
    else callback(null);
    return {} as never;
  }) as never);
}

function mockReads(json: string | Error, wav: Buffer = WAV): void {
  vi.mocked(readFile).mockImplementation((async (path: unknown) => {
    const name = String(path);
    if (!name.endsWith('.json')) return wav;
    if (json instanceof Error) throw json;
    return json;
  }) as never);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** String form of an undici fetch input (string, URL or Request). */
function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const request = input as { url?: unknown } | null;
  return typeof request?.url === 'string' ? request.url : '';
}

let workdir: string;
let logs: LogInput[];

beforeEach(() => {
  vi.clearAllMocks();
  execCalls = [];
  logs = [];
  setLogSink((entry) => logs.push(entry));
  vi.mocked(mkdtemp).mockResolvedValue('/tmp/combain-speech-test');
  vi.mocked(writeFile).mockResolvedValue(undefined);
  vi.mocked(rm).mockResolvedValue(undefined);
  mockReads('{"text":"привет"}');
  execFileMock();

  // A model file that exists, so `available()` is true on a clean machine.
  workdir = mkdtempSync(join(tmpdir(), 'speech-spec-'));
  writeFileSync(join(workdir, 'ggml-small.bin'), 'model');
  mkdirSync(join(workdir, 'parakeet'), { recursive: true });
  for (const name of [
    'encoder.int8.onnx',
    'decoder.int8.onnx',
    'joiner.int8.onnx',
    'tokens.txt',
  ]) {
    writeFileSync(join(workdir, 'parakeet', name), 'x');
  }
  vi.stubEnv('STT_ENGINE', 'whisper');
  vi.stubEnv('STT_REMOTE', 'off');
  vi.stubEnv('STT_LOCAL_FALLBACK', '');
  vi.stubEnv('WHISPER_BIN', 'whisper-cli');
  vi.stubEnv('WHISPER_MODEL', join(workdir, 'ggml-small.bin'));
  vi.stubEnv('PARAKEET_MODEL_DIR', join(workdir, 'missing-parakeet'));
  vi.stubEnv('FFMPEG_BIN', 'ffmpeg');
  delete process.env.WHISPER_TIMEOUT_MS;
});

afterEach(() => {
  setLogSink(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpeechService.transcribe (whisper engine)', () => {
  it('joins whisper segments and collapses whitespace', async () => {
    mockReads(
      JSON.stringify({
        transcription: [
          { text: '  привет,  как ', timestamps: { to: '00:00:01,500' } },
          { text: 'дела?', timestamps: { to: '00:00:03,000' } },
        ],
        result: { language: 'ru' },
      }),
    );
    execSucceeds();
    const service = new SpeechService();

    const result = await service.transcribe(INPUT);

    expect(result).toEqual({
      text: 'привет, как дела?',
      language: 'ru',
      durationMs: 3000,
    });
    expect(execCalls.map((call) => call.file)).toEqual([
      'ffmpeg',
      'whisper-cli',
    ]);
    expect(execCalls[0].args).toEqual(
      expect.arrayContaining(['-ar', '16000', '-ac', '1']),
    );
    expect(execCalls[1].args).toEqual(
      expect.arrayContaining([
        '-m',
        join(workdir, 'ggml-small.bin'),
        '-oj',
        '--no-prints',
        '-l',
        'auto',
      ]),
    );
    expect(vi.mocked(rm)).toHaveBeenCalledWith(
      '/tmp/combain-speech-test',
      expect.objectContaining({ recursive: true }),
    );
    const success = logs.find((entry) => entry.status === 'ok');
    expect(success).toMatchObject({
      action: 'speech.transcribe',
      source: 'ai',
      details: {
        engine: 'whisper',
        bytes: INPUT.data.length,
        ms: expect.any(Number),
        chars: 17,
      },
    });
  });

  it('returns null when ffmpeg fails', async () => {
    execFails('ffmpeg', new Error('ffmpeg failed: invalid data'));
    const service = new SpeechService();

    await expect(service.transcribe(INPUT)).resolves.toBeNull();

    expect(execCalls.map((call) => call.file)).toEqual(['ffmpeg']);
    expect(logs.at(-1)).toMatchObject({
      status: 'failed',
      action: 'speech.transcribe',
      details: expect.objectContaining({
        reason: expect.stringContaining('ffmpeg failed'),
      }),
    });
  });

  it('returns null when the CLI fails', async () => {
    execFails('whisper-cli', new Error('whisper-cli failed: bad model'));
    const service = new SpeechService();

    await expect(service.transcribe(INPUT)).resolves.toBeNull();

    expect(logs.at(-1)?.message).toContain('whisper-cli failed');
  });

  it('returns null when the CLI times out', async () => {
    execFails(
      'whisper-cli',
      Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }),
    );
    const service = new SpeechService();

    await expect(service.transcribe(INPUT)).resolves.toBeNull();

    expect(logs.at(-1)?.message).toContain('timed out');
  });

  it('rejects input over the 25 MB limit without spawning anything', async () => {
    const service = new SpeechService();
    const data = Buffer.alloc(25 * 1024 * 1024 + 1);

    await expect(
      service.transcribe({ data, mimeType: 'audio/ogg' }),
    ).resolves.toBeNull();

    expect(execFile).not.toHaveBeenCalled();
    expect(logs.at(-1)?.message).toContain('limit is');
  });

  it('returns null for an empty transcript and still cleans the temp dir', async () => {
    mockReads(JSON.stringify({ transcription: [{ text: '   ' }] }));
    execSucceeds();
    const service = new SpeechService();

    await expect(service.transcribe(INPUT)).resolves.toBeNull();

    expect(logs.at(-1)?.message).toContain('no text');
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
  });

  it('returns null when no engine is installed', async () => {
    vi.stubEnv('WHISPER_MODEL', join(workdir, 'absent.bin'));
    const service = new SpeechService();

    expect(service.available()).toBe(false);
    await expect(service.transcribe(INPUT)).resolves.toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('runs at most two jobs at once and queues the rest', async () => {
    mockReads('{"text":"ok"}');
    const service = new SpeechService();

    const first = service.transcribe(INPUT);
    const second = service.transcribe(INPUT);
    const third = service.transcribe(INPUT);
    await flush();

    const ffmpegCalls = (): number =>
      execCalls.filter((call) => call.file === 'ffmpeg').length;
    expect(ffmpegCalls()).toBe(2);

    // Let everything finish: queued calls resolve through the live mock.
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      callback(null);
      return {} as never;
    }) as never);
    for (let index = 0; index < 20 && execCalls.length > 0; index += 1) {
      execCalls.shift()?.done();
      await flush();
    }
    await Promise.all([first, second, third]);
  });
});

describe('SpeechService.transcribe (parakeet engine)', () => {
  function fakeRecognizer(text: string, language = 'ru'): {
    recognizer: ParakeetRecognizer;
    samples: number[];
  } {
    const samples: number[] = [];
    const recognizer: ParakeetRecognizer = {
      createStream: () => ({
        acceptWaveform: (input) => {
          samples.push(input.samples.length, input.sampleRate);
        },
      }),
      decode: vi.fn(),
      getResult: vi.fn(() => ({ text, lang: language })),
    };
    return { recognizer, samples };
  }

  function useParakeet(): SpeechService {
    vi.stubEnv('STT_ENGINE', 'parakeet');
    vi.stubEnv('PARAKEET_MODEL_DIR', join(workdir, 'parakeet'));
    const service = new SpeechService();
    return service;
  }

  it('reads the WAV samples, decodes and reports duration', async () => {
    const samples = new Int16Array(8000);
    mockReads('{}', wavFile(samples));
    execSucceeds();
    const service = useParakeet();
    const fake = fakeRecognizer('  привет   мир ');
    service.setParakeetLoader(async () => fake.recognizer);

    expect(service.available()).toBe(true);
    const result = await service.transcribe(INPUT);

    expect(result).toEqual({
      text: 'привет мир',
      // The Parakeet model does not report a language; nothing is invented.
      language: null,
      durationMs: 500,
    });
    expect(fake.samples).toEqual([8000, 16_000]);
    // Only ffmpeg runs; the CLI is never needed.
    expect(execCalls.map((call) => call.file)).toEqual(['ffmpeg']);
  });

  it('loads the recognizer once for several notes', async () => {
    mockReads('{}', WAV);
    execSucceeds();
    const service = useParakeet();
    const fake = fakeRecognizer('раз');
    const loader = vi.fn(async () => fake.recognizer);
    service.setParakeetLoader(loader);

    await service.transcribe(INPUT);
    await service.transcribe(INPUT);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('splits long audio at silences and joins the chunk texts', async () => {
    const longWav = wavFile(new Int16Array(30 * 16_000));
    vi.mocked(readFile).mockImplementation((async (path: unknown) => {
      const name = String(path);
      if (name.includes('chunk-')) return wavFile(new Int16Array(8000));
      return longWav;
    }) as never);
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      if (args.includes('silencedetect=noise=-45dB:d=0.25')) {
        callback(
          null,
          '',
          [
            '[silencedetect @ 0x1] silence_start: 12',
            '[silencedetect @ 0x1] silence_end: 16 | silence_duration: 4',
          ].join('\n'),
        );
      } else {
        callback(null, '', '');
      }
      return {} as never;
    }) as never);
    const service = useParakeet();
    const fake = fakeRecognizer('часть');
    service.setParakeetLoader(async () => fake.recognizer);

    const result = await service.transcribe(INPUT);

    expect(result).toEqual({
      text: 'часть часть',
      language: null,
      durationMs: 30_000,
    });
    // Two chunk decodes, each read back as its own 0.5 s WAV.
    expect(fake.samples).toEqual([8000, 16_000, 8000, 16_000]);
  });

  it('stays on the local engine when parakeet cannot start (auto → local)', async () => {
    vi.stubEnv('STT_ENGINE', 'auto');
    vi.stubEnv('PARAKEET_MODEL_DIR', join(workdir, 'parakeet'));
    mockReads(
      JSON.stringify({ transcription: [{ text: 'из виспера' }] }),
    );
    execSucceeds();
    const service = new SpeechService();
    service.setParakeetLoader(async () => {
      throw new Error('native module missing');
    });

    const result = await service.transcribe(INPUT);

    // `auto` with STT_REMOTE=off maps to `local`, which never uses whisper.
    expect(result).toBeNull();
    expect(execCalls.map((call) => call.file)).toEqual(['ffmpeg']);
  });
});

describe('SpeechService remote engine', () => {
  const fetchMock = vi.mocked(httpFetch);

  beforeEach(() => {
    vi.stubEnv('STT_ENGINE', 'remote');
    vi.stubEnv('STT_REMOTE', '');
    vi.stubEnv('STT_BASE_URL', 'https://stt.example/v1');
    vi.stubEnv('STT_MODEL', 'parakeet-tdt-0.6b-v3');
    vi.stubEnv('STT_API_KEY', 'secret');
    vi.stubEnv('STT_LANGUAGE', '');
    execSucceeds();
    mockReads('{"text":"из виспера"}');
  });

  function respond(
    options: { health?: boolean; text?: string; post?: Error } = {},
  ): void {
    fetchMock.mockImplementation((async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/health')) {
        return {
          ok: options.health ?? true,
          body: { cancel: async () => undefined },
        } as unknown as Response;
      }
      if (options.post) throw options.post;
      return {
        ok: true,
        json: async () => ({
          text: options.text ?? '  удалённая   расшифровка ',
        }),
      } as unknown as Response;
    }) as never);
  }

  function urls(): string[] {
    return fetchMock.mock.calls.map(([input]) => urlOf(input));
  }

  function postBody(): UndiciFormData {
    return (fetchMock.mock.calls[1][1] as { body: UndiciFormData }).body;
  }

  /** The multipart `file` part as undici stores it (a File-like Blob). */
  function postedFile(): { name?: string; type: string; size: number } {
    return postBody().get('file') as unknown as {
      name?: string;
      type: string;
      size: number;
    };
  }

  /** ffmpeg mock that fails only for the given filter, as a broken pass would. */
  function failFilter(filter: string): void {
    vi.mocked(execFile).mockImplementation(((
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      execCalls.push({ file, args, done: () => callback(null) });
      const filterIndex = args.indexOf('-af');
      const used = filterIndex >= 0 ? args[filterIndex + 1] : '';
      callback(used === filter ? new Error('ffmpeg failed: invalid data') : null);
      return {} as never;
    }) as never);
  }

  it('uses an OpenAI-compatible endpoint before the local engines', async () => {
    const service = new SpeechService();
    respond();

    const result = await service.transcribe(INPUT);

    expect(result).toEqual({
      text: 'удалённая расшифровка',
      // No language hint was configured, so none is invented.
      language: null,
      durationMs: 0,
    });
    expect(execCalls.map((call) => call.file)).toEqual(['ffmpeg']);
    expect(execCalls[0].args).toEqual(
      expect.arrayContaining([
        '-af',
        'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        'wav',
      ]),
    );
    expect(urls()).toEqual([
      'https://stt.example/health',
      'https://stt.example/v1/audio/transcriptions',
    ]);
    const posted = postedFile();
    expect(posted.type).toBe('audio/wav');
    expect(posted.name).toBe('voice.wav');
    expect(posted.size).toBe(WAV.length);
    const init = fetchMock.mock.calls[1][1] as {
      dispatcher?: unknown;
      headers?: unknown;
      body?: unknown;
    };
    // A public host keeps the default egress path.
    expect(init.dispatcher).toBeUndefined();
    expect(init.headers).toEqual({ authorization: 'Bearer secret' });
    expect(init.body).toBeInstanceOf(UndiciFormData);
    expect(logs.at(-1)).toMatchObject({
      status: 'ok',
      details: {
        engine: 'remote',
        bytes: INPUT.data.length,
        ms: expect.any(Number),
        chars: 'удалённая расшифровка'.length,
      },
    });
  });

  it('sends no Authorization header when STT_API_KEY is empty', async () => {
    vi.stubEnv('STT_API_KEY', '');
    const service = new SpeechService();
    respond();

    await service.transcribe(INPUT);

    const init = fetchMock.mock.calls[1][1] as { headers?: unknown };
    expect(init.headers).toEqual({});
  });

  it('forwards STT_MODEL and STT_LANGUAGE', async () => {
    vi.stubEnv('STT_LANGUAGE', 'ru');
    vi.stubEnv('STT_MODEL', 'parakeet-tdt-0.6b-v3');
    const service = new SpeechService();
    respond();

    const result = await service.transcribe(INPUT);

    expect(postBody().get('model')).toBe('parakeet-tdt-0.6b-v3');
    expect(postBody().get('language')).toBe('ru');
    expect(result?.language).toBe('ru');
  });

  it('uses the built-in Parakeet model name for a foreign STT_MODEL', async () => {
    vi.stubEnv('STT_MODEL', 'whisper-1');
    const service = new SpeechService();
    respond();

    await service.transcribe(INPUT);

    expect(postBody().get('model')).toBe('parakeet-tdt-0.6b-v3');
  });

  it('bypasses the proxy for a LAN address', async () => {
    vi.stubEnv('STT_BASE_URL', 'http://192.168.31.108:5092');
    const service = new SpeechService();
    respond();

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('удалённая расшифровка');
    expect(urls()).toEqual([
      'http://192.168.31.108:5092/health',
      'http://192.168.31.108:5092/v1/audio/transcriptions',
    ]);
    const health = fetchMock.mock.calls[0][1] as { dispatcher?: unknown };
    const post = fetchMock.mock.calls[1][1] as { dispatcher?: unknown };
    expect(health.dispatcher).toBeInstanceOf(Agent);
    expect(post.dispatcher).toBeInstanceOf(Agent);
  });

  it('falls back to dynaudnorm when loudnorm fails', async () => {
    failFilter('loudnorm=I=-16:TP=-1.5:LRA=11');
    const service = new SpeechService();
    respond();

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('удалённая расшифровка');
    expect(
      execCalls.map((call) => call.args[call.args.indexOf('-af') + 1]),
    ).toEqual([...NORMALIZE_FILTERS]);
    expect(postedFile().type).toBe('audio/wav');
  });

  it('sends the original file when every normalize pass fails', async () => {
    vi.mocked(execFile).mockImplementation(((
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      execCalls.push({ file, args, done: () => callback(null) });
      callback(new Error('ffmpeg failed: invalid data'));
      return {} as never;
    }) as never);
    const service = new SpeechService();
    respond();

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('удалённая расшифровка');
    expect(execCalls).toHaveLength(NORMALIZE_FILTERS.length);
    const posted = postedFile();
    expect(posted.type).toBe('audio/ogg');
    expect(posted.name).toBe('voice.ogg');
    expect(posted.size).toBe(INPUT.data.length);
  });

  it('sends the original file when ffmpeg is not installed', async () => {
    vi.stubEnv('FFMPEG_BIN', '/nope/ffmpeg');
    const service = new SpeechService();
    respond();

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('удалённая расшифровка');
    expect(execFile).not.toHaveBeenCalled();
    expect(postedFile().type).toBe('audio/ogg');
  });

  it('returns null when STT_ENGINE=disabled', async () => {
    vi.stubEnv('STT_ENGINE', 'disabled');
    const service = new SpeechService();

    expect(service.available()).toBe(false);
    await expect(service.transcribe(INPUT)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('degrades gracefully when no engine is configured', async () => {
    vi.stubEnv('STT_ENGINE', '');
    vi.stubEnv('STT_REMOTE', 'off');
    vi.stubEnv('STT_BASE_URL', '');
    vi.stubEnv('PARAKEET_MODEL_DIR', join(workdir, 'missing-parakeet'));
    const service = new SpeechService();

    expect(service.available()).toBe(false);
    await expect(service.transcribe(INPUT)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('does not fall back locally after a failed health probe', async () => {
    const service = new SpeechService();
    respond({ health: false });

    await service.transcribe(INPUT);
    await service.transcribe(INPUT);

    expect(urls().filter((url) => url.endsWith('/health'))).toHaveLength(1);
    expect(urls().some((url) => url.includes('transcriptions'))).toBe(false);
    // Remote-only by default: a dead endpoint must be visible, not masked.
    expect(execFile).not.toHaveBeenCalled();
  });

  it('does not fail over to a local engine by default', async () => {
    const service = new SpeechService();
    respond({ post: new Error('connect ECONNREFUSED') });

    const result = await service.transcribe(INPUT);

    expect(result).toBeNull();
    expect(execCalls.map((call) => call.file)).not.toContain('whisper-cli');
  });

  it('returns null when the remote endpoint returns no text', async () => {
    const service = new SpeechService();
    respond({ text: '   ' });

    const result = await service.transcribe(INPUT);

    expect(result).toBeNull();
  });

  it('restores the local chain only with STT_LOCAL_FALLBACK=on', async () => {
    vi.stubEnv('STT_LOCAL_FALLBACK', 'on');
    const service = new SpeechService();
    respond({ post: new Error('remote is down') });

    const result = await service.transcribe(INPUT);

    // Parakeet is not installed in this sandbox, so whisper is the last resort.
    expect(result?.text).toBe('из виспера');
    expect(execCalls.map((call) => call.file)).toContain('whisper-cli');
  });
});

describe('SpeechService engine selection from STT_ENGINE', () => {
  const fetchMock = vi.mocked(httpFetch);

  beforeEach(() => {
    vi.stubEnv('STT_ENGINE', '');
    vi.stubEnv('STT_REMOTE', 'on');
    vi.stubEnv('STT_BASE_URL', '');
    vi.stubEnv('STT_MODEL', '');
    vi.stubEnv('STT_API_KEY', '');
    execSucceeds();
  });

  function respond(
    options: { health?: boolean; text?: string; post?: Error } = {},
  ): void {
    fetchMock.mockImplementation((async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/health')) {
        return {
          ok: options.health ?? true,
          body: { cancel: async () => undefined },
        } as unknown as Response;
      }
      if (options.post) throw options.post;
      return {
        ok: true,
        json: async () => ({ text: options.text ?? 'из сети' }),
      } as unknown as Response;
    }) as never);
  }

  function parakeetFake(text = 'местный движок'): {
    recognizer: ParakeetRecognizer;
    loader: ReturnType<typeof vi.fn>;
  } {
    const recognizer: ParakeetRecognizer = {
      createStream: () => ({ acceptWaveform: () => undefined }),
      decode: vi.fn(),
      getResult: vi.fn(() => ({ text })),
    };
    return { recognizer, loader: vi.fn(async () => recognizer) };
  }

  it('auto without STT_BASE_URL uses local Parakeet only', async () => {
    vi.stubEnv('PARAKEET_MODEL_DIR', join(workdir, 'parakeet'));
    mockReads('{}', WAV);
    const fake = parakeetFake();
    const service = new SpeechService();
    service.setParakeetLoader(fake.loader);

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('местный движок');
    expect(httpFetch).not.toHaveBeenCalled();
    expect(fake.loader).toHaveBeenCalledTimes(1);
    expect(execCalls.every((call) => call.file === 'ffmpeg')).toBe(true);
  });

  it('auto with STT_BASE_URL uses the endpoint', async () => {
    vi.stubEnv('STT_ENGINE', 'auto');
    vi.stubEnv('STT_BASE_URL', 'https://stt.example/v1');
    const service = new SpeechService();
    respond();

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('из сети');
    expect(execCalls.map((call) => call.file)).toEqual(['ffmpeg']);
  });

  it('STT_REMOTE=off maps auto to local Parakeet', async () => {
    vi.stubEnv('STT_REMOTE', 'off');
    vi.stubEnv('PARAKEET_MODEL_DIR', join(workdir, 'parakeet'));
    mockReads('{}', WAV);
    const fake = parakeetFake('только локально');
    const service = new SpeechService();
    service.setParakeetLoader(fake.loader);

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('только локально');
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('maps STT_ENGINE=parakeet to the local recognizer', async () => {
    vi.stubEnv('STT_ENGINE', 'parakeet');
    vi.stubEnv('PARAKEET_MODEL_DIR', join(workdir, 'parakeet'));
    mockReads('{}', WAV);
    const fake = parakeetFake('через env');
    const service = new SpeechService();
    service.setParakeetLoader(fake.loader);

    await expect(service.transcribe(INPUT)).resolves.toMatchObject({
      text: 'через env',
    });
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('lets STT_ENGINE win over a configured STT_BASE_URL', async () => {
    vi.stubEnv('STT_ENGINE', 'whisper');
    vi.stubEnv('STT_BASE_URL', 'https://stt.example/v1');
    mockReads('{"text":"из виспера"}');
    const fake = parakeetFake();
    const service = new SpeechService();
    service.setParakeetLoader(fake.loader);

    const result = await service.transcribe(INPUT);

    expect(result?.text).toBe('из виспера');
    expect(fake.loader).not.toHaveBeenCalled();
    expect(httpFetch).not.toHaveBeenCalled();
  });
});


describe('speechSpans', () => {
  it('turns silencedetect output into speech regions', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 12.5',
      '[silencedetect @ 0x1] silence_end: 16 | silence_duration: 3.5',
    ].join('\n');

    expect(speechSpans(stderr, 20_000)).toEqual([
      { startMs: 0, endMs: 12_500 },
      { startMs: 16_000, endMs: 20_000 },
    ]);
  });

  it('closes a trailing silence at the clip end', () => {
    expect(speechSpans('[silencedetect] silence_start: 4', 10_000)).toEqual([
      { startMs: 0, endMs: 4000 },
    ]);
  });
});

describe('planChunks', () => {
  it('groups short speech spans into one window', () => {
    expect(
      planChunks(
        [
          { startMs: 0, endMs: 5000 },
          { startMs: 6000, endMs: 9000 },
        ],
        12_000,
      ),
    ).toEqual([{ startMs: 0, endMs: 9000 }]);
  });

  it('starts a new window when the gap would overflow', () => {
    expect(
      planChunks(
        [
          { startMs: 0, endMs: 12_000 },
          { startMs: 16_000, endMs: 30_000 },
        ],
        30_000,
      ),
    ).toEqual([
      { startMs: 0, endMs: 12_000 },
      { startMs: 16_000, endMs: 30_000 },
    ]);
  });

  it('cuts one long span into fixed windows', () => {
    expect(planChunks([{ startMs: 0, endMs: 32_000 }], 32_000)).toEqual([
      { startMs: 0, endMs: 15_000 },
      { startMs: 15_000, endMs: 30_000 },
      { startMs: 30_000, endMs: 32_000 },
    ]);
  });

  it('falls back to fixed windows without speech spans', () => {
    expect(planChunks([], 20_000)).toEqual([
      { startMs: 0, endMs: 15_000 },
      { startMs: 15_000, endMs: 20_000 },
    ]);
  });

  it('caps the number of chunks', () => {
    const chunks = planChunks(
      Array.from({ length: 100 }, (_, index) => ({
        startMs: index * 20_000,
        endMs: index * 20_000 + 5000,
      })),
      2_000_000,
    );
    expect(chunks).toHaveLength(40);
  });
});

describe('normalizeArgs', () => {
  it('builds a loudness-normalized 16 kHz mono WAV pass with a duration cap', () => {
    const args = normalizeArgs('/tmp/in.ogg', '/tmp/out.wav', 'loudnorm=I=-16');

    expect(args).toEqual([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '/tmp/in.ogg',
      '-t',
      '600',
      '-af',
      'loudnorm=I=-16',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      '/tmp/out.wav',
    ]);
  });
});

describe('parseWhisperJson', () => {
  it('accepts a plain { text } result', () => {
    expect(parseWhisperJson('{"text":"  hello  world "}', 'auto')).toEqual({
      text: 'hello world',
      language: null,
      durationMs: 0,
    });
  });

  it('uses the requested language when the engine does not detect one', () => {
    expect(parseWhisperJson('{"text":"привет"}', 'ru').language).toBe('ru');
  });

  it('prefers offsets over timestamps for the duration', () => {
    const result = parseWhisperJson(
      JSON.stringify({
        transcription: [
          {
            text: 'a',
            timestamps: { from: '00:00:00,000', to: '00:00:01,000' },
            offsets: { from: 0, to: 2500 },
          },
        ],
      }),
      'auto',
    );
    expect(result.durationMs).toBe(2500);
  });

  it('throws on garbage so the caller can log a failure', () => {
    expect(() => parseWhisperJson('not json', 'auto')).toThrow();
  });
});

describe('readWavSamples', () => {
  it('converts 16-bit PCM to floats', () => {
    const wav = wavFile(new Int16Array([0, 16384, -16384, 32767]));
    const data = readWavSamples(wav);

    expect(data?.sampleRate).toBe(16_000);
    expect(data?.samples[0]).toBe(0);
    expect(data?.samples[1]).toBeCloseTo(0.5, 5);
    expect(data?.samples[2]).toBeCloseTo(-0.5, 5);
    expect(data?.samples[3]).toBeCloseTo(0.999_97, 4);
  });

  it('returns null for a non-WAV buffer', () => {
    expect(readWavSamples(Buffer.from('definitely not a wav'))).toBeNull();
  });
});
