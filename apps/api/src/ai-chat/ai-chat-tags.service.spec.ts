import { describe, expect, it, vi } from 'vitest';
import type { AiChatTagModel } from '@repo/database';
import {
  AiChatTagsService,
  MAX_TAG_CHARS,
  normalizeTag,
} from './ai-chat-tags.service.js';

const USER_ID = 'local';
const OTHER_USER = 'someone-else';
const ACCOUNT_ID = 'account-1';
const CHAT_ID = 42;
const NOW = new Date('2026-11-25T12:00:00.000Z');

function keyOf(accountId: string, chatId: bigint, tag: string): string {
  return `${accountId}:${chatId.toString()}:${tag}`;
}

/** In-memory stand-in for the `AiChatTag` table. */
function harness() {
  const rows = new Map<string, AiChatTagModel>();
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
    aiChatTag: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; chatId: bigint };
        }) =>
          [...rows.values()]
            .filter(
              (row) =>
                row.accountId === where.accountId &&
                row.chatId === where.chatId,
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((row) => ({ tag: row.tag })),
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: {
            accountId_chatId_tag: {
              accountId: string;
              chatId: bigint;
              tag: string;
            };
          };
          create: { accountId: string; chatId: bigint; tag: string };
        }) => {
          const unique = where.accountId_chatId_tag;
          const key = keyOf(unique.accountId, unique.chatId, unique.tag);
          const existing = rows.get(key);
          if (existing) return existing;
          const row: AiChatTagModel = {
            id: `tag-${++sequence}`,
            accountId: create.accountId,
            chatId: create.chatId,
            tag: create.tag,
            createdAt: NOW,
          };
          rows.set(key, row);
          return row;
        },
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; chatId: bigint; tag: string };
        }) => ({
          count: rows.delete(
            keyOf(where.accountId, where.chatId, where.tag),
          )
            ? 1
            : 0,
        }),
      ),
    },
  };

  const service = new AiChatTagsService(prisma as never);
  return { service, prisma, rows };
}

describe('normalizeTag', () => {
  it('trims and lower-cases', () => {
    expect(normalizeTag('  VIP  ')).toBe('vip');
    expect(normalizeTag('Follow-Up')).toBe('follow-up');
    expect(normalizeTag('lead_2026')).toBe('lead_2026');
    expect(normalizeTag('важный')).toBe('важный');
  });

  it('rejects empty, over-long and non-string tags', () => {
    expect(() => normalizeTag('   ')).toThrow(/must not be empty/);
    expect(() => normalizeTag('a'.repeat(MAX_TAG_CHARS + 1))).toThrow(
      /at most 32 characters/,
    );
    expect(() => normalizeTag(42)).toThrow(/must be a string/);
    expect(() => normalizeTag(undefined)).toThrow(/must be a string/);
  });

  it('rejects characters outside letters, digits, "_" and "-"', () => {
    expect(() => normalizeTag('two words')).toThrow(/may contain only/);
    expect(() => normalizeTag('vip!')).toThrow(/may contain only/);
    expect(() => normalizeTag('a.b')).toThrow(/may contain only/);
  });

  it('accepts the length boundary', () => {
    const tag = 'a'.repeat(MAX_TAG_CHARS);
    expect(normalizeTag(tag)).toBe(tag);
  });
});

describe('AiChatTagsService.list', () => {
  it('returns an empty list for a fresh chat', async () => {
    const { service } = harness();
    await expect(service.list(ACCOUNT_ID, CHAT_ID)).resolves.toEqual([]);
  });

  it('returns the tags of the chat in insertion order', async () => {
    const { service } = harness();
    await service.add(ACCOUNT_ID, CHAT_ID, 'lead');
    await service.add(ACCOUNT_ID, CHAT_ID, 'vip');

    await expect(service.list(ACCOUNT_ID, CHAT_ID)).resolves.toEqual([
      'lead',
      'vip',
    ]);
  });

  it('does not mix chats or accounts', async () => {
    const { service } = harness();
    await service.add(ACCOUNT_ID, CHAT_ID, 'vip');
    await service.add(ACCOUNT_ID, CHAT_ID + 1, 'lead');
    await service.add('account-2', CHAT_ID, 'other');

    await expect(service.list(ACCOUNT_ID, CHAT_ID)).resolves.toEqual(['vip']);
  });
});

describe('AiChatTagsService.add', () => {
  it('stores the normalised tag', async () => {
    const { service, rows } = harness();
    await service.add(ACCOUNT_ID, CHAT_ID, '  VIP ');

    expect([...rows.values()]).toHaveLength(1);
    expect([...rows.values()][0]?.tag).toBe('vip');
  });

  it('is idempotent for the same normalised tag', async () => {
    const { service, rows } = harness();
    const first = await service.add(ACCOUNT_ID, CHAT_ID, 'vip');
    const second = await service.add(ACCOUNT_ID, CHAT_ID, ' VIP ');

    expect(second).toEqual(first);
    expect(second).toEqual(['vip']);
    expect(rows.size).toBe(1);
  });

  it('rejects an invalid tag without writing', async () => {
    const { service, prisma } = harness();
    await expect(
      service.add(ACCOUNT_ID, CHAT_ID, 'not a tag'),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma.aiChatTag.upsert).not.toHaveBeenCalled();
  });
});

describe('AiChatTagsService.remove', () => {
  it('removes one tag and reports the remaining ones', async () => {
    const { service } = harness();
    await service.add(ACCOUNT_ID, CHAT_ID, 'lead');
    await service.add(ACCOUNT_ID, CHAT_ID, 'vip');

    await expect(
      service.remove(ACCOUNT_ID, CHAT_ID, ' LEAD '),
    ).resolves.toEqual({ removed: true, tags: ['vip'] });
  });

  it('is idempotent when the tag is absent', async () => {
    const { service } = harness();
    await expect(
      service.remove(ACCOUNT_ID, CHAT_ID, 'ghost'),
    ).resolves.toEqual({ removed: false, tags: [] });
  });

  it('leaves the other chats untouched', async () => {
    const { service } = harness();
    await service.add(ACCOUNT_ID, CHAT_ID, 'vip');
    await service.add(ACCOUNT_ID, CHAT_ID + 1, 'vip');

    await service.remove(ACCOUNT_ID, CHAT_ID, 'vip');

    await expect(service.list(ACCOUNT_ID, CHAT_ID)).resolves.toEqual([]);
    await expect(service.list(ACCOUNT_ID, CHAT_ID + 1)).resolves.toEqual([
      'vip',
    ]);
  });
});

describe('AiChatTagsService.requireAccount', () => {
  it('accepts the owner', async () => {
    const { service } = harness();
    await expect(
      service.requireAccount(USER_ID, ACCOUNT_ID),
    ).resolves.toBeUndefined();
  });

  it('reports a foreign account as not found', async () => {
    const { service } = harness();
    await expect(
      service.requireAccount(OTHER_USER, ACCOUNT_ID),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'ACCOUNT_NOT_FOUND' },
    });
  });
});
