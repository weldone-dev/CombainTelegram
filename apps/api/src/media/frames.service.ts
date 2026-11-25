/**
 * Frame-collage rendering for animated media.
 *
 * A vision model cannot watch a `.tgs`/`.webm` sticker or a GIF: it sees one
 * image per request. This service turns such media into a single JPEG holding
 * a 3×3 grid of frames in chronological order, so the model can judge the
 * motion (a pig sticker that starts pink and ends dancing, for example).
 *
 * Two engines back the same contract:
 * - `ffmpeg` for video/GIF inputs (evenly spaced frames, `tile=3x3`);
 * - headless Chrome + `lottie-web` for gzipped Lottie `.tgs` stickers.
 *
 * The service never throws: any failure is a `null` plus one `media.frames`
 * log line, so the caller can fall back to a static thumbnail.
 */

import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { emitLog } from '../logs/log-sink.js';
import { normalizeMimeType } from '../messaging/media.js';

/** One cell of the grid, pixels. */
const CELL_PX = 256;
/** Frames in the grid: 3×3. */
const FRAMES = 9;
/** Grid side in pixels (768). */
const GRID_PX = CELL_PX * 3;
/** Hard cap for the returned JPEG, bytes. */
const MAX_COLLAGE_BYTES = 1024 * 1024;
/** Attempts are bounded so one broken file cannot stall the autopilot. */
const FFMPEG_TIMEOUT_MS = 15_000;
const CHROME_TIMEOUT_MS = 10_000;
/** Rendered collages kept in memory, keyed by the input hash. */
const CACHE_MAX_ENTRIES = 100;
/** TGS files are gzipped Lottie JSON; real ones stay well under this. */
const MAX_TGS_BYTES = 20 * 1024 * 1024;

const TGS_MIME = 'application/x-tgsticker';
const VIDEO_MIMES = new Set(['video/webm', 'video/mp4', 'image/gif']);
/** Still images that may also be asked for a collage (single big frame). */
const IMAGE_MIMES = new Set(['image/webp', 'image/jpeg', 'image/png']);

export interface FramesInput {
  data: Buffer;
  mimeType: string;
}

type ExecResult = { stdout: string; stderr: string };

/** `path` of the bundled Lottie browser build, or `null` when unavailable. */
function lottieScriptPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // `lottie-web` resolves to `build/player/lottie.js`; the minified build is
    // a sibling and keeps the temporary HTML small.
    const resolved = require.resolve('lottie-web');
    const minified = resolved.replace(/lottie(?:\.min)?\.js$/, 'lottie.min.js');
    return existsSync(minified) ? minified : resolved;
  } catch {
    return null;
  }
}

/** Headless Chrome binary: explicit env override, then the usual names. */
function chromeBinary(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** File extension used for a temporary input file. */
function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'video/webm':
      return 'webm';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    default:
      return 'mp4';
  }
}

