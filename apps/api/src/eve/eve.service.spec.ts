import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEveDryRunState, takeEveDryRunOutbound } from './eve-dry-run.js';
import { EveService } from './eve.service.js';

const PERSONA = 'persona-1';
const ACCOUNT = 'account-1';
const CHAT = 1830539716;
const NOW = new Date('2026-11-27T10:00:00.000Z');

interface HarnessOptions {
  mode?: 'shared' | 'isolated';
  personas?: string[];
}

function harness(options: HarnessOptions = {}) {
  const mode = options.mode ?? 'isolated';
  const boundPersonas = options.personas ?? [PERSONA];
  const bindings = new Map<string, { allowed: boolean }>();
  const keyOf = (
    personaId: string,
    accountId: string,
    chatId: bigint,
    threadId: number,
  ): string =>
    `${personaId}:${accountId}:${chatId.toString()}:${threadId}`;

  const relation = (scopeKey: string) => ({
    id: 'rel-1',
    personaId: PERSONA,
    scopeKey,
    stage: 'tg-given-warming',
    interest: 0,
    trust: 0,
    attraction: 0,
    annoyance: 0,
    cringe: 0,
    notes: '',
    createdAt: NOW,
    updatedAt: NOW,
  });

  const prisma = {
    evePersona: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          where.id === PERSONA ? { id: PERSONA } : null,
      ),
      create: vi.fn(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: PERSONA,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        }),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({ id: where.id, ...data }),
      ),
    },
    telegramAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === ACCOUNT && where.userId === 'local'
            ? { id: ACCOUNT }
            : null,
      ),
    },
    evePersonaAccount: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { personaId_accountId: { personaId: string; accountId: string } };
        }) =>
          where.personaId_accountId.accountId === ACCOUNT
            ? { enabled: true, relationshipMode: mode }
            : null,
      ),
      findMany: vi.fn(
        async () => boundPersonas.map((personaId) => ({ personaId })),
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: {
            personaId_accountId: { personaId: string; accountId: string };
          };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => ({
          id: 'link-1',
          ...where.personaId_accountId,
          ...create,
          ...update,
        }),
      ),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    eveChatBinding: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            personaId_accountId_chatId_threadId: {
              personaId: string;
              accountId: string;
              chatId: bigint;
              threadId: number;
            };
          };
        }) => {
          const key = where.personaId_accountId_chatId_threadId;
          const row =
            bindings.get(
              keyOf(key.personaId, key.accountId, key.chatId, key.threadId),
            ) ?? null;
          if (!row) return null;
          return {
            id: 'binding-1',
            personaId: key.personaId,
            accountId: key.accountId,
            chatId: key.chatId,
            threadId: key.threadId,
            allowed: row.allowed,
            note: null,
            createdAt: NOW,
            updatedAt: NOW,
          };
        },
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { personaId: string; accountId: string; allowed: boolean };
        }) =>
          [...bindings.entries()].some(
            ([key, row]) =>
              key.startsWith(`${where.personaId}:${where.accountId}:`) &&
              row.allowed === where.allowed,
          )
            ? { id: 'binding-1' }
            : null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: {
            personaId_accountId_chatId_threadId: {
              personaId: string;
              accountId: string;
              chatId: bigint;
              threadId: number;
            };
          };
          create: Record<string, unknown>;
        }) => {
          const key = where.personaId_accountId_chatId_threadId;
          bindings.set(
            keyOf(key.personaId, key.accountId, key.chatId, key.threadId),
            { allowed: create.allowed === true },
          );
          return { id: 'binding-1', ...key, ...create, updatedAt: NOW };
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            accountId: string;
            personaId: { in: string[] };
            allowed: boolean;
            chatId?: bigint;
            threadId?: number;
          };
        }) =>
          [...bindings.entries()]
            .map(([key, row]) => {
              const [personaId, accountId, chatId, threadId] = key.split(':');
              return {
                personaId,
                accountId,
                chatId: BigInt(chatId!),
                threadId: Number(threadId),
                ...row,
              };
            })
            .filter(
              (row) =>
                row.accountId === where.accountId &&
                where.personaId.in.includes(row.personaId!) &&
                row.allowed === where.allowed &&
                (where.chatId === undefined ||
                  row.chatId === where.chatId) &&
                (where.threadId === undefined ||
                  row.threadId === where.threadId),
            )
            .map((row) => ({ personaId: row.personaId })),
      ),
    },
    eveRelationship: {
      upsert: vi.fn(
        async ({
          where,
        }: {
          where: { personaId_scopeKey: { personaId: string; scopeKey: string } };
        }) => relation(where.personaId_scopeKey.scopeKey),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({ ...relation('peer:1'), id: where.id, ...data }),
      ),
      findUnique: vi.fn(async () => null),
    },
    eveRelationshipEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'rel-event-1',
        createdAt: NOW,
        ...data,
      })),
    },
    eveConflict: {
      upsert: vi.fn(
        async ({ where }: { where: { relationshipId: string } }) => ({
          id: 'conflict-1',
          relationshipId: where.relationshipId,
          level: 0,
          coldUntil: null,
          reason: null,
          history: '[]',
        }),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({ id: where.id, ...data }),
      ),
    },
    eveAgendaItem: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          where.id === 'agenda-1'
            ? {
                id: 'agenda-1',
                personaId: PERSONA,
                accountId: ACCOUNT,
                chatId: BigInt(CHAT),
              }
            : null,
      ),
      create: vi.fn(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'agenda-1',
          ...data,
        }),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({ id: where.id, ...data }),
      ),
      findMany: vi.fn(async () => []),
    },
    eveSessionLog: { createMany: vi.fn(async () => ({ count: 0 })) },
    eveDailyLife: {
      findUnique: vi.fn(async () => null),
    },
    eveMemoryFact: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'fact-1',
        ...data,
      })),
      findMany: vi.fn(async () => []),
    },
    eveMemoryDaily: { findMany: vi.fn(async () => []) },
    evePalaceDrawer: { findMany: vi.fn(async () => []) },
  };

  const messaging = {
    sendMessage: vi.fn(async () => ({ id: 42 })),
    sendMedia: vi.fn(async () => ({ id: 43 })),
    sendTyping: vi.fn(async () => ({ status: 'typing' })),
    sendReaction: vi.fn(async () => ({ reacted: true })),
    editMessage: vi.fn(async () => ({ edited: true })),
    deleteMessage: vi.fn(async () => ({ deleted: true })),
    markRead: vi.fn(async () => ({ read: true })),
    setOnline: vi.fn(async (_userId: string, _accountId: string, online: boolean) => ({
      online,
    })),
    listMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
  };
  const users = { get: vi.fn(async () => ({ id: 'local' })) };
  const media = {
    sendSticker: vi.fn(async () => ({ id: 44 })),
    sendVoice: vi.fn(async () => ({ id: 45 })),
    blockContact: vi.fn(async () => ({ blocked: true })),
    unblockContact: vi.fn(async () => ({ blocked: false })),
  };

  const service = new EveService(
    prisma as never,
    messaging as never,
    users as never,
    media as never,
  );

  return { service, prisma, messaging, users, media, bindings, keyOf };
}

