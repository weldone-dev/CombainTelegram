import { defineDynamic, defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * Read-only tools over the NestJS internal contract.
 *
 * The model may inspect the current chat context and relationship state. This
 * file deliberately exposes no write/transport tools: sending, typing and
 * memory writes stay in the channel and memory provider, behind their own
 * validation.
 */

interface AuthAttributeSession {
  readonly session: {
    readonly auth: {
      readonly current:
        | { readonly attributes: Readonly<Record<string, string | readonly string[]>> }
        | null;
      readonly initiator:
        | { readonly attributes: Readonly<Record<string, string | readonly string[]>> }
        | null;
    };
  };
}

interface Address {
  personaId: string;
  accountId: string;
  chatId: string;
  threadId: string;
}

function nestBase(): string {
  return (process.env.EVE_NEST_URL ?? 'http://127.0.0.1:4001').replace(
    /\/+$/,
    '',
  );
}

function eveToken(): string {
  return process.env.EVE_TOKEN ?? '';
}

function attribute(ctx: AuthAttributeSession, key: string): string {
  const raw =
    ctx.session.auth.current?.attributes[key] ??
    ctx.session.auth.initiator?.attributes[key];
  if (Array.isArray(raw)) {
    return typeof raw[0] === 'string' ? raw[0] : '';
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

function addressOf(ctx: AuthAttributeSession): Address | null {
  const personaId = attribute(ctx, 'personaId');
  const accountId = attribute(ctx, 'accountId');
  const chatId = attribute(ctx, 'chatId');
  if (!personaId || !accountId || !chatId) return null;
  return {
    personaId,
    accountId,
    chatId,
    threadId: attribute(ctx, 'threadId') || '0',
  };
}

function query(address: Address): string {
  return new URLSearchParams({
    personaId: address.personaId,
    accountId: address.accountId,
    chatId: address.chatId,
    threadId: address.threadId,
  }).toString();
}

async function getJson(
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${nestBase()}/internal/eve${path}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-eve-token': eveToken(),
    },
    signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      `Nest ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json() as Promise<unknown>;
}

const NO_ADDRESS = {
  error:
    'Eve session has no personaId/accountId/chatId auth attributes; Nest state is unavailable.',
};

export default defineDynamic((ctx) => {
  const address = addressOf(ctx);

  return {
    eve_context: defineTool({
      description:
        'Read the current Eve context from Nest: persona card, scope, chat allowlist row, relationship state and recent history. Read-only.',
      inputSchema: z.object({}),
      async execute(_input, toolCtx) {
        if (!address) return NO_ADDRESS;
        return getJson(`/context?${query(address)}`, toolCtx.abortSignal);
      },
    }),

    eve_relationship: defineTool({
      description:
        'Read the relationship row for this persona/account/chat from Nest: stage, interest, trust, attraction, annoyance, cringe and notes. Read-only; use it to understand the current dynamic.',
      inputSchema: z.object({}),
      async execute(_input, toolCtx) {
        if (!address) return NO_ADDRESS;
        return getJson(
          `/state/relationship?${query(address)}`,
          toolCtx.abortSignal,
        );
      },
    }),
  };
});