/** Seconds from ffprobe output, or `null` when it cannot be read. */
function parseDuration(stdout: string): number | null {
  const value = Number.parseFloat(stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Script-safe JSON: `</script>` inside a string must not close the tag. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

@Injectable()
export class FramesService {
  /** LRU of rendered collages, keyed by the sha1 of the input bytes. */
  private readonly cache = new Map<string, Buffer>();
  private lottieScript: string | null | undefined;

  /**
   * One JPEG with up to {@link FRAMES} evenly spaced frames of `input`.
   * Returns `null` for unsupported media and for any rendering failure.
   */
  async collage(input: FramesInput): Promise<Buffer | null> {
    const started = Date.now();
    const mimeType = normalizeMimeType(input.mimeType, '');
    const engine = mimeType === TGS_MIME ? 'chrome' : 'ffmpeg';
    const key =
      input.data && input.data.byteLength > 0
        ? createHash('sha1').update(input.data).digest('hex')
        : null;

    if (key) {
      const cached = this.cache.get(key);
      if (cached) {
        // Refresh LRU position without re-rendering.
        this.cache.delete(key);
        this.cache.set(key, cached);
        emitLog({
          level: 'debug',
          source: 'media',
          action: 'media.frames',
          message: `Served a cached ${cached.byteLength}-byte collage (${mimeType || 'unknown'})`,
          status: 'ok',
          durationMs: Date.now() - started,
          details: {
            mime: mimeType,
            bytes: cached.byteLength,
            ms: Date.now() - started,
            engine,
            ok: true,
            cached: true,
          },
        });
        return cached;
      }
    }

    let result: Buffer | null = null;
    if (key) {
      try {
        if (mimeType === TGS_MIME) {
          result = await this.renderTgs(input.data);
        } else if (VIDEO_MIMES.has(mimeType) || IMAGE_MIMES.has(mimeType)) {
          result = await this.renderVideo(input.data, mimeType);
        }
      } catch {
        // Every branch is best-effort; a null keeps the caller honest.
        result = null;
      }
    }

    if (result && result.byteLength > MAX_COLLAGE_BYTES) result = null;
    if (result && result.byteLength > 0) {
      this.cache.set(key as string, result);
      this.trimCache();
    }

    emitLog({
      level: result ? 'debug' : 'warn',
      source: 'media',
      action: 'media.frames',
      message: result
        ? `Rendered a ${result.byteLength}-byte collage (${mimeType})`
        : `Could not render a collage (${mimeType || 'empty input'})`,
      status: result ? 'ok' : 'failed',
      durationMs: Date.now() - started,
      details: {
        mime: mimeType,
        bytes: result?.byteLength ?? 0,
        ms: Date.now() - started,
        engine,
        ok: result !== null,
      },
    });
    return result;
  }

  private trimCache(): void {
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Runs one binary and captures its output. Rejects on a non-zero exit. */
  protected exec(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              Object.assign(error, { stderr: String(stderr ?? '') }),
            );
            return;
          }
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
  }

  /** Chrome binary used for `.tgs` rendering (overridable in tests). */
  protected chrome(): string | null {
    return chromeBinary();
  }

  /** Lottie browser build path (overridable in tests). */
  protected lottie(): string | null {
    if (this.lottieScript === undefined) this.lottieScript = lottieScriptPath();
    return this.lottieScript;
  }

  /**
   * Evenly spaced frames through ffmpeg. `fps = 9 / duration` samples the whole
   * clip, a white pad keeps every cell square, and `tile` folds them into one
   * 768×768 JPEG in a single pass.
   */
  private async renderVideo(
    data: Buffer,
    mimeType: string,
  ): Promise<Buffer | null> {
    const dir = await mkdtemp(join(tmpdir(), 'tg-frames-'));
    try {
      const inputPath = join(dir, `input.${extensionFor(mimeType)}`);
      await writeFile(inputPath, data);

      const duration = await this.durationOf(inputPath);
      const fps = duration ? Math.min(60, Math.max(0.1, FRAMES / duration)) : 1;
      const outputPath = join(dir, 'collage.jpg');
      const filter = [
        `fps=${fps.toFixed(4)}`,
        `scale=${CELL_PX}:${CELL_PX}:force_original_aspect_ratio=decrease`,
        `pad=${CELL_PX}:${CELL_PX}:(ow-iw)/2:(oh-ih)/2:color=white`,
        'setsar=1',
        `tile=3x3:color=white`,
      ].join(',');

      await this.exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          inputPath,
          '-vf',
          filter,
          '-frames:v',
          '1',
          '-q:v',
          '4',
          outputPath,
        ],
        FFMPEG_TIMEOUT_MS,
      );

      let collage = await readFile(outputPath);
      if (collage.byteLength > MAX_COLLAGE_BYTES) {
        // A busy collage at q=4 can cross 1 MB; a coarser pass keeps the cap.
        await this.exec(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            outputPath,
            '-q:v',
            '12',
            join(dir, 'small.jpg'),
          ],
          FFMPEG_TIMEOUT_MS,
        );
        collage = await readFile(join(dir, 'small.jpg'));
      }
      return collage.byteLength > 0 ? collage : null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Media duration in seconds through ffprobe; `null` when unknown. */
  private async durationOf(path: string): Promise<number | null> {
    try {
      const { stdout } = await this.exec(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          path,
        ],
        5_000,
      );
      return parseDuration(stdout);
    } catch {
      return null;
    }
  }

  /**
   * `.tgs` = gzipped Lottie JSON. The animation is loaded in headless Chrome
   * with the bundled lottie-web build; the page draws nine frames into one
   * 768×768 canvas and exposes it as a PNG data URL in the DOM, which
   * `--dump-dom` hands back. ffmpeg then compresses that PNG to JPEG.
   *
   * A marker attribute (`data-ready`) distinguishes a real render from a blank
   * page, so a broken animation is a `null`, never a white image.
   */
  private async renderTgs(data: Buffer): Promise<Buffer | null> {
    const chrome = this.chrome();
    const lottiePath = this.lottie();
    if (!chrome || !lottiePath) return null;

    let json: unknown;
    try {
      const raw = gunzipSync(data, { maxOutputLength: MAX_TGS_BYTES });
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    if (!json || typeof json !== 'object') return null;

    const lottie = await readFile(lottiePath, 'utf8');
    const html = buildTgsHtml(lottie, json);
    const dir = await mkdtemp(join(tmpdir(), 'tg-tgs-'));
    try {
      const htmlPath = join(dir, 'frames.html');
      await writeFile(htmlPath, html, 'utf8');
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--mute-audio',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${join(dir, 'profile')}`,
        `--window-size=${GRID_PX},${GRID_PX}`,
        '--force-device-scale-factor=1',
        // Chrome renders the timers and rAF callbacks the page uses, then
        // dumps the DOM with the finished canvas inside it.
        `--virtual-time-budget=${Math.max(2_000, CHROME_TIMEOUT_MS - 2_000)}`,
        '--dump-dom',
        `file://${htmlPath}`,
      ];
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        args.unshift('--no-sandbox');
      }
      const { stdout } = await this.exec(chrome, args, CHROME_TIMEOUT_MS);
      if (!/data-ready="1"/.test(stdout)) return null;
      const match = /data-png="data:image\/png;base64,([^"]+)"/.exec(stdout);
      if (!match?.[1]) return null;

      const png = Buffer.from(match[1], 'base64');
      const pngPath = join(dir, 'collage.png');
      const jpgPath = join(dir, 'collage.jpg');
      await writeFile(pngPath, png);
      await this.exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          pngPath,
          '-frames:v',
          '1',
          '-q:v',
          '4',
          jpgPath,
        ],
        FFMPEG_TIMEOUT_MS,
      );
      const jpeg = await readFile(jpgPath);
      return jpeg.byteLength > 0 ? jpeg : null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Temporary page: lottie-web renders into an offscreen canvas, the script
 * copies nine evenly spaced frames into a 3×3 grid and publishes the result
 * as a PNG data URL. White background, no text — just the motion.
 */
