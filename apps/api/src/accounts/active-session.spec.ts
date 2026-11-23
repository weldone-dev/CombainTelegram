import type { TelegramSessionModel } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { newestMtcuteSession, resolveActiveSession } from './active-session.js';

function session(
  id: string,
  engine: string,
  options: { revoked?: boolean; createdAt?: Date } = {},
): TelegramSessionModel {
  return {
    id,
    accountId: 'acc-1',
    deviceId: id,
    label: null,
    platform: 'desktop',
    profile: 'TelegramDesktop',
    engine,
    dcId: 2,
    apiId: 1,
    proxyId: null,
    keyVersion: 1,
    cipher: null,
    nonce: null,
    tag: null,
    dekWrapped: null,
    dekNonce: null,
    dekTag: null,
    tdlibPath: null,
    tdlibKeyEncrypted: null,
    tdlibKeyNonce: null,
    tdlibKeyTag: null,
    revokedAt: options.revoked ? new Date(1) : null,
    lastUsedAt: null,
    createdAt: options.createdAt ?? new Date(0),
  } as TelegramSessionModel;
}

describe('resolveActiveSession', () => {
  it('uses the pinned session when it is live', () => {
    const pinned = session('mtcute-old', 'mtcute', {
      createdAt: new Date(0),
    });
    const tdlib = session('tdlib-new', 'tdlib', { createdAt: new Date(5) });

    expect(
      resolveActiveSession({
        activeSessionId: pinned.id,
        sessions: [pinned, tdlib],
      })?.id,
    ).toBe(pinned.id);
  });

  it('ignores a pinned id that is revoked or gone', () => {
    const revoked = session('pinned', 'mtcute', { revoked: true });
    const tdlib = session('tdlib', 'tdlib');

    expect(
      resolveActiveSession({
        activeSessionId: revoked.id,
        sessions: [revoked, tdlib],
      })?.id,
    ).toBe(tdlib.id);
    expect(
      resolveActiveSession({
        activeSessionId: 'missing',
        sessions: [revoked, tdlib],
      })?.id,
    ).toBe(tdlib.id);
  });

  it('falls back to a live TDLib session before mtcute (previous default)', () => {
    const mtcute = session('mtcute', 'mtcute', { createdAt: new Date(10) });
    const tdlib = session('tdlib', 'tdlib', { createdAt: new Date(1) });

    expect(
      resolveActiveSession({ activeSessionId: null, sessions: [mtcute, tdlib] })
        ?.id,
    ).toBe(tdlib.id);
  });

  it('picks the newest live mtcute session when no TDLib row is live', () => {
    const old = session('mtcute-old', 'mtcute', { createdAt: new Date(1) });
    const fresh = session('mtcute-new', 'mtcute', { createdAt: new Date(9) });
    const revoked = session('tdlib', 'tdlib', { revoked: true });

    expect(
      resolveActiveSession({
        activeSessionId: null,
        sessions: [old, fresh, revoked],
      })?.id,
    ).toBe(fresh.id);
  });

  it('returns the newest live session of any engine as the last resort', () => {
    const native = session('native', 'unsupported', {
      createdAt: new Date(3),
    });

    expect(
      resolveActiveSession({ activeSessionId: null, sessions: [native] })?.id,
    ).toBe(native.id);
  });

  it('returns undefined when every session is revoked', () => {
    const revoked = session('gone', 'mtcute', { revoked: true });

    expect(
      resolveActiveSession({ activeSessionId: null, sessions: [revoked] }),
    ).toBeUndefined();
  });
});

describe('newestMtcuteSession', () => {
  it('prefers a live row over a newer revoked one', () => {
    const live = session('live', 'mtcute', { createdAt: new Date(1) });
    const revoked = session('revoked', 'mtcute', {
      revoked: true,
      createdAt: new Date(9),
    });

    expect(
      newestMtcuteSession({ activeSessionId: null, sessions: [live, revoked] })
        ?.id,
    ).toBe(live.id);
  });

  it('falls back to a revoked mtcute row when nothing live is left', () => {
    const revoked = session('revoked', 'mtcute', { revoked: true });

    expect(
      newestMtcuteSession({ activeSessionId: null, sessions: [revoked] })?.id,
    ).toBe(revoked.id);
  });

  it('ignores TDLib rows entirely', () => {
    const tdlib = session('tdlib', 'tdlib', { createdAt: new Date(9) });

    expect(
      newestMtcuteSession({ activeSessionId: tdlib.id, sessions: [tdlib] }),
    ).toBeUndefined();
  });
});
