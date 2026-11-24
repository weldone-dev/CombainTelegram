import { describe, expect, it, vi } from 'vitest';
import type {
  AiChatSkillModel,
  SkillModel,
  SoulSkillModel,
} from '@repo/database';
import { AiChatSkillsService } from './ai-chat-skills.service.js';

const USER_ID = 'local';
const OTHER_USER = 'someone-else';
const ACCOUNT_ID = 'account-1';
const SOUL_ID = 'soul-1';
const CHAT_ID = 1830539716;
const TOPIC_ID = 42;
const NOW = new Date('2026-11-24T10:00:00.000Z');

function skill(slug: string, overrides: Partial<SkillModel> = {}): SkillModel {
  return {
    id: `skill-${slug}`,
    slug,
    name: slug,
    description: '',
    instructions: `# ${slug}`,
    tools: JSON.stringify(['messages_send']),
    origin: 'system',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mapKey(accountId: string, chatId: bigint, threadId: number): string {
  return `${accountId}:${chatId.toString()}:${threadId}`;
}

function harness(options: { catalog?: SkillModel[]; soulSlugs?: string[] } = {}) {
  const catalog = options.catalog ?? [
    skill('dm-assistant'),
    skill('human-style'),
    skill('memory-curator'),
  ];
  const links: SoulSkillModel[] = (options.soulSlugs ?? ['dm-assistant', 'human-style']).map(
    (slug) => ({
      soulId: SOUL_ID,
      skillId: `skill-${slug}`,
    }),
  );
  const rows = new Map<string, AiChatSkillModel>();
  let sequence = 0;

  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === ACCOUNT_ID && where.userId === USER_ID
            ? { id: ACCOUNT_ID }
            : null,
      ),
    },
    soul: {
      findUnique: vi.fn(async ({ where }: { where: { accountId: string } }) =>
        where.accountId === ACCOUNT_ID ? { id: SOUL_ID } : null,
      ),
    },
    soulSkill: {
      findMany: vi.fn(
        async ({ where }: { where: { soulId: string } }) =>
          links
            .filter((link) => link.soulId === where.soulId)
            .map((link) => ({
              ...link,
              skill: catalog.find((item) => item.id === link.skillId),
            })),
      ),
    },
    skill: {
      findMany: vi.fn(
        async ({ where }: { where: { slug: { in: string[] } } }) =>
          catalog.filter((item) => where.slug.in.includes(item.slug)),
      ),
    },
    aiChatSkill: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            accountId_chatId_threadId: {
              accountId: string;
              chatId: bigint;
              threadId: number;
            };
          };
        }) => {
          const key = where.accountId_chatId_threadId;
          return rows.get(mapKey(key.accountId, key.chatId, key.threadId)) ?? null;
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: {
            accountId_chatId_threadId: {
              accountId: string;
              chatId: bigint;
              threadId: number;
            };
          };
          create: {
            accountId: string;
            chatId: bigint;
            threadId: number;
            skillSlugs: string;
          };
          update: { skillSlugs: string };
        }): Promise<AiChatSkillModel> => {
          const key = where.accountId_chatId_threadId;
          const mapKeyValue = mapKey(key.accountId, key.chatId, key.threadId);
          const existing = rows.get(mapKeyValue);
          const row: AiChatSkillModel = {
            id: existing?.id ?? `chat-skill-${++sequence}`,
            accountId: key.accountId,
            chatId: key.chatId,
            threadId: key.threadId,
            skillSlugs: existing ? update.skillSlugs : create.skillSlugs,
            createdAt: existing?.createdAt ?? NOW,
            updatedAt: NOW,
          };
          rows.set(mapKeyValue, row);
          return row;
        },
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; chatId: bigint; threadId: number };
        }) => {
          const removed = rows.delete(
            mapKey(where.accountId, where.chatId, where.threadId),
          );
          return { count: removed ? 1 : 0 };
        },
      ),
    },
  };

  const service = new AiChatSkillsService(prisma as never);
  return { service, prisma, rows, catalog };
}