function buildTgsHtml(lottie: string, animation: unknown): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden}
#grid{position:absolute;left:0;top:0;width:${GRID_PX}px;height:${GRID_PX}px}
</style></head>
<body><div id="grid"></div>
<script>${lottie}</script>
<script>
(function () {
  var out = document.getElementById('grid');
  function fail(reason) { out.setAttribute('data-error', String(reason)); }
  try {
    var stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;left:-99999px;top:0;width:512px;height:512px';
    document.body.appendChild(stage);
    var anim = lottie.loadAnimation({
      container: stage,
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: ${embedJson(animation)}
    });
    anim.addEventListener('DOMLoaded', function () {
      try {
        var src = stage.querySelector('canvas');
        var canvas = document.createElement('canvas');
        canvas.width = ${GRID_PX};
        canvas.height = ${GRID_PX};
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        var total = Math.max(1, Math.floor(anim.totalFrames));
        for (var i = 0; i < ${FRAMES}; i++) {
          var frame = Math.min(total - 1, Math.round(i * (total - 1) / ${FRAMES - 1}));
          anim.goToAndStop(frame, true);
          if (!src || !src.width || !src.height) continue;
          var scale = Math.min(${CELL_PX} / src.width, ${CELL_PX} / src.height);
          var w = src.width * scale;
          var h = src.height * scale;
          var col = i % 3;
          var row = Math.floor(i / 3);
          ctx.drawImage(
            src,
            col * ${CELL_PX} + (${CELL_PX} - w) / 2,
            row * ${CELL_PX} + (${CELL_PX} - h) / 2,
            w,
            h
          );
        }
        if (!src) { fail('lottie canvas missing'); return; }
        out.setAttribute('data-ready', '1');
        out.setAttribute('data-png', canvas.toDataURL('image/png'));
      } catch (error) {
        fail(error);
      }
    });
    anim.addEventListener('data_failed', function () { fail('animation data failed'); });
  } catch (error) {
    fail(error);
  }
})();
</script></body></html>`;
}