function allow(
  bindings: Map<string, { allowed: boolean }>,
  keyOf: ReturnType<typeof harness>['keyOf'],
  allowed = true,
): void {
  bindings.set(keyOf(PERSONA, ACCOUNT, BigInt(CHAT), 0), { allowed });
}

function codeOf(error: unknown): unknown {
  return (error as { getResponse?: () => unknown }).getResponse?.();
}

describe('EveService personas', () => {
  it('creates a persona with defaults and normalised values', async () => {
    const { service, prisma } = harness();

    await service.createPersona({ name: '  Alice ', age: '25' });

    expect(prisma.evePersona.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Alice',
        age: 25,
        nationality: 'RU',
        communication: '{}',
        nightWakeChance: 0.05,
      }),
    });
  });

  it('rejects an unnamed persona with EVE_NAME_REQUIRED', async () => {
    const { service, prisma } = harness();

    await expect(service.createPersona({ name: '   ' })).rejects.toMatchObject({
      response: { code: 'EVE_NAME_REQUIRED' },
    });
    expect(prisma.evePersona.create).not.toHaveBeenCalled();
  });

  it('binds an account to a persona and updates an existing link', async () => {
    const { service, prisma } = harness();

    await service.bindAccount(PERSONA, {
      accountId: ACCOUNT,
      relationshipMode: 'shared',
    });

    expect(prisma.evePersonaAccount.upsert).toHaveBeenCalledWith({
      where: { personaId_accountId: { personaId: PERSONA, accountId: ACCOUNT } },
      create: expect.objectContaining({
        personaId: PERSONA,
        accountId: ACCOUNT,
        relationshipMode: 'shared',
        enabled: true,
      }),
      update: { relationshipMode: 'shared', enabled: true },
    });
  });

  it('rejects an invalid relationship mode and an unknown account', async () => {
    const { service, prisma } = harness();

    await expect(
      service.bindAccount(PERSONA, {
        accountId: ACCOUNT,
        relationshipMode: 'together',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_RELATIONSHIP_MODE_INVALID' },
    });

    await expect(
      service.bindAccount(PERSONA, { accountId: 'missing-account' }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_ACCOUNT_NOT_FOUND' },
    });

    expect(prisma.evePersonaAccount.upsert).not.toHaveBeenCalled();
  });
});

