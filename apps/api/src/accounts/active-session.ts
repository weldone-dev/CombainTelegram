import type { TelegramSessionModel } from '@repo/database';

/** Anything that carries the account's sessions and its pinned session id. */
export interface ActiveSessionAccount {
  activeSessionId?: string | null;
  sessions: TelegramSessionModel[];
}

/** Newest first, so "most recent" always means the first element. */
function byCreatedAtDesc(
  a: TelegramSessionModel,
  b: TelegramSessionModel,
): number {
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * The session the app treats as the account's transport:
 *
 * 1. the pinned `activeSessionId`, when it still points at a live session;
 * 2. otherwise a live TDLib session (preserves the pre-activation default);
 * 3. otherwise the newest live mtcute session;
 * 4. otherwise the newest live session of any engine.
 *
 * Revoked rows never win, even when pinned: the helper falls back instead of
 * handing a dead session to a caller.
 */
export function resolveActiveSession(
  account: ActiveSessionAccount,
): TelegramSessionModel | undefined {
  const live = account.sessions.filter((session) => !session.revokedAt);

  if (account.activeSessionId) {
    const pinned = live.find(
      (session) => session.id === account.activeSessionId,
    );
    if (pinned) return pinned;
  }

  const tdlib = live
    .filter((session) => session.engine === 'tdlib')
    .sort(byCreatedAtDesc);
  if (tdlib[0]) return tdlib[0];

  const mtcute = live
    .filter((session) => session.engine === 'mtcute')
    .sort(byCreatedAtDesc);
  if (mtcute[0]) return mtcute[0];

  return live.slice().sort(byCreatedAtDesc)[0];
}

/**
 * Newest mtcute session, for callers that need an mtcute client regardless of
 * the active engine. Live rows win; a revoked row is only used when the
 * account has no live mtcute session left (the previous behaviour, which lets
 * the request fail on Telegram with a real error instead of `NO_SESSIONS`).
 */
export function newestMtcuteSession(
  account: ActiveSessionAccount,
): TelegramSessionModel | undefined {
  const mtcute = account.sessions.filter(
    (session) => session.engine !== 'tdlib',
  );
  const live = mtcute.filter((session) => !session.revokedAt);
  return (live.length > 0 ? live : mtcute).slice().sort(byCreatedAtDesc)[0];
}
