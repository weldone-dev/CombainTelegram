import { defineMemory, defineMemoryProvider } from 'eve/memory';
import { stripInternalLines } from '../lib/model/hygiene';

/**
 * Memory lives in NestJS/SQLite; this provider is a thin HTTP adapter.
 *
 * The scope is `[personaId, accountId, chatId]`, so one persona can talk
 * through several accounts without mixing short-term history.
 */

const NEST = (process.env.EVE_NEST_URL ?? 'http://127.0.0.1:4001').replace(
  /\/+$/,
  '',
);
const TOKEN = process.env.EVE_TOKEN ?? '';

function attributes(ctx: unknown): Record<string, unknown> {
  const value = ctx as {
    session?: { auth?: { current?: { attributes?: unknown } } };
  };
  const attributes = value.session?.auth?.current?.attributes;
  return attributes && typeof attributes === 'object'
    ? (attributes as Record<string, unknown>)
    : {};
}

function scoped(ctx: unknown): {
  personaId: string;
  accountId: string;
  chatId: string;
} | null {
  const a = attributes(ctx);
  const personaId = typeof a.personaId === 'string' ? a.personaId : '';
  const accountId = typeof a.accountId === 'string' ? a.accountId : '';
  const chatId = typeof a.chatId === 'string' ? a.chatId : '';
  if (!personaId) return null;
  return { personaId, accountId, chatId };
}

/**
 * Only final text belongs in the session log. Reasoning parts and engine
 * frames are not something either person said, and the day miner would
 * otherwise turn them into "facts".
 */
function contentOf(message: unknown): string {
  if (typeof message === 'string') return stripInternalLines(message);
  if (!message || typeof message !== 'object') return '';
  const value = (message as { content?: unknown }).content;
  if (typeof value === 'string') return stripInternalLines(value);
  if (Array.isArray(value)) {
    return stripInternalLines(
      value
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const row = part as { type?: unknown; text?: unknown };
          if (typeof row.type === 'string' && row.type.startsWith('reasoning')) {
            return '';
          }
          return typeof row.text === 'string' ? row.text : '';
        })
        .filter(Boolean)
        .join('\n'),
    );
  }
  return '';
}

// Recall lives in `agent/instructions/memory.ts`: Eve memory messages are
// always user-role, and a memory snapshot must be a system block. This slot
// keeps only capture, so its store and tools stay unchanged.

const MEMORY_TIMEOUT_MS = 10_000;

/**
 * A memory call must never strand a session. Eve treats a throwing memory
 * definition as a failed turn, so a Nest restart would kill the conversation;
 * recall falls back to an empty memory and capture is dropped.
 */
async function post(path: string, body: unknown): Promise<unknown | null> {
  try {
    const response = await fetch(`${NEST}/internal/eve${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-token': TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `[memory] Nest ${path} failed: ${response.status} ${await response.text()}`,
      );
      return null;
    }
    return (await response.json()) as unknown;
  } catch (error) {
    console.warn(`[memory] Nest ${path} failed: ${(error as Error).message}`);
    return null;
  }
}

export default defineMemory({
  description:
    'girl-agent memory: relationship state, facts, daily summaries and palace drawers.',
  scope: (ctx) => {
    const value = scoped(ctx);
    if (!value) return null;
    return [value.personaId, value.accountId, value.chatId];
  },
  provider: defineMemoryProvider({
    recall: {
      async 'turn.started'() {
        // Deliberately empty: memory is rendered by dynamic system
        // instructions. Returning user-role messages here would put service
        // data back into his conversation history.
        return { messages: [] };
      },
    },
    capture: {
      async 'turn.completed'(ctx) {
        const value = scoped(ctx);
        if (!value) return;
        const messages = ctx.messages
          .slice(-4)
          .map((message) => ({
            role: (message as { role?: string }).role ?? 'user',
            content: contentOf(message),
          }))
          .filter((message) => message.content.trim().length > 0);
        if (messages.length === 0) return;
        await post('/memory/capture', {
          personaId: value.personaId,
          accountId: value.accountId,
          chatId: value.chatId,
          messages,
          operationId: ctx.operationId,
          day: new Date().toISOString().slice(0, 10),
        });
      },
    },
  }),
});
