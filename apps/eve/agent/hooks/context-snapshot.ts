import { defineHook } from 'eve/hooks';
import {
  buildSnapshotPayload,
  normalizeKind,
  postSnapshot,
  takeTurnCapture,
  type SnapshotAddress,
} from '../lib/context/capture';

/**
 * Posts the captured model input of a finished turn to Nest.
 *
 * `turn.settled` runs after the reply was already delivered (`content.completed`
 * → `/internal/eve/messages/send`), so awaiting the snapshot here cannot delay
 * the answer. A retried turn resolves to the same `turnId`; Nest dedupes it.
 *
 * Everything is wrapped: an optional audit side channel must never fail a turn
 * (a throwing hook fails it).
 */

function attribute(ctx: {
  session: {
    auth: {
      current: {
        attributes: Readonly<Record<string, string | readonly string[]>>;
      } | null;
      initiator: {
        attributes: Readonly<Record<string, string | readonly string[]>>;
      } | null;
    };
  };
}, key: string): string {
  const raw =
    ctx.session.auth.current?.attributes[key] ??
    ctx.session.auth.initiator?.attributes[key];
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0].trim() : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

export default defineHook({
  events: {
    async 'turn.settled'(event, ctx) {
      try {
        const sessionId = ctx.session.id;
        const turnId = event.data.turnId;
        const capture = takeTurnCapture(sessionId, turnId);
        if (!capture) return;
        const personaId = attribute(ctx, 'personaId');
        const accountId = attribute(ctx, 'accountId');
        const chatId = attribute(ctx, 'chatId');
        if (!personaId || !accountId || !chatId) return;
        const threadId = Number(attribute(ctx, 'threadId')) || 0;
        const address: SnapshotAddress = {
          personaId,
          accountId,
          chatId,
          threadId,
        };
        const payload = buildSnapshotPayload(
          capture,
          address,
          normalizeKind(attribute(ctx, 'kind')),
          attribute(ctx, 'dryRun') === 'true',
        );
        await postSnapshot(payload);
      } catch (error) {
        console.warn(
          `[context] turn snapshot skipped: ${(error as Error).message}`,
        );
      }
    },
  },
});
