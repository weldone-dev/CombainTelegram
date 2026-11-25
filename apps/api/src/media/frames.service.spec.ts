import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { FramesService } from './frames.service.js';

/** 1×1 transparent PNG, enough to prove the base64 round-trip works. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type Exec = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

interface Internals {
  exec: Exec;
  chrome(): string | null;
  lottie(): string | null;
}

/** Service whose process calls are replaced by `exec`. */
function serviceWith(exec: Exec): {
  service: FramesService;
  internals: Internals;
  execSpy: ReturnType<typeof vi.fn>;
} {
  const service = new FramesService();
  const internals = service as unknown as Internals;
  const execSpy = vi.fn(exec);
  internals.exec = execSpy as unknown as Exec;
  return { service, internals, execSpy };
}

/** Fake ffmpeg that writes `bytes` to the last path argument. */
function writesOutput(bytes: Buffer): Exec {
  return async (command, args) => {
    if (command === 'ffprobe') return { stdout: '2.000000\n', stderr: '' };
    await writeFile(args[args.length - 1] as string, bytes);
    return { stdout: '', stderr: '' };
  };
}

function tgs(json: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
}

describe('FramesService.collage', () => {
  it('renders video media with evenly spaced frames tiled 3×3', async () => {
    const { service, execSpy } = serviceWith(writesOutput(Buffer.from('jpeg')));

    const result = await service.collage({
      data: Buffer.from('fake video bytes'),
      mimeType: 'video/mp4',
    });

    expect(result?.toString()).toBe('jpeg');
    const ffmpeg = execSpy.mock.calls.find(([command]) => command === 'ffmpeg');
    expect(ffmpeg).toBeDefined();
    const args = (ffmpeg?.[1] ?? []).join(' ');
    // 9 frames over a 2 s clip.
    expect(args).toContain('fps=4.5000');
    expect(args).toContain('scale=256:256');
    expect(args).toContain('tile=3x3:color=white');
    expect(args).toContain('-frames:v 1');
  });

  it('falls back to one frame per second when the duration is unknown', async () => {
    const { service, execSpy } = serviceWith(async (command, args) => {
      if (command === 'ffprobe') throw new Error('no duration');
      await writeFile(args[args.length - 1] as string, Buffer.from('jpeg'));
      return { stdout: '', stderr: '' };
    });

    const result = await service.collage({
      data: Buffer.from('a gif'),
      mimeType: 'image/gif',
    });

    expect(result?.toString()).toBe('jpeg');
    const args = (
      (execSpy.mock.calls.find(([command]) => command === 'ffmpeg')?.[1] ??
        []) as string[]
    ).join(' ');
    expect(args).toContain('fps=1.0000');
  });

  it('returns null when ffmpeg fails', async () => {
    const { service } = serviceWith(async (command) => {
      if (command === 'ffprobe') return { stdout: '2\n', stderr: '' };
      throw new Error('ffmpeg exploded');
    });

    await expect(
      service.collage({ data: Buffer.from('broken'), mimeType: 'video/webm' }),
    ).resolves.toBeNull();
  });

  it('rejects unsupported mime types and empty input', async () => {
    const { service, execSpy } = serviceWith(writesOutput(Buffer.from('x')));

    await expect(
      service.collage({ data: Buffer.from('pdf'), mimeType: 'application/pdf' }),
    ).resolves.toBeNull();
    await expect(
      service.collage({ data: Buffer.alloc(0), mimeType: 'video/mp4' }),
    ).resolves.toBeNull();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('renders .tgs through headless Chrome and encodes the PNG as JPEG', async () => {
    const lottiePath = createRequire(import.meta.url).resolve('lottie-web');
    let page = '';
    const { service, internals, execSpy } = serviceWith(async (command, args) => {
      if (command === 'ffmpeg') {
        await writeFile(args[args.length - 1] as string, Buffer.from('jpeg'));
        return { stdout: '', stderr: '' };
      }
      page = await readFile(
        (args.find((arg) => arg.startsWith('file://')) as string).slice(
          'file://'.length,
        ),
        'utf8',
      );
      return {
        stdout: `<div data-ready="1" data-png="data:image/png;base64,${PNG.toString('base64')}"></div>`,
        stderr: '',
      };
    });
    internals.chrome = () => '/usr/bin/google-chrome';
    internals.lottie = () => lottiePath;

    const result = await service.collage({
      data: tgs({ v: '5.7.4', fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [] }),
      mimeType: 'application/x-tgsticker',
    });

    expect(result?.toString()).toBe('jpeg');
    expect(execSpy.mock.calls[0]?.[0]).toBe('/usr/bin/google-chrome');
    const chromeArgs = (execSpy.mock.calls[0]?.[1] ?? []).join(' ');
    expect(chromeArgs).toContain('--dump-dom');
    expect(chromeArgs).toContain('--virtual-time-budget=');
    // The page really embeds lottie-web and the sticker animation data.
    expect(page).toContain('lottie.loadAnimation');
    expect(page).toContain('animationData');
    expect(page).toContain('goToAndStop');
  });

  it('returns null for a broken .tgs payload', async () => {
    const { service, execSpy } = serviceWith(writesOutput(Buffer.from('jpeg')));

    await expect(
      service.collage({
        data: Buffer.from('not gzip'),
        mimeType: 'application/x-tgsticker',
      }),
    ).resolves.toBeNull();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns null when Chrome renders no canvas', async () => {
    const lottiePath = createRequire(import.meta.url).resolve('lottie-web');
    const { service, internals } = serviceWith(async (command) => {
      if (command === 'ffmpeg') return { stdout: '', stderr: '' };
      return { stdout: '<div data-error="boom"></div>', stderr: '' };
    });
    internals.chrome = () => '/usr/bin/google-chrome';
    internals.lottie = () => lottiePath;

    await expect(
      service.collage({
        data: tgs({ v: '5.7.4', fr: 30, ip: 0, op: 30, w: 10, h: 10 }),
        mimeType: 'application/x-tgsticker',
      }),
    ).resolves.toBeNull();
  });

  it('serves a cached collage without rendering twice', async () => {
    const { service, execSpy } = serviceWith(writesOutput(Buffer.from('jpeg')));
    const input = { data: Buffer.from('same bytes'), mimeType: 'video/mp4' };

    const first = await service.collage(input);
    const callsAfterFirst = execSpy.mock.calls.length;
    const second = await service.collage(input);

    expect(second).toBe(first);
    expect(execSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});
