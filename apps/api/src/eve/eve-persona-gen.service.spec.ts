import { describe, expect, it, vi } from 'vitest';
import {
  EVE_PERSONA_DOC_KINDS,
  EvePersonaGenService,
  type EvePersonaDocView,
} from './eve-persona-gen.service.js';

const PERSONA_ID = 'persona-1';
const NOW = new Date('2026-11-27T10:00:00.000Z');

const PERSONA = {
  id: PERSONA_ID,
  name: 'Алиса',
  age: 22,
  nationality: 'RU',
  vibe: 'спокойная, но с колючками',
};

interface HarnessOptions {
  persona?: typeof PERSONA | null;
  docs?: Array<{ kind: string; content: string }>;
  configured?: boolean;
  reply?: string | null;
  chatError?: Error;
}

function harness(options: HarnessOptions = {}) {
  const docs = new Map<string, EvePersonaDocView>();
  for (const doc of options.docs ?? []) {
    docs.set(doc.kind, {
      id: `doc-${doc.kind}`,
      personaId: PERSONA_ID,
      kind: doc.kind,
      content: doc.content,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  const llm = {
    isConfigured: vi.fn(() => options.configured ?? false),
    chat: vi.fn(async () => {
      if (options.chatError) throw options.chatError;
      return options.reply ?? null;
    }),
  };

  const prisma = {
    evePersona: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          where.id === PERSONA_ID
            ? (options.persona === undefined ? PERSONA : options.persona)
            : null,
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...PERSONA,
        ...data,
      })),
    },
    evePersonaDoc: {
      findMany: vi.fn(async () => [...docs.values()]),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { personaId_kind: { personaId: string; kind: string } };
          create: { personaId: string; kind: string; content: string };
          update: { content: string };
        }) => {
          const { kind } = where.personaId_kind;
          const existing = docs.get(kind);
          const row: EvePersonaDocView = existing
            ? { ...existing, ...update, updatedAt: NOW }
            : {
                id: `doc-${kind}`,
                personaId: create.personaId,
                kind,
                content: create.content,
                createdAt: NOW,
                updatedAt: NOW,
              };
          docs.set(kind, row);
          return row;
        },
      ),
    },
  };

  return {
    prisma,
    docs,
    llm,
    service: new EvePersonaGenService(prisma as never, llm as never),
  };
}

/** A structurally valid LLM pack, derived from the template plus a marker. */
function llmPack(marker = 'LLM-версия'): string {
  const template = harness().service.generateDocs(PERSONA);
  return JSON.stringify({
    persona: template.persona.replace('# Алиса', `# Алиса — ${marker}`),
    speech: template.speech.replace('# Речь Алиса', `# Речь Алиса — ${marker}`),
    boundaries: template.boundaries.replace(
      '# Границы Алиса',
      `# Границы Алиса — ${marker}`,
    ),
    communication: template.communication.replace(
      '# Предпочтения в общении Алиса',
      `# Предпочтения в общении Алиса — ${marker}`,
    ),
  });
}

