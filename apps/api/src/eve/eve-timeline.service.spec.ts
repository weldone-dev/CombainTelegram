import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { EveTimelineService } from './eve-timeline.service.js';

const PERSONA = 'persona-1';
const ACCOUNT = 'account-1';
const CHAT = 42n;

function harness() {
  const logs = [
    {
      id: 'log-3',
      line: '  -> ignored (busy)',
      createdAt: new Date('2026-11-28T10:00:03.000Z'),
    },
    {
      id: 'log-2',
      line: '  -> она: привет!',
      createdAt: new Date('2026-11-28T10:00:02.000Z'),
    },
    {
      id: 'log-1',
      line: '[2026-11-28T10:00:01.000Z] он(7): как дела?',
      createdAt: new Date('2026-11-28T10:00:02.000Z'),
    },
  ];
  const changes = [
    {
      id: 'change-1',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      source: 'inbound',
      delta: JSON.stringify({ interest: 2 }),
      before: JSON.stringify({
        interest: 10,
        trust: 0,
        attraction: 0,
        annoyance: 0,
        cringe: 0,
      }),
      after: JSON.stringify({
        interest: 12,
        trust: 0,
        attraction: 0,
        annoyance: 0,
        cringe: 0,
      }),
      stageFrom: null,
      stageTo: null,
      conflictBefore: null,
      conflictAfter: null,
      turnKey: 'inbound:event-a',
      createdAt: new Date('2026-11-28T10:00:01.000Z'),
    },
  ];
  const prisma = {
    eveSessionLog: {
      findMany: vi.fn(async () => logs),
    },
    eveRelationshipChange: {
      findMany: vi.fn(async () => changes),
    },
  };
  const service = new EveTimelineService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('EveTimelineService', () => {
  it('merges messages, ignores and relationship changes newest first', async () => {
    const { service } = harness();

    const result = await service.timeline({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '42',
    });

    expect(result.entries.map((entry) => entry.kind)).toEqual([
      'ignored',
      'reply',
      'incoming',
      'relationship',
    ]);
    const incoming = result.entries.find((entry) => entry.kind === 'incoming');
    expect(incoming).toMatchObject({
      kind: 'incoming',
      text: 'как дела?',
      messageId: 7,
      at: '2026-11-28T10:00:02.000Z',
    });
    const ignored = result.entries.find((entry) => entry.kind === 'ignored');
    expect(ignored).toMatchObject({ kind: 'ignored', reason: 'busy' });
    const change = result.entries.find(
      (entry) => entry.kind === 'relationship',
    );
    expect(change).toMatchObject({
      kind: 'relationship',
      delta: { interest: 2 },
      before: { interest: 10 },
      after: { interest: 12 },
      source: 'inbound',
    });
  });

  it('passes the thread, limit and before cursor to the queries', async () => {
    const { service, prisma } = harness();

    await service.timeline({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '42',
      threadId: '3',
      limit: '10',
      before: '2026-11-28T11:00:00.000Z',
    });

    const where = prisma.eveSessionLog.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 3,
      createdAt: { lt: new Date('2026-11-28T11:00:00.000Z') },
    });
    expect(prisma.eveRelationshipChange.findMany.mock.calls[0]![0].take).toBe(
      10,
    );
  });
});