describe('EveService allowlist', () => {
  it('refuses a send without an allowlist row', async () => {
    const { service, messaging } = harness();

    await expect(
      service.sendText({ accountId: ACCOUNT, chatId: CHAT, text: 'hi' }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_CHAT_NOT_ALLOWED' },
    });
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a send when the row is not allowed', async () => {
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf, false);

    const error = await service
      .sendText({ accountId: ACCOUNT, chatId: CHAT, text: 'hi' })
      .catch((value: unknown) => value);

    expect(codeOf(error)).toMatchObject({ code: 'EVE_CHAT_NOT_ALLOWED' });
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('sends when the exact (persona, account, chat, thread) row is allowed', async () => {
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    const result = await service.sendText({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      text: 'hello',
    });

    expect(result).toEqual({ sent: true, messageIds: [42] });
    expect(messaging.sendMessage).toHaveBeenCalledWith(
      'local',
      ACCOUNT,
      String(CHAT),
      expect.objectContaining({ text: 'hello', typing: 'auto' }),
    );
  });

  it('gates typing, read, presence, media and voice by the same row', async () => {
    const { service, messaging } = harness();
    const payload = { accountId: ACCOUNT, chatId: CHAT };

    for (const action of [
      () => service.typing(payload),
      () => service.read(payload),
      () => service.presence(payload),
      () => service.sendMedia({ ...payload, base64: 'aGk=' }),
      () => service.sendVoice({ ...payload, base64: 'aGk=' }),
    ]) {
      await expect(action()).rejects.toMatchObject({
        response: { code: 'EVE_CHAT_NOT_ALLOWED' },
      });
    }

    expect(messaging.sendTyping).not.toHaveBeenCalled();
    expect(messaging.markRead).not.toHaveBeenCalled();
    expect(messaging.setOnline).not.toHaveBeenCalled();
    expect(messaging.sendMedia).not.toHaveBeenCalled();
  });

  it('lets presence through when the persona has an allowed chat', async () => {
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    await expect(
      service.presence({ accountId: ACCOUNT, online: false }),
    ).resolves.toEqual({ online: false });
    expect(messaging.setOnline).toHaveBeenCalledWith('local', ACCOUNT, false);
  });

  it('rejects memory writes for a chat outside the allowlist', async () => {
    const { service, prisma } = harness();

    await expect(
      service.capture(PERSONA, {
        accountId: ACCOUNT,
        chatId: CHAT,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_CHAT_NOT_ALLOWED' },
    });
    await expect(
      service.addFact(PERSONA, {
        accountId: ACCOUNT,
        chatId: CHAT,
        content: 'fact',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_CHAT_NOT_ALLOWED' },
    });
    expect(prisma.eveSessionLog.createMany).not.toHaveBeenCalled();
    expect(prisma.eveMemoryFact.create).not.toHaveBeenCalled();
  });
});

describe('EveService address validation', () => {
  it('returns stable codes for missing or invalid ids', async () => {
    const { service, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    await expect(service.sendText({ chatId: CHAT, text: 'hi' })).rejects.toMatchObject({
      response: { code: 'EVE_ACCOUNT_REQUIRED' },
    });
    await expect(
      service.sendText({ accountId: ACCOUNT, chatId: 0, text: 'hi' }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_CHAT_ID_INVALID' },
    });
    await expect(
      service.sendText({ accountId: ACCOUNT, chatId: CHAT, text: ' ' }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_TEXT_REQUIRED' },
    });
    await expect(
      service.getPersona(''),
    ).rejects.toMatchObject({
      response: { code: 'EVE_PERSONA_REQUIRED' },
    });
    await expect(
      service.getPersona('missing'),
    ).rejects.toMatchObject({
      response: { code: 'EVE_PERSONA_NOT_FOUND' },
    });
  });

  it('infers the only persona that allows the chat, and refuses a real tie', async () => {
    const single = harness({ personas: [PERSONA] });
    allow(single.bindings, single.keyOf);

    await expect(
      single.service.sendText({ accountId: ACCOUNT, chatId: CHAT, text: 'ok' }),
    ).resolves.toMatchObject({ sent: true });

    const many = harness({ personas: [PERSONA, 'persona-2'] });
    allow(many.bindings, many.keyOf);
    many.bindings.set(
      many.keyOf('persona-2', ACCOUNT, BigInt(CHAT), 0),
      { allowed: true },
    );
    await expect(
      many.service.sendText({ accountId: ACCOUNT, chatId: CHAT, text: 'ok' }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_PERSONA_REQUIRED' },
    });

    // Naming the persona resolves the tie.
    await expect(
      many.service.sendText({
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: CHAT,
        text: 'ok',
      }),
    ).resolves.toMatchObject({ sent: true });
  });

  it('infers across personas when only one of them allows the chat', async () => {
    const many = harness({ personas: [PERSONA, 'persona-2'] });
    allow(many.bindings, many.keyOf);

    await expect(
      many.service.sendText({ accountId: ACCOUNT, chatId: CHAT, text: 'ok' }),
    ).resolves.toMatchObject({ sent: true });
  });
});

describe('EveService relationship state', () => {
  it('upserts a shared relationship keyed by the peer', async () => {
    const { service, prisma } = harness({ mode: 'shared' });

    await service.getRelationship(PERSONA, ACCOUNT, CHAT);

    expect(prisma.eveRelationship.upsert).toHaveBeenCalledWith({
      where: {
        personaId_scopeKey: {
          personaId: PERSONA,
          scopeKey: `peer:${CHAT}`,
        },
      },
      create: { personaId: PERSONA, scopeKey: `peer:${CHAT}` },
      update: {},
    });
  });

  it('upserts an isolated relationship keyed by account and chat', async () => {
    const { service, prisma } = harness({ mode: 'isolated' });

    await service.getRelationship(PERSONA, ACCOUNT, CHAT);

    expect(prisma.eveRelationship.upsert).toHaveBeenCalledWith({
      where: {
        personaId_scopeKey: {
          personaId: PERSONA,
          scopeKey: `account:${ACCOUNT}:chat:${CHAT}`,
        },
      },
      create: {
        personaId: PERSONA,
        scopeKey: `account:${ACCOUNT}:chat:${CHAT}`,
      },
      update: {},
    });
  });

  it('gates relationship writes by the allowlist', async () => {
    const { service, prisma } = harness();

    await expect(
      service.updateRelationship(PERSONA, ACCOUNT, CHAT, { trust: 10 }),
    ).rejects.toMatchObject({
      response: { code: 'EVE_CHAT_NOT_ALLOWED' },
    });
    expect(prisma.eveRelationship.update).not.toHaveBeenCalled();
  });

  it('updates a state row when the chat is allowed', async () => {
    const { service, prisma, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    const updated = await service.updateRelationship(PERSONA, ACCOUNT, CHAT, {
      trust: 40,
      event: 'met at a party',
    });

    expect(updated).toMatchObject({ id: 'rel-1', trust: 40 });
    expect(prisma.eveRelationshipEvent.create).toHaveBeenCalledWith({
      data: { relationshipId: 'rel-1', kind: 'note', text: 'met at a party' },
    });
  });
});

describe('EveService serialization', () => {
  it('returns chatId as a string in every outward chat/agenda response', async () => {
    const { service, prisma, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    prisma.eveChatBinding.findMany.mockResolvedValueOnce([
      {
        id: 'binding-1',
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: BigInt(CHAT),
        threadId: 0,
        allowed: true,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ] as never);

    const chats = await service.listChats(PERSONA);
    expect(chats[0]?.chatId).toBe(String(CHAT));
    expect(() => JSON.stringify(chats)).not.toThrow();

    const allowedRow = await service.allowChat(PERSONA, {
      accountId: ACCOUNT,
      chatId: CHAT,
    });
    expect(allowedRow.chatId).toBe(String(CHAT));
    expect(() => JSON.stringify(allowedRow)).not.toThrow();

    prisma.eveAgendaItem.findMany.mockResolvedValueOnce([
      {
        id: 'agenda-1',
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: BigInt(CHAT),
        about: 'ping',
        reason: '',
        kind: 'proactive-life',
        state: 'pending',
        importance: 1,
        pingAt: NOW,
        attempts: 0,
        history: '[]',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ] as never);

    const agenda = await service.listAgenda(PERSONA);
    expect(agenda[0]?.chatId).toBe(String(CHAT));
    expect(() => JSON.stringify(agenda)).not.toThrow();

    const created = await service.createAgenda(PERSONA, {
      accountId: ACCOUNT,
      chatId: CHAT,
    });
    expect(created.chatId).toBe(String(CHAT));
    expect(() => JSON.stringify(created)).not.toThrow();

    prisma.eveAgendaItem.update.mockResolvedValueOnce({
      id: 'agenda-1',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: BigInt(CHAT),
      state: 'done',
    } as never);
    const updated = await service.updateAgenda('agenda-1', { state: 'done' });
    expect(updated.chatId).toBe(String(CHAT));
    expect(() => JSON.stringify(updated)).not.toThrow();

    const context = await service.context(PERSONA, ACCOUNT, CHAT);
    expect(context.scope.chatId).toBe(String(CHAT));
    expect(context.chat?.chatId).toBe(String(CHAT));
    expect(() => JSON.stringify(context)).not.toThrow();
  });
});


describe('EveService dry-run', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEveDryRunState();
  });

  it('suppresses Telegram text when the request carries dryRun', async () => {
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    const result = await service.sendText({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      text: 'привет',
      dryRun: true,
    });

    expect(messaging.sendMessage).not.toHaveBeenCalled();
    expect(result.sent).toBe(true);
    expect(result.messageIds[0]).toBeLessThan(0);
    expect(takeEveDryRunOutbound(ACCOUNT, CHAT, PERSONA)).toEqual([
      expect.objectContaining({ kind: 'send', text: expect.stringContaining('привет') }),
    ]);
  });

  it('sends normally when the request has no dryRun', async () => {
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    await service.sendText({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      text: 'hi',
    });

    expect(messaging.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the flag per request, never per chat', async () => {
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    await service.sendText({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      text: 'suppressed',
      dryRun: true,
    });
    await service.sendText({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      text: 'delivered',
    });

    expect(messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(messaging.sendMessage).toHaveBeenCalledWith(
      'local',
      ACCOUNT,
      String(CHAT),
      expect.objectContaining({ text: 'delivered' }),
    );
  });

  it('suppresses reaction, typing, read and presence for a dry request', async () => {
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf);
    const payload = {
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      messageId: 10,
      dryRun: true,
    };

    await service.sendReaction({ ...payload, emoji: '❤' });
    await service.typing(payload);
    await service.read(payload);
    await service.presence({
      accountId: ACCOUNT,
      chatId: CHAT,
      online: true,
      dryRun: true,
    });

    expect(messaging.sendReaction).not.toHaveBeenCalled();
    expect(messaging.sendTyping).not.toHaveBeenCalled();
    expect(messaging.markRead).not.toHaveBeenCalled();
    expect(messaging.setOnline).not.toHaveBeenCalled();
    expect(takeEveDryRunOutbound(ACCOUNT, CHAT, PERSONA).map((row) => row.kind)).toEqual([
      'react',
      'typing',
      'read',
      'presence',
    ]);
  });

  it('suppresses sticker, voice and media without touching the transport', async () => {
    const { service, messaging, media, bindings, keyOf } = harness();
    allow(bindings, keyOf);
    const base = {
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      dryRun: true,
    };

    const sticker = await service.sendSticker({ ...base, fileId: 'AgADAAAA' });
    const voice = await service.sendVoice({
      ...base,
      base64: Buffer.from('ogg').toString('base64'),
      mimeType: 'audio/ogg',
    });
    const photo = await service.sendMedia({
      ...base,
      base64: Buffer.from('jpeg').toString('base64'),
      mimeType: 'image/jpeg',
    });

    expect(sticker.id).toBeLessThan(0);
    expect(voice.id).toBeLessThan(0);
    expect(photo.id).toBeLessThan(0);
    expect(messaging.sendMedia).not.toHaveBeenCalled();
    expect(media.sendSticker).not.toHaveBeenCalled();
    expect(media.sendVoice).not.toHaveBeenCalled();
  });

  it('global EVE_DRY_RUN suppresses even without a request flag', async () => {
    vi.stubEnv('EVE_DRY_RUN', 'true');
    const { service, messaging, bindings, keyOf } = harness();
    allow(bindings, keyOf);

    await service.sendText({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      text: 'kill switch',
    });

    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });
});
