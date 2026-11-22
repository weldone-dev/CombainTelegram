import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { AuthAttemptModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';

export type AuthMethod = 'phone' | 'qr' | 'tdata';

export type AuthAttemptStatus =
  | 'pending'
  | 'code_sent'
  | 'scanned'
  | 'password_required'
  | 'ok'
  | 'failed'
  | 'expired';

const ACTIVE_STATUSES: AuthAttemptStatus[] = [
  'pending',
  'code_sent',
  'scanned',
  'password_required',
];

export interface AuthAttemptView {
  id: string;
  userId: string | null;
  method: string;
  status: string;
  error: string | null;
  payload: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAttemptInput {
  userId: string;
  method: AuthMethod;
  status: AuthAttemptStatus;
  payload?: Record<string, unknown>;
  ttlMs: number;
}

/**
 * Durable status tracker for auth attempts.
 *
 * Only non-secret metadata ever reaches the DB (method, profile, deviceId,
 * status, error code). The live client, phone code hash, QR token and password
 * promise stay in the owning flow's memory, sticky to this process.
 */
@Injectable()
export class AuthAttemptStore implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Pending attempts cannot survive a restart: the in-memory client is gone.
    await this.prisma.authAttempt.updateMany({
      where: { status: { in: ACTIVE_STATUSES } },
      data: { status: 'expired', error: 'RESTARTED' },
    });
  }

  async create(input: CreateAttemptInput): Promise<AuthAttemptView> {
    const row = await this.prisma.authAttempt.create({
      data: {
        userId: input.userId,
        method: input.method,
        status: input.status,
        payload: JSON.stringify(input.payload ?? {}),
        expiresAt: new Date(Date.now() + input.ttlMs),
      },
    });
    return toView(row);
  }

  async update(
    id: string,
    patch: {
      status?: AuthAttemptStatus;
      error?: string | null;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.prisma.authAttempt.update({
      where: { id },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.payload ? { payload: JSON.stringify(patch.payload) } : {}),
      },
    });
  }

  async get(id: string): Promise<AuthAttemptView | null> {
    const row = await this.prisma.authAttempt.findUnique({ where: { id } });
    if (!row) return null;

    const view = toView(row);
    if (
      ACTIVE_STATUSES.includes(view.status as AuthAttemptStatus) &&
      view.expiresAt.getTime() <= Date.now()
    ) {
      await this.update(id, { status: 'expired', error: 'TIMEOUT' });
      view.status = 'expired';
      view.error = 'TIMEOUT';
    }
    return view;
  }

  async expire(id: string, error = 'CANCELLED'): Promise<void> {
    await this.update(id, { status: 'expired', error });
  }
}

function toView(row: AuthAttemptModel): AuthAttemptView {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }

  return {
    id: row.id,
    userId: row.userId,
    method: row.method,
    status: row.status,
    error: row.error,
    payload,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
