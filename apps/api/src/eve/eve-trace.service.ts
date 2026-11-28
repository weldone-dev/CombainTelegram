import { Injectable } from '@nestjs/common';
import { eveId, parseChatId } from './eve-access.js';
import { eveWhyUrl } from './eve-push.js';
import { eveToken } from './eve-token.js';

/**
 * Technical trace of the Eve turn loop for one chat.
 *
 * Context snapshots live in Nest and the chat timeline is a Nest read, but the
 * behavior decision (`intent`, `shouldReply`, `delaySec`, `source`) only exists
 * in the memory of the running Eve process: `GET /eve/v1/nest/why` returns the
 * last decision it took for the chat. Nest proxies that read so the dashboard
 * can show it next to the snapshot, and keeps the failure soft — a stopped
 * `eve dev` is normal and must not turn the trace tab into an error page.
 */

export const EVE_WHY_TIMEOUT_MS = 2_000;

export interface EveTurnWhy {
  at: string;
  intent: string;
  shouldReply: boolean;
  ignoreReason?: string;
  delaySec: number;
  reaction?: string;
  source?: string;
}

export interface EveTurnWhyView {
  ok: boolean;
  decision: EveTurnWhy | null;
  /** Present when Eve is not reachable or answered with an error. */
  error?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Drops fields the dashboard cannot render instead of inventing them. */
export function decisionOf(value: unknown): EveTurnWhy | null {
  const payload = record(value);
  const decision = record(payload.decision);
  const intent = textOf(decision.intent);
  if (!intent) return null;
  const delay = Number(decision.delaySec);
  const ignoreReason = textOf(decision.ignoreReason);
  const reaction = textOf(decision.reaction);
  const source = textOf(decision.source);
  return {
    at: textOf(decision.at),
    intent,
    shouldReply: decision.shouldReply === true,
    delaySec: Number.isFinite(delay) && delay >= 0 ? Math.trunc(delay) : 0,
    ...(ignoreReason ? { ignoreReason } : {}),
    ...(reaction ? { reaction } : {}),
    ...(source ? { source } : {}),
  };
}

@Injectable()
export class EveTraceService {
  /** `GET /internal/eve/turn/why` — last decision of this chat, best effort. */
  async why(query: {
    personaId?: unknown;
    accountId?: unknown;
    chatId?: unknown;
  }): Promise<EveTurnWhyView> {
    const personaId = eveId(
      query.personaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const accountId = eveId(
      query.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(query.chatId).toString();

    const url = eveWhyUrl();
    if (!url) {
      return {
        ok: false,
        decision: null,
        error: 'Eve не настроен (EVE_WEBHOOK_URL/EVE_TOKEN пусты)',
      };
    }

    try {
      const target = new URL(url);
      target.searchParams.set('personaId', personaId);
      target.searchParams.set('accountId', accountId);
      target.searchParams.set('chatId', chatId);
      const response = await fetch(target, {
        headers: { 'x-eve-token': eveToken() },
        signal: AbortSignal.timeout(EVE_WHY_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!response.ok) {
        return {
          ok: false,
          decision: null,
          error: `Eve /eve/v1/nest/why ответил HTTP ${response.status}`,
        };
      }
      return { ok: true, decision: decisionOf(await response.json()) };
    } catch (error) {
      return {
        ok: false,
        decision: null,
        error: `Eve недоступен: ${(error as Error).message || 'unknown error'}`,
      };
    }
  }
}