function headings(markdown: string): number {
  return markdown.match(/^## /gm)?.length ?? 0;
}

describe('EvePersonaGenService.generateDocs', () => {
  it('writes four documents with seven sections each', () => {
    const { service } = harness();
    const docs = service.generateDocs(PERSONA);
    for (const kind of EVE_PERSONA_DOC_KINDS) {
      expect(docs[kind]).toContain('# ');
      expect(headings(docs[kind])).toBe(7);
    }
    expect(docs.persona).toContain('Алиса');
    expect(docs.persona).toContain('22');
    expect(docs.persona).toContain('спокойная, но с колючками');
    expect(docs.speech).toContain('## Опечатки');
    expect(docs.boundaries).toContain('## Игнор');
    expect(docs.communication).toContain('## Когда пишет');
  });

  it('does not repeat bullets inside a list section', () => {
    const { service } = harness();
    const docs = service.generateDocs(PERSONA);
    const likes = docs.persona
      .split('## Что ей нравится')[1]
      ?.split('## ')[0] ?? '';
    const bullets = likes
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '));

    expect(bullets).toHaveLength(5);
    expect(new Set(bullets).size).toBe(bullets.length);
  });

  it('is deterministic for the same persona', () => {
    const { service } = harness();
    expect(service.generateDocs(PERSONA)).toEqual(
      service.generateDocs({ ...PERSONA }),
    );
  });

  it('varies the template by name', () => {
    const { service } = harness();
    const first = service.generateDocs(PERSONA);
    const second = service.generateDocs({ ...PERSONA, name: 'Марина' });
    expect(first.persona).not.toBe(second.persona);
  });

  it('generates a weekly busy routine', () => {
    const { service } = harness();
    const slots = service.generateBusySchedule(PERSONA);
    expect(slots.length).toBeGreaterThanOrEqual(3);
    for (const slot of slots) {
      expect(slot.label.length).toBeGreaterThan(2);
      expect(slot.from).toMatch(/^\d{2}:\d{2}$/);
      expect(slot.to).toMatch(/^\d{2}:\d{2}$/);
      expect(slot.from).not.toBe(slot.to);
    }
    expect(service.generateBusySchedule(PERSONA)).toEqual(slots);
  });

  it('handles a unknown nationality and a young age', () => {
    const { service } = harness();
    const docs = service.generateDocs({
      name: 'Дана',
      age: 17,
      nationality: 'XX',
    });
    expect(docs.persona).toContain('Дана');
    expect(docs.persona.toLowerCase()).toContain('школ');
    expect(docs.persona).toContain('XX');
  });
});

describe('EvePersonaGenService.generateDocsLlm', () => {
  it('returns the parsed pack for a valid JSON answer', async () => {
    const { service } = harness({ configured: true, reply: llmPack() });
    const docs = await service.generateDocsLlm(PERSONA);

    expect(docs).not.toBeNull();
    expect(docs?.persona).toContain('LLM-версия');
    expect(docs?.speech).toContain('LLM-версия');
    expect(docs?.boundaries).toContain('LLM-версия');
    expect(docs?.communication).toContain('LLM-версия');
  });

  it('asks for JSON with a persona-aware, assistant-free prompt', async () => {
    const { service, llm } = harness({ configured: true, reply: llmPack() });
    await service.generateDocsLlm(PERSONA);

    const [messages, options] = llm.chat.mock.calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      { temperature: number; maxTokens: number; json: boolean },
    ];
    const prompt = messages.map((message) => message.content).join('\n');

    expect(prompt).toContain('Алиса');
    expect(prompt).toContain('22');
    expect(prompt).toContain('Россия');
    expect(prompt).toContain('спокойная, но с колючками');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('ассистент');
    expect(prompt).toContain('## Опечатки');
    expect(options).toMatchObject({ temperature: 0.9, json: true });
    expect(options.maxTokens).toBeGreaterThanOrEqual(2_000);
    expect(options.maxTokens).toBeLessThanOrEqual(3_000);
  });

  it('returns null without calling the provider when it is not configured', async () => {
    const { service, llm } = harness({ configured: false });
    await expect(service.generateDocsLlm(PERSONA)).resolves.toBeNull();
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('returns null on a non-JSON answer', async () => {
    const { service } = harness({
      configured: true,
      reply: 'вот твои документы, держи',
    });
    await expect(service.generateDocsLlm(PERSONA)).resolves.toBeNull();
  });

  it('returns null when a document misses its seven sections', async () => {
    const pack = JSON.parse(llmPack()) as Record<string, string>;
    pack.speech = pack.speech.split('## Опечатки')[0]!;
    const { service } = harness({ configured: true, reply: JSON.stringify(pack) });

    await expect(service.generateDocsLlm(PERSONA)).resolves.toBeNull();
  });

  it('returns null when a document exceeds 8000 characters', async () => {
    const pack = JSON.parse(llmPack()) as Record<string, string>;
    pack.boundaries = `# Границы\n\n${'а'.repeat(8_100)}`;
    const { service } = harness({ configured: true, reply: JSON.stringify(pack) });

    await expect(service.generateDocsLlm(PERSONA)).resolves.toBeNull();
  });

  it('never throws when the provider call rejects', async () => {
    const { service } = harness({
      configured: true,
      chatError: new Error('timeout'),
    });
    await expect(service.generateDocsLlm(PERSONA)).resolves.toBeNull();
  });
});

describe('EvePersonaGenService.ensureDocs', () => {
  it('creates missing documents and keeps edited ones', async () => {
    const { service, docs } = harness({
      docs: [{ kind: 'persona', content: '# мой текст' }],
    });

    const result = await service.ensureDocs(PERSONA_ID);

    expect(result).toHaveLength(4);
    expect(result.map((doc) => doc.kind)).toEqual([
      'persona',
      'speech',
      'boundaries',
      'communication',
    ]);
    expect(docs.get('persona')?.content).toBe('# мой текст');
    expect(docs.get('speech')?.content).toContain('## Длина сообщений');
  });

  it('fills blank documents', async () => {
    const { service } = harness({
      docs: [{ kind: 'speech', content: '   ' }],
    });

    const result = await service.ensureDocs(PERSONA_ID);
    const speech = result.find((doc) => doc.kind === 'speech');

    expect(speech?.content.trim().length).toBeGreaterThan(0);
  });

  it('uses the LLM pack for missing documents', async () => {
    const { service, docs, llm } = harness({
      configured: true,
      reply: llmPack(),
      docs: [{ kind: 'persona', content: '# мой текст' }],
    });

    await service.ensureDocs(PERSONA_ID);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(docs.get('persona')?.content).toBe('# мой текст');
    expect(docs.get('speech')?.content).toContain('LLM-версия');
    expect(docs.get('boundaries')?.content).toContain('LLM-версия');
  });

  it('falls back to the template when the LLM answer is unusable', async () => {
    const { service, docs, llm } = harness({
      configured: true,
      reply: '{ не json',
    });

    await service.ensureDocs(PERSONA_ID);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(docs.get('speech')?.content).toContain('## Длина сообщений');
    expect(docs.get('speech')?.content).not.toContain('LLM-версия');
  });

  it('falls back to the template when the provider returns null', async () => {
    const { service, docs } = harness({ configured: true, reply: null });

    await service.ensureDocs(PERSONA_ID);

    expect(docs.get('persona')?.content).toContain('## Бэкграунд');
    expect(docs.get('communication')?.content).toContain('## Когда пишет');
  });

  it('skips the LLM when every document already exists', async () => {
    const { service, llm } = harness({
      persona: {
        ...PERSONA,
        busySchedule:
          '[{"label":"пары","days":["mon","tue"],"from":"09:00","to":"15:00"}]',
      },
      configured: true,
      reply: llmPack(),
      docs: EVE_PERSONA_DOC_KINDS.map((kind) => ({
        kind,
        content: `# ручной ${kind}`,
      })),
    });

    await service.ensureDocs(PERSONA_ID);

    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('rejects an unknown persona', async () => {
    const { service } = harness({ persona: null });
    await expect(service.ensureDocs('nope')).rejects.toMatchObject({
      response: { code: 'EVE_PERSONA_NOT_FOUND' },
    });
  });
});

describe('EvePersonaGenService.generate', () => {
  it('overwrites every document', async () => {
    const { service, docs } = harness({
      docs: EVE_PERSONA_DOC_KINDS.map((kind) => ({
        kind,
        content: 'старый текст',
      })),
    });

    const result = await service.generate(PERSONA_ID);

    expect(result).toHaveLength(4);
    for (const kind of EVE_PERSONA_DOC_KINDS) {
      expect(docs.get(kind)?.content).not.toBe('старый текст');
    }
    expect(docs.get('persona')?.content).toContain('## Бэкграунд');
  });

  it('uses the LLM pack when it is valid', async () => {
    const { service, docs, llm } = harness({
      configured: true,
      reply: llmPack('Свежая версия'),
    });

    await service.generate(PERSONA_ID);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    for (const kind of EVE_PERSONA_DOC_KINDS) {
      expect(docs.get(kind)?.content).toContain('Свежая версия');
    }
  });

  it('falls back to the template when the LLM fails', async () => {
    const { service, docs } = harness({
      configured: true,
      reply: 'не json',
    });

    await service.generate(PERSONA_ID);

    expect(docs.get('persona')?.content).toContain('## Бэкграунд');
    expect(docs.get('persona')?.content).not.toContain('LLM-версия');
  });
});

describe('EvePersonaGenService.saveDoc', () => {
  it('saves a valid document', async () => {
    const { service, docs } = harness();
    const saved = await service.saveDoc(
      PERSONA_ID,
      'boundaries',
      '# мои границы\n',
    );

    expect(saved.kind).toBe('boundaries');
    expect(docs.get('boundaries')?.content).toBe('# мои границы\n');
  });

  it('rejects an invalid kind', async () => {
    const { service } = harness();
    await expect(
      service.saveDoc(PERSONA_ID, 'secrets', 'x'),
    ).rejects.toMatchObject({ response: { code: 'EVE_DOC_KIND_INVALID' } });
  });

  it('rejects empty content', async () => {
    const { service } = harness();
    await expect(
      service.saveDoc(PERSONA_ID, 'persona', '   '),
    ).rejects.toMatchObject({ response: { code: 'EVE_DOC_CONTENT_REQUIRED' } });
  });
});
