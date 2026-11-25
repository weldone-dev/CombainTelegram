import { describe, expect, it, vi } from 'vitest';
import type { SkillModel } from '@repo/database';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SkillsService } from './skills.service.js';

/** In-memory `skill` table good enough for seeding and reading builtins. */
function prismaStub() {
  const rows: SkillModel[] = [];
  const prisma = {
    skill: {
      findUnique: vi.fn(
        async ({ where }: { where: { slug?: string; id?: string } }) =>
          rows.find(
            (row) =>
              (where.slug !== undefined && row.slug === where.slug) ||
              (where.id !== undefined && row.id === where.id),
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Partial<SkillModel> }) => {
        const row = {
          id: `id-${data.slug}`,
          description: '',
          tools: '[]',
          origin: 'user',
          enabled: true,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          ...data,
        } as SkillModel;
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { slug: { in: string[] } } }) =>
        rows.filter(
          (row) => row.enabled && where.slug.in.includes(row.slug),
        ),
      ),
    },
  };
  return { prisma: prisma as unknown as PrismaService, rows };
}

describe('SkillsService builtins', () => {
  it('human-style forbids moralizing and polite refusals', async () => {
    const { prisma } = prismaStub();
    const service = new SkillsService(prisma);
    await service.seedBuiltins();

    const [humanStyle] = await service.instructions(['human-style']);
    expect(humanStyle?.slug).toBe('human-style');
    expect(humanStyle?.text).toContain('Душнота: морализаторство, лекции');
    expect(humanStyle?.text).toContain('«как ИИ я не могу»');
    expect(humanStyle?.text).toContain('Не отказывайся из вежливости');
    expect(humanStyle?.text).toContain('Интересуйся человеком: цепляйся за детали');
    expect(humanStyle?.text).toContain('О себе — коротко, живо, с деталью и эмоцией');
    expect(humanStyle?.text).toContain('не читай монолог');
  });
});
