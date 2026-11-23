import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Client } from 'tdlib-native';
import type { file } from 'tdlib-native/types';
import { apiError } from '../common/api-error.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';

export interface TdDownloadOptions {
  /** Hard cap; the file is rejected before reading it into memory. */
  maxBytes?: number;
  /** Called with (downloaded, total) on every `updateFile`. */
  onProgress?: (downloaded: number, total: number) => void;
}

export interface TdDownloadResult {
  data: Buffer;
  path: string;
}

/**
 * File I/O through TDLib.
 *
 * TDLib resolves the file's real DC (including CDN redirects) itself, which is
 * exactly what the mtcute download path could not follow for some avatars and
 * media. Downloads are buffered in memory because the REST layer returns a
 * `Buffer`; callers enforce {@link MAX_MEDIA_BYTES} before asking.
 */
@Injectable()
export class TdFilesService {
  private readonly logger = new Logger(TdFilesService.name);

  constructor(private readonly config: TelegramConfigService) {}

  /** Local, fully-downloaded path of a TDLib file, or `null`. */
  localPath(target: file | null | undefined): string | null {
    if (!target?.local?.is_downloading_completed) return null;
    return target.local.path || null;
  }

  /** Size TDLib knows about, preferring the exact size over the estimate. */
  knownSize(target: file | null | undefined): number | null {
    if (!target) return null;
    const size = target.size || target.expected_size || 0;
    return size > 0 ? size : null;
  }

  /**
   * Downloads one TDLib file synchronously and returns its bytes.
   *
   * `synchronous: true` makes TDLib answer only when the download finished;
   * `getFile` fills in the local path if the update did not arrive before the
   * response. `updateFile` is used for progress without blocking the call.
   */
  async download(
    client: Pick<Client, 'api' | 'updates'>,
    target: file,
    options: TdDownloadOptions = {},
  ): Promise<TdDownloadResult> {
    const size = this.knownSize(target);
    if (options.maxBytes && size && size > options.maxBytes) {
      throw apiError(
        'MEDIA_TOO_LARGE',
        `media must be at most ${options.maxBytes} bytes`,
        413,
        { details: { size, limit: options.maxBytes } },
      );
    }

    const unsubscribe = options.onProgress
      ? client.updates.subscribe((update) => {
          if (update._ !== 'updateFile' || update.file.id !== target.id) return;
          const local = update.file.local;
          options.onProgress?.(
            local.downloaded_size,
            update.file.size || update.file.expected_size || 0,
          );
        })
      : undefined;

    try {
      let current = await client.api.downloadFile({
        file_id: target.id,
        priority: 16,
        offset: 0,
        limit: 0,
        synchronous: true,
      });

      if (!current.local?.is_downloading_completed || !current.local.path) {
        current = await client.api.getFile({ file_id: target.id });
      }

      const path = current.local?.path;
      if (!current.local?.is_downloading_completed || !path) {
        throw apiError(
          'TDLIB_DOWNLOAD_FAILED',
          'TDLib did not finish downloading this file',
          502,
        );
      }

      const data = await readFile(path);
      if (options.maxBytes && data.byteLength > options.maxBytes) {
        throw apiError(
          'MEDIA_TOO_LARGE',
          `media must be at most ${options.maxBytes} bytes`,
          413,
          { details: { size: data.byteLength, limit: options.maxBytes } },
        );
      }
      return { data, path };
    } finally {
      unsubscribe?.();
    }
  }

  /** `getFile` + {@link download} for callers that only have a file id. */
  async downloadById(
    client: Pick<Client, 'api' | 'updates'>,
    fileId: number,
    options: TdDownloadOptions = {},
  ): Promise<TdDownloadResult> {
    const target = await client.api.getFile({ file_id: fileId });
    return this.download(client, target, options);
  }

  /**
   * Writes an uploaded buffer to a private temp file so TDLib can upload it as
   * `inputFileLocal`. Returns the absolute path; callers must `cleanup()` it.
   */
  async writeUpload(buffer: Buffer, fileName = 'upload'): Promise<string> {
    const dir = join(this.config.tmpDir, 'tdlib-uploads');
    await mkdir(dir, { recursive: true });
    const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const path = join(
      dir,
      `${randomBytes(8).toString('hex')}-${safe || 'file'}`,
    );
    await writeFile(path, buffer);
    return path;
  }

  /** Best-effort temp-file removal; a failure must not fail a sent message. */
  async cleanup(path: string | null | undefined): Promise<void> {
    if (!path) return;
    await rm(path, { force: true }).catch((error: unknown) => {
      this.logger.warn(
        `Could not remove temp upload ${path}: ${(error as Error).message}`,
      );
    });
  }
}
