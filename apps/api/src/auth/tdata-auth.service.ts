import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { access, chmod, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { x as extractTarGz } from 'tar';
import { loadTdata } from 'opentele2';
import type { Account, TData } from 'opentele2';
import { qrLoginToNewClient, toStringSession } from 'opentele2/mtcute';
import type { TelegramTransport } from '@mtcute/node';
import type { UserModel } from '@repo/database';
import { AuthAttemptStore } from './auth-attempt.store.js';
import { toTelegramUser } from './phone-auth.service.js';
import { AccountSessionsService } from '../accounts/account-sessions.service.js';
import type { AccountView } from '../accounts/account-view.js';
import { ClientManagerService } from '../telegram/client-manager.service.js';
import { asFlowClient } from '../telegram/flow-client.js';
import type { ResolvedProfile } from '../telegram/client-profile.service.js';
import { ClientProfileService } from '../telegram/client-profile.service.js';
import { ProxiesService } from '../proxies/proxies.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, notFound } from '../common/api-error.js';
import {
  optionalString,
  requireDeviceId,
  requireSecret,
} from '../common/validation.js';

const TDATA_TTL_MS = 15 * 60 * 1000;
export const TDATA_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export interface UploadedArchive {
  path?: string;
  originalname?: string;
  size?: number;
  mimetype?: string;
}

export interface TdataUploadDto {
  passcode?: unknown;
}

export interface TdataImportDto {
  indexes?: unknown;
  mode?: unknown;
  deviceId?: unknown;
  profile?: unknown;
  label?: unknown;
  password?: unknown;
  proxyId?: unknown;
}

export interface TdataUploadView {
  uploadId: string;
  accounts: Array<{ index: number; userId: string }>;
}

export interface TdataImportAccountView {
  account: AccountView;
  mode: 'new_session' | 'reuse';
  warning?: { code: string; message: string };
}

export interface TdataImportView {
  accounts: TdataImportAccountView[];
}

interface StoredUpload {
  id: string;
  userId: string;
  dir: string;
  tdataDir: string;
  tdata: TData;
  accounts: Array<{ index: number; userId: string; mainDc: number }>;
  expiresAtMs: number;
  attemptId?: string;
}

/**
 * tdata upload + import.
 *
 * Uploads land in `TELEGRAM_TMP_DIR`, are extracted, parsed by opentele2 and
 * the archive is deleted immediately. Only the extracted folder lives on until
 * import/cancel/TTL (15 min). Auth keys stay in the Rust `TData` object in
 * memory and are never written to the DB or logs.
 */
@Injectable()
export class TdataAuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TdataAuthService.name);
  private readonly uploads = new Map<string, StoredUpload>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
    private readonly profiles: ClientProfileService,
    private readonly clients: ClientManagerService,
    private readonly accounts: AccountSessionsService,
    private readonly attempts: AuthAttemptStore,
    private readonly proxies: ProxiesService,
  ) {
    // Multer's destination must exist and be private to this process.
    const uploads = join(this.config.tmpDir, 'uploads');
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
    try {
      chmodSync(uploads, 0o700);
    } catch {
      // best effort (e.g. an unusual filesystem)
    }

    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref();
  }

  async onModuleInit(): Promise<void> {
    const stale = await this.prisma.tdataUpload.findMany({
      where: { status: 'pending' },
    });
    for (const row of stale) {
      if (row.tempPath) {
        await rm(row.tempPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    await this.prisma.tdataUpload.updateMany({
      where: { status: 'pending' },
      data: { status: 'expired' },
    });
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    const uploads = [...this.uploads.values()];
    this.uploads.clear();
    await Promise.allSettled(
      uploads.map((upload) => rm(upload.dir, { recursive: true, force: true })),
    );
  }

  async upload(
    user: UserModel,
    file: UploadedArchive | undefined,
    body: TdataUploadDto,
  ): Promise<TdataUploadView> {
    if (!file?.path) {
      throw apiError(
        'TDATA_FILE_REQUIRED',
        'A .zip, .tar.gz or .tgz file field "file" is required',
      );
    }
    if (file.size !== undefined && file.size > TDATA_MAX_ARCHIVE_BYTES) {
      await unlink(file.path).catch(() => undefined);
      throw apiError(
        'TDATA_TOO_LARGE',
        'The tdata archive must be at most 512 MB',
        413,
      );
    }

    const kind = archiveKind(file.originalname ?? '');
    if (!kind) {
      await unlink(file.path).catch(() => undefined);
      throw apiError(
        'TDATA_BAD_FORMAT',
        'Only .zip, .tar.gz and .tgz archives are supported',
      );
    }

    await chmod(file.path, 0o600).catch(() => undefined);

    const passcode =
      body.passcode === undefined ||
      body.passcode === null ||
      body.passcode === ''
        ? undefined
        : requireSecret(body.passcode, 'passcode', { max: 512 });
    const id = randomUUID();
    const dir = join(this.config.tmpDir, `tdata-${id}`);

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });

      await extractArchive(file.path, dir, kind);

      // The archive is a credential and is never needed again.
      await unlink(file.path).catch(() => undefined);

      const tdataDir = await this.findTdataDir(dir);
      if (!tdataDir) {
        throw apiError(
          'TDATA_INVALID',
          'The archive must contain tdata/key_datas (or key_datas at its root)',
        );
      }

      let tdata: TData;
      try {
        tdata = await loadTdata(tdataDir, passcode ?? undefined);
      } catch (error) {
        throw this.tdataError(error);
      }

      const accounts = tdata.accounts.map((account: Account) => ({
        index: account.index,
        userId: account.userId.toString(),
        mainDc: account.mainDc,
      }));
      if (accounts.length === 0) {
        throw apiError(
          'TDATA_NO_ACCOUNTS',
          'This tdata folder contains no accounts',
        );
      }

      const row = await this.prisma.tdataUpload.create({
        data: {
          userId: user.id,
          status: 'pending',
          accounts: JSON.stringify(
            accounts.map(({ index, userId }) => ({ index, userId })),
          ),
          tempPath: dir,
          expiresAt: new Date(Date.now() + TDATA_TTL_MS),
        },
      });

      const attemptRow = await this.attempts
        .create({
          userId: user.id,
          method: 'tdata',
          status: 'pending',
          ttlMs: TDATA_TTL_MS,
          payload: { uploadId: row.id, accounts: accounts.length },
        })
        .catch(() => null);

      this.uploads.set(row.id, {
        id: row.id,
        userId: user.id,
        dir,
        tdataDir,
        tdata,
        accounts,
        expiresAtMs: Date.now() + TDATA_TTL_MS,
        ...(attemptRow ? { attemptId: attemptRow.id } : {}),
      });

      return {
        uploadId: row.id,
        accounts: accounts.map(({ index, userId }) => ({ index, userId })),
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await unlink(file.path).catch(() => undefined);
      throw error;
    }
  }

  async import(
    user: UserModel,
    uploadId: string,
    body: TdataImportDto,
  ): Promise<TdataImportView> {
    const upload = await this.requireUpload(user.id, uploadId);
    const indexes = parseIndexes(body.indexes, upload.accounts);
    const requestedMode = body.mode;
    const mode =
      requestedMode === undefined
        ? 'new_session'
        : typeof requestedMode === 'string'
          ? requestedMode
          : '';
    if (mode !== 'new_session' && mode !== 'reuse') {
      throw apiError(
        'TDATA_MODE_INVALID',
        'mode must be "new_session" or "reuse"',
      );
    }

    const deviceId = requireDeviceId(body.deviceId);
    const label = optionalString(body.label, 'label', { max: 64 }) ?? null;
    const proxyId =
      optionalString(body.proxyId, 'proxyId', { max: 64 }) ?? null;
    const transport = await this.proxies.transportFor(user.id, proxyId);
    const password =
      body.password === undefined ||
      body.password === null ||
      body.password === ''
        ? undefined
        : requireSecret(body.password, 'password', { max: 512 });

    // In `reuse` mode the Telegram Desktop profile is mandatory: the imported
    // auth key was created with Telegram Desktop's own api_id.
    const profile: ResolvedProfile =
      mode === 'new_session'
        ? this.profiles.resolve(
            optionalString(body.profile, 'profile', { max: 32 }),
          )
        : this.profiles.resolveTdataProfile();

    try {
      const results: TdataImportAccountView[] = [];
      for (const index of indexes) {
        const account = upload.tdata.accounts.find(
          (row: Account) => row.index === index,
        );
        if (!account) {
          throw apiError(
            'TDATA_ACCOUNT_NOT_FOUND',
            `tdata account #${index} does not exist in this upload`,
            404,
          );
        }
        try {
          results.push(
            await this.importOne(
              user.id,
              upload,
              account,
              mode,
              deviceId,
              label,
              profile,
              password,
              proxyId,
              transport,
            ),
          );
        } catch (error) {
          throw this.importError(error);
        }
      }
      return { accounts: results };
    } finally {
      await this.cleanup(user.id, upload.id, 'ok');
    }
  }

  async cancel(
    user: UserModel,
    uploadId: string,
  ): Promise<{ cancelled: boolean }> {
    const upload = await this.requireUpload(user.id, uploadId);
    await this.cleanup(user.id, upload.id, 'expired');
    return { cancelled: true };
  }

  private async importOne(
    userId: string,
    upload: StoredUpload,
    account: Account,
    mode: 'new_session' | 'reuse',
    deviceId: string,
    label: string | null,
    profile: ResolvedProfile,
    password: string | undefined,
    proxyId: string | null,
    transport: TelegramTransport | undefined,
  ): Promise<TdataImportAccountView> {
    const desktop = this.profiles.resolveTdataProfile();

    if (mode === 'reuse') {
      const client = this.clients.createAnonymous(desktop, transport, proxyId);
      try {
        await client.importSession(toStringSession(account));
        const me = await client.getMe();
        const session = await client.exportSession();
        const dcId = await client.getPrimaryDcId();
        const attached = await this.accounts.attachSession({
          userId,
          deviceId,
          label,
          profile: desktop,
          session,
          apiId: desktop.api.apiId,
          apiHash: desktop.api.apiHash,
          init: desktop.init,
          dcId,
          tgUser: toTelegramUser(me),
          phone: me.phoneNumber,
          proxyId,
        });
        await this.clients.adopt(attached.sessionId, client);

        return {
          account: attached.account,
          mode,
          warning: {
            code: 'SHARED_DESKTOP_SESSION',
            message:
              'This session reuses the Telegram Desktop auth key from the tdata folder: our client and the desktop client share one session, so read state and updates may conflict.',
          },
        };
      } catch (error) {
        await client.destroy().catch(() => undefined);
        throw error;
      }
    }

    const authorized = this.clients.createAnonymous(desktop, transport, proxyId);
    await authorized.importSession(toStringSession(account));
    const fresh = this.clients.createAnonymous(profile, transport, proxyId);
    let adopted = false;

    try {
      await qrLoginToNewClient(asFlowClient(authorized), asFlowClient(fresh), {
        profile: profile.api,
        ...(password ? { password } : {}),
      });

      const me = await fresh.getMe();
      const session = await fresh.exportSession();
      const dcId = await fresh.getPrimaryDcId();
      const attached = await this.accounts.attachSession({
        userId,
        deviceId,
        label,
        profile,
        session,
        apiId: profile.api.apiId,
        apiHash: profile.api.apiHash,
        init: profile.init,
        dcId,
        tgUser: toTelegramUser(me),
        phone: me.phoneNumber,
        proxyId,
      });
      await this.clients.adopt(attached.sessionId, fresh);
      adopted = true;

      return { account: attached.account, mode };
    } finally {
      await authorized.destroy().catch(() => undefined);
      if (!adopted) await fresh.destroy().catch(() => undefined);
      this.logger.debug(
        `Imported tdata account #${account.index} from upload ${upload.id}`,
      );
    }
  }

  private async requireUpload(
    userId: string,
    uploadId: string,
  ): Promise<StoredUpload> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.userId !== userId) {
      const row = await this.prisma.tdataUpload.findUnique({
        where: { id: uploadId },
      });
      if (!row || row.userId !== userId) {
        throw notFound('TDATA_UPLOAD_NOT_FOUND', 'tdata upload not found');
      }
      throw apiError(
        'TDATA_UPLOAD_EXPIRED',
        'This tdata upload has expired, upload the folder again',
        410,
      );
    }
    if (upload.expiresAtMs <= Date.now()) {
      await this.cleanup(userId, upload.id, 'expired');
      throw apiError(
        'TDATA_UPLOAD_EXPIRED',
        'This tdata upload has expired, upload the folder again',
        410,
      );
    }
    return upload;
  }

  private async cleanup(
    userId: string,
    uploadId: string,
    outcome: 'ok' | 'expired',
  ): Promise<void> {
    const upload = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    if (upload) {
      await rm(upload.dir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (upload.attemptId) {
        await this.attempts
          .update(upload.attemptId, { status: outcome, error: null })
          .catch(() => undefined);
      }
    }
    await this.prisma.tdataUpload
      .deleteMany({ where: { id: uploadId, userId } })
      .catch(() => undefined);
  }

  private sweep(): void {
    const now = Date.now();
    for (const upload of this.uploads.values()) {
      if (upload.expiresAtMs > now) continue;
      this.uploads.delete(upload.id);
      void this.cleanup(upload.userId, upload.id, 'expired');
    }
  }

  private async findTdataDir(root: string): Promise<string | null> {
    const candidates = [
      join(root, 'tdata'),
      root,
    ];
    for (const candidate of candidates) {
      if (await fileExists(join(candidate, 'key_datas'))) return candidate;
    }

    // Allow one wrapper directory (e.g. "Telegram Desktop/tdata/key_datas").
    for (const wrapper of await listDirectories(root)) {
      for (const candidate of [join(wrapper, 'tdata'), wrapper]) {
        if (await fileExists(join(candidate, 'key_datas'))) return candidate;
      }
    }
    return null;
  }

  /**
   * `qrLoginToNewClient` rejects with its own error codes/names (not RpcError),
   * so map the 2FA ones to stable API errors before they become a 500.
   */
  private importError(error: unknown): Error {
    const rawCode = (error as { code?: unknown }).code;
    const rawName = (error as { name?: unknown }).name;
    const message = error instanceof Error ? error.message : String(error);
    const text = `${typeof rawCode === 'string' ? rawCode : ''} ${
      typeof rawName === 'string' ? rawName : ''
    } ${message}`;

    if (/NO_PASSWORD_PROVIDED|PASSWORD_REQUIRED/i.test(text)) {
      return apiError(
        'TDATA_PASSWORD_REQUIRED',
        'This Telegram account has two-step verification enabled: a 2FA password is required to create a new session',
        401,
      );
    }
    if (/PASSWORD_INCORRECT|PASSWORD_HASH_INVALID/i.test(text)) {
      return apiError(
        'TDATA_PASSWORD_INVALID',
        'The two-step verification password is incorrect',
        401,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private tdataError(error: unknown): Error {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? rawCode : '';
    const message = error instanceof Error ? error.message : String(error);
    if (/PASSCODE|PASSWORD|KEY/i.test(code) || /passcode|password|key/i.test(message)) {
      return apiError(
        'TDATA_BAD_PASSCODE',
        'The tdata folder is locked: a correct passcode is required',
        400,
      );
    }
    return apiError(
      'TDATA_INVALID',
      'The uploaded folder is not a readable Telegram Desktop tdata folder',
      400,
    );
  }
}

type ArchiveKind = 'zip' | 'tar';

/** Detects the archive format from the uploaded file name. */
export function archiveKind(name: string): ArchiveKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar';
  if (lower.endsWith('.zip')) return 'zip';
  return null;
}

async function extractArchive(
  archivePath: string,
  dir: string,
  kind: ArchiveKind,
): Promise<void> {
  try {
    if (kind === 'zip') {
      const zip = new AdmZip(archivePath);
      for (const entry of zip.getEntries()) {
        assertSafeEntry(entry.entryName);
      }
      zip.extractAllTo(dir, true);
      return;
    }

    // tar's filter receives every entry before it is written: reject traversal
    // paths and links so a malicious archive cannot write outside `dir`.
    let unsafe = false;
    await extractTarGz({
      file: archivePath,
      cwd: dir,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        if (!isSafeEntry(path) || !isRegularEntry(entry)) {
          unsafe = true;
          return false;
        }
        return true;
      },
    });
    if (unsafe) {
      throw apiError(
        'TDATA_BAD_FORMAT',
        'The archive contains an unsafe file path or link',
      );
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw apiError(
      'TDATA_BAD_FORMAT',
      'The uploaded archive could not be extracted',
    );
  }
}

/** Regular files and directories only; links/devices are rejected. */
function isRegularEntry(entry: unknown): boolean {
  const type = (entry as { type?: unknown }).type;
  if (typeof type !== 'string') return true;
  return (
    type === 'File' ||
    type === 'OldFile' ||
    type === 'ContiguousFile' ||
    type === 'Directory'
  );
}

function isSafeEntry(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes('\0')
  ) {
    return false;
  }
  return !normalized.split('/').some((segment) => segment === '..');
}

function assertSafeEntry(entryName: string): void {
  if (!isSafeEntry(entryName)) {
    throw apiError(
      'TDATA_BAD_FORMAT',
      'The archive contains an unsafe file path',
    );
  }
}

function parseIndexes(
  value: unknown,
  accounts: Array<{ index: number }>,
): number[] {
  if (value === undefined || value === null) {
    return accounts.map((account) => account.index);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw apiError('VALIDATION_ERROR', 'indexes must be a non-empty array');
  }
  const indexes = value.map((item) => {
    const parsed = typeof item === 'number' ? item : Number.parseInt(String(item), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw apiError('VALIDATION_ERROR', 'indexes must contain integers');
    }
    return parsed;
  });
  return [...new Set(indexes)];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}