describe('AiChatSkillsService.view', () => {
  it('falls back to the soul skills with no override', async () => {
    const { service } = harness();

    const view = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(view.source).toBe('soul');
    expect(view.defaults).toEqual(['dm-assistant', 'human-style']);
    expect(view.effective).toEqual(view.defaults);
    expect(view.skills.map((item) => item.slug)).toEqual(view.effective);
  });

  it('prefers the chat override over the soul skills', async () => {
    const { service } = harness();
    await service.set(USER_ID, ACCOUNT_ID, CHAT_ID, [
      'memory-curator',
      'human-style',
    ]);

    const view = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(view.source).toBe('chat');
    expect(view.effective).toEqual(['memory-curator', 'human-style']);
    // The soul defaults stay visible so the UI can offer "reset".
    expect(view.defaults).toEqual(['dm-assistant', 'human-style']);
    expect(view.skills.map((item) => item.slug)).toEqual(view.effective);
  });

  it('treats an empty override as "no skills", not a fallback', async () => {
    const { service } = harness();
    await service.set(USER_ID, ACCOUNT_ID, CHAT_ID, []);

    const view = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(view.source).toBe('chat');
    expect(view.effective).toEqual([]);
    expect(view.skills).toEqual([]);
  });

  it('scopes the override to the forum topic', async () => {
    const { service } = harness();
    await service.set(USER_ID, ACCOUNT_ID, CHAT_ID, ['memory-curator'], TOPIC_ID);

    const topic = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID, TOPIC_ID);
    const chat = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(topic.source).toBe('chat');
    expect(topic.effective).toEqual(['memory-curator']);
    expect(chat.source).toBe('soul');
    expect(chat.effective).toEqual(['dm-assistant', 'human-style']);
  });
});

describe('AiChatSkillsService.set', () => {
  it('rejects unknown slugs without writing', async () => {
    const { service, prisma } = harness();

    await expect(
      service.set(USER_ID, ACCOUNT_ID, CHAT_ID, ['dm-assistant', 'nope']),
    ).rejects.toMatchObject({
      response: { code: 'SKILL_NOT_FOUND' },
    });
    expect(prisma.aiChatSkill.upsert).not.toHaveBeenCalled();
  });

  it('rejects a non-array payload', async () => {
    const { service, prisma } = harness();

    await expect(
      service.set(USER_ID, ACCOUNT_ID, CHAT_ID, 'dm-assistant'),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma.aiChatSkill.upsert).not.toHaveBeenCalled();
  });

  it('dedupes and trims slugs before storing', async () => {
    const { service, rows } = harness();

    await service.set(USER_ID, ACCOUNT_ID, CHAT_ID, [
      ' dm-assistant ',
      'memory-curator',
      'dm-assistant',
    ]);

    const raw = rows.get(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0))?.skillSlugs;
    expect(raw ? (JSON.parse(raw) as string[]) : null).toEqual([
      'dm-assistant',
      'memory-curator',
    ]);
  });

  it('rejects an account owned by another user', async () => {
    const { service, prisma } = harness();

    await expect(
      service.set(OTHER_USER, ACCOUNT_ID, CHAT_ID, ['dm-assistant']),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
    expect(prisma.aiChatSkill.upsert).not.toHaveBeenCalled();
  });
});

describe('AiChatSkillsService.remove', () => {
  it('drops the override and restores the soul skills', async () => {
    const { service } = harness();
    await service.set(USER_ID, ACCOUNT_ID, CHAT_ID, ['memory-curator']);

    const removed = await service.remove(USER_ID, ACCOUNT_ID, CHAT_ID);
    const view = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(removed).toEqual({ removed: true });
    expect(view.source).toBe('soul');
    expect(view.effective).toEqual(['dm-assistant', 'human-style']);
  });

  it('reports a missing override', async () => {
    const { service } = harness();
    expect(await service.remove(USER_ID, ACCOUNT_ID, CHAT_ID)).toEqual({
      removed: false,
    });
  });
});

describe('AiChatSkillsService.resolveSkillSlugs', () => {
  it('returns the chat override when present', async () => {
    const { service } = harness();
    await service.set(USER_ID, ACCOUNT_ID, CHAT_ID, ['memory-curator']);

    await expect(
      service.resolveSkillSlugs(ACCOUNT_ID, CHAT_ID),
    ).resolves.toEqual(['memory-curator']);
    await expect(
      service.resolveSkillSlugs(ACCOUNT_ID, CHAT_ID, TOPIC_ID),
    ).resolves.toEqual(['dm-assistant', 'human-style']);
  });

  it('returns the soul skills when no override exists', async () => {
    const { service } = harness();

    await expect(
      service.resolveSkillSlugs(ACCOUNT_ID, CHAT_ID),
    ).resolves.toEqual(['dm-assistant', 'human-style']);
  });

  it('returns no skills for an account without a soul', async () => {
    const { service } = harness();

    await expect(
      service.resolveSkillSlugs('account-without-soul', CHAT_ID),
    ).resolves.toEqual([]);
  });
});
