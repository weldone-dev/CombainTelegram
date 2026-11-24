import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { SkillModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { notFound, apiError } from '../common/api-error.js';
import type { SkillView } from './ai.types.js';

export interface SkillInput {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  tools?: unknown;
  enabled?: unknown;
}
export interface SkillUpdate {
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  tools?: unknown;
  enabled?: unknown;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return stringList(parsed);
    } catch {
      return value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseTools(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? stringList(parsed) : [];
  } catch {
    return [];
  }
}

function view(skill: SkillModel): SkillView {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    tools: parseTools(skill.tools),
    origin: skill.origin,
    enabled: skill.enabled,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

interface BuiltinSkill {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
}

const SOUL_CREATOR_PROMPT = `# Скилл: создание и редактирование душ

Ты — «мастер душ»: помогаешь владельцу этого приложения создать душу (персону)
для Telegram-аккаунта и настроить её поведение.

Правила:
1. Сначала уточни, для какого аккаунта создаётся душа. Если владелец не сказал,
   вызови accounts_list и спроси.
2. Проведи короткое интервью: имя души, кто она по сути, тон общения, цели,
   границы (чего нельзя), язык, стиль, чего избегать.
3. Собери черновик в 5–8 строк и покажи владельцу. Не сохраняй без
   подтверждения.
4. Сохраняй через soul_update. Поля: name, essence, tone, goals, boundaries,
   language, systemPrompt, mode. По умолчанию mode = "off": автоответы
   включаются только по явному согласию.
5. Скиллы создавай через skill_create, автоматизации — через automation_create.
   Всегда объясняй, что именно ты создашь, и жди «да».
6. Никогда не отправляй сообщения живым людям из этой роли. Твоя задача —
   редактировать конфигурацию, а не переписку.
7. Если владелец просит изменить разрешения — покажи текущие через
   policy_get, предложи точный набор флагов и меняй только после
   подтверждения.
8. Отвечай по-русски, коротко и по делу. Не используй Markdown-таблицы.`;

const DM_ASSISTANT_PROMPT = `# Скилл: переписка от имени души

Ты ведёшь личную переписку от имени аккаунта, следуя душе.

Правила:
- 1–3 коротких предложения, как в мессенджере. Без Markdown, списков и заголовков.
- Не упоминай, что ты ИИ или бот. Не говори о «душе» и настройках.
- Не выдумывай факты о человеке. Если чего-то не знаешь — уточни.
- Не отправляй ссылки, файлы и платёжные данные без прямой просьбы.
- Не обещай действий, которые не можешь выполнить.
- Держись тона и границ из души. Если сообщение нарушает границы — вежливо
  уйди от темы.
- Отвечай на языке собеседника, если душа не требует иного.`;

const HUMAN_STYLE_PROMPT = `# Скилл: живая речь

Пиши так, как пишет человек в мессенджере, а не как модель. Цель — чтобы по
тексту нельзя было заподозрить ИИ.

Как писать:
- 1–2 коротких предложения, редко 3. Как будто печатаешь на телефоне.
- Простые слова: «норм», «ага», «ладно», «кстати», «вроде», «похоже», «блин» —
  если это не противоречит тону души.
- Можно начинать с маленькой буквы и не ставить точку в конце. Иногда — с «ну»,
  «хм», «слушай».
- Живая реакция сначала, мысль потом: «ого», «серьёзно?», «да ладно», «понял».
- Рваный ритм: короткая фраза, потом чуть длиннее. Без ровных абзацев.
- Иногда вместо готового ответа — встречный вопрос по теме.
- Одна мысль — одно сообщение. Без вступления и вывода.

Запрещено:
- «Конечно», «разумеется», «отличный вопрос», «надеюсь, это поможет»,
  «дай знать, если», «итак», «в заключение», «стоит отметить».
- Списки, нумерация, заголовки, жирный текст, таблицы, перечисления через
  двоеточие.
- Длинное тире (—) не используй вообще: ставь точку, запятую или перестрой
  фразу. Плюс точка с запятой и канцелярит: «является», «осуществлять»,
  «данный», «в рамках», «необходимо отметить».
- Пересказ вопроса и «как вы уже сказали», «по вашим словам».
- Симметричные конструкции: «не только…, но и», «во-первых…, во-вторых…».
- Пачки эмодзи. Максимум один, чаще ни одного.
- Извинения на ровном месте и обещания помочь в каждом сообщении.
- Идеальная пунктуация везде: иногда её отсутствие естественнее.

Перед отправкой проверь: звучит как письмо или пресс-релиз — перепиши короче и
проще. Можно короче — значит, короче.

Примеры:
- Плохо: «Конечно! Программирование — это замечательный способ развиваться.
  Надеюсь, это поможет!»
  Хорошо: «да, код это кайф. а что пишешь?»
- Плохо: «Я не совсем понимаю, о чём идёт речь. Не могли бы вы уточнить?»
  Хорошо: «не поняла, о чём ты. поясни»
- Плохо: «Это зависит от нескольких факторов: во-первых, контекст, во-вторых,
  опыт.»
  Хорошо: «смотря что. скинь пример»`;

const MEMORY_CURATOR_PROMPT = `# Скилл: память

Ты обновляешь долговременную память диалога. На вход дают старые реплики и
текущую сводку. Верни JSON без пояснений:
{"summary":"...", "facts":[{"kind":"fact|preference|event|profile","content":"...","importance":1}]}
Правила:
- summary: 3–6 предложений о человеке, отношениях и важных договорённостях.
- facts: только устойчивые факты (имя, город, работа, привычки, договорённости).
  Не включай мелочи и то, что уже есть в сводке.
- Не выдумывай. Если фактов нет — пустой массив.
- Пиши по-русски, если диалог на русском.`;

const AUTOMATION_BUILDER_PROMPT = `# Скилл: автоматизации

Ты помогаешь создать автоматизацию. Уточни:
1. Триггер: расписание (каждые N минут / ежедневно в HH:MM) или входящее
   личное сообщение (фильтр по чатам/ключевым словам).
2. Действие: запустить агента с промптом, отправить сообщение или сжать память.
3. Аккаунт и ограничения (кому можно писать).

Покажи итоговый JSON триггера/действия, объясни последствия и создай через
automation_create только после подтверждения. По умолчанию автоматизация
выключена (enabled=false), пока владелец не попросит включить.`;

const TELEGRAM_ASSISTANT_PROMPT = `# Скилл: ассистент аккаунта

Ты — персональный ассистент одного Telegram-аккаунта. Умеешь:
- читать чаты и историю, искать сообщения;
- отвечать на вопросы по переписке;
- готовить черновики ответов;
- управлять душой, скиллами и автоматизациями этого аккаунта.

Правила:
- Ничего не отправляй без явной команды владельца.
- Перед отправкой покажи текст и спроси подтверждение, если это не автоответ
  по настроенной душе.
- Не раскрывай чужие личные данные и содержимое переписок третьим лицам.
- Отвечай по-русски, кратко.`;

const BUILTINS: BuiltinSkill[] = [
  {
    slug: 'soul-creator',
    name: 'Создание души',
    description:
      'Интервью и редактирование души аккаунта: персона, тон, цели, границы.',
    instructions: SOUL_CREATOR_PROMPT,
    tools: [
      'accounts_list',
      'accounts_get',
      'souls_list',
      'soul_get',
      'soul_update',
      'skills_list',
      'skill_get',
      'skill_create',
      'skill_update',
      'automations_list',
      'automation_create',
      'automation_update',
      'memory_view',
      'policy_get',
      'policy_update',
      'bots_list',
      'settings_get',
    ],
  },
  {
    slug: 'dm-assistant',
    name: 'Переписка от имени души',
    description: 'Короткие ответы в личных сообщениях в тоне души.',
    instructions: DM_ASSISTANT_PROMPT,
    tools: [
      'chats_get',
      'messages_history',
      'memory_view',
      'memory_add',
      'messages_send',
    ],
  },
  {
    slug: 'human-style',
    name: 'Живая речь',
    description:
      'Пишет как человек в мессенджере: без ИИ-канцелярита, списков и шаблонных фраз.',
    instructions: HUMAN_STYLE_PROMPT,
    tools: [],
  },
  {
    slug: 'memory-curator',
    name: 'Куратор памяти',
    description: 'Сжатие краткосрочной памяти в сводку и факты.',
    instructions: MEMORY_CURATOR_PROMPT,
    tools: ['memory_view', 'memory_summarize', 'memory_add'],
  },
  {
    slug: 'automation-builder',
    name: 'Конструктор автоматизаций',
    description: 'Создание триггеров и действий по описанию на естественном языке.',
    instructions: AUTOMATION_BUILDER_PROMPT,
    tools: [
      'accounts_list',
      'automations_list',
      'automation_create',
      'automation_update',
      'skills_list',
    ],
  },
  {
    slug: 'telegram-assistant',
    name: 'Ассистент аккаунта',
    description: 'Чтение переписки, черновики и управление настройками аккаунта.',
    instructions: TELEGRAM_ASSISTANT_PROMPT,
    tools: [
      'accounts_list',
      'accounts_get',
      'chats_list',
      'chats_get',
      'chats_search',
      'messages_history',
      'messages_search',
      'messages_send',
      'soul_get',
      'soul_update',
      'memory_view',
      'memory_add',
      'memory_summarize',
      'skills_list',
      'skill_create',
      'automations_list',
      'automation_create',
      'automation_update',
    ],
  },
];

/**
 * Skills are instruction packs stored in the database so both the user and the
 * agent can author them. Built-in packs are seeded once and never overwritten:
 * the owner may edit them freely.
 */
@Injectable()
export class SkillsService implements OnModuleInit {
  private readonly logger = new Logger(SkillsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedBuiltins();
    } catch (error) {
      this.logger.warn(
        `Could not seed AI skills: ${(error as Error).message}`,
      );
    }
  }

  async seedBuiltins(): Promise<void> {
    for (const builtin of BUILTINS) {
      const existing = await this.prisma.skill.findUnique({
        where: { slug: builtin.slug },
      });
      if (existing) continue;
      await this.prisma.skill.create({
        data: {
          slug: builtin.slug,
          name: builtin.name,
          description: builtin.description,
          instructions: builtin.instructions,
          tools: JSON.stringify(builtin.tools),
          origin: 'system',
          enabled: true,
        },
      });
    }
  }

  async list(): Promise<SkillView[]> {
    const rows = (await this.prisma.skill.findMany({
      orderBy: [{ origin: 'asc' }, { name: 'asc' }],
    })) as SkillModel[];
    return rows.map(view);
  }

  async get(idOrSlug: string): Promise<SkillView | null> {
    const row = (await this.prisma.skill.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    })) as SkillModel | null;
    return row ? view(row) : null;
  }

  async require(idOrSlug: string): Promise<SkillView> {
    const skill = await this.get(idOrSlug);
    if (!skill) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
    return skill;
  }

  async create(input: SkillInput): Promise<SkillView> {
    const slug = text(input.slug).toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw apiError(
        'INVALID_SLUG',
        'slug must match [a-z0-9][a-z0-9_-]{1,63}',
        400,
      );
    }
    const name = text(input.name, slug);
    const instructions = text(input.instructions);
    if (!instructions) {
      throw apiError(
        'INVALID_INSTRUCTIONS',
        'instructions must not be empty',
        400,
      );
    }
    const existing = await this.prisma.skill.findUnique({ where: { slug } });
    if (existing) {
      throw apiError('SKILL_EXISTS', `Skill "${slug}" already exists`, 409);
    }
    const row = (await this.prisma.skill.create({
      data: {
        slug,
        name,
        description: text(input.description),
        instructions,
        tools: JSON.stringify(stringList(input.tools)),
        origin: 'user',
        enabled: input.enabled !== false,
      },
    })) as SkillModel;
    return view(row);
  }

  async update(idOrSlug: string, input: SkillUpdate): Promise<SkillView> {
    const skill = await this.require(idOrSlug);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = text(input.name, skill.name);
    if (input.description !== undefined) {
      data.description = text(input.description);
    }
    if (input.instructions !== undefined) {
      const instructions = text(input.instructions);
      if (!instructions) {
        throw apiError(
          'INVALID_INSTRUCTIONS',
          'instructions must not be empty',
          400,
        );
      }
      data.instructions = instructions;
    }
    if (input.tools !== undefined) data.tools = JSON.stringify(stringList(input.tools));
    if (input.enabled !== undefined) data.enabled = input.enabled !== false;
    const row = (await this.prisma.skill.update({
      where: { id: skill.id },
      data,
    })) as SkillModel;
    return view(row);
  }

  async remove(idOrSlug: string): Promise<{ removed: boolean }> {
    const skill = await this.require(idOrSlug);
    if (skill.origin === 'system') {
      throw apiError(
        'SYSTEM_SKILL',
        'Built-in skills cannot be deleted; disable or edit them instead.',
        400,
      );
    }
    await this.prisma.skill.delete({ where: { id: skill.id } });
    return { removed: true };
  }

  async forSoul(soulId: string): Promise<SkillView[]> {
    const links = await this.prisma.soulSkill.findMany({
      where: { soulId },
      include: { skill: true },
    });
    return links.map((link) => link.skill as SkillModel).map(view);
  }

  async forBot(botId: string): Promise<SkillView[]> {
    const links = await this.prisma.botSkill.findMany({
      where: { botId },
      include: { skill: true },
    });
    return links
      .map((link) => link.skill as SkillModel)
      .filter((skill) => skill.enabled)
      .map(view);
  }

  async attachToSoul(soulId: string, slugs: unknown): Promise<SkillView[]> {
    const wanted = stringList(slugs);
    const skills =
      wanted.length > 0
        ? ((await this.prisma.skill.findMany({
            where: { slug: { in: wanted } },
          })) as SkillModel[])
        : [];
    const missing = wanted.filter(
      (slug) => !skills.some((skill) => skill.slug === slug),
    );
    if (missing.length > 0) {
      throw apiError(
        'SKILL_NOT_FOUND',
        `Unknown skills: ${missing.join(', ')}`,
        400,
      );
    }
    await this.prisma.$transaction([
      this.prisma.soulSkill.deleteMany({ where: { soulId } }),
      ...skills.map((skill) =>
        this.prisma.soulSkill.create({
          data: { soulId, skillId: skill.id },
        }),
      ),
    ]);
    return this.forSoul(soulId);
  }

  async attachToBot(botId: string, slugs: unknown): Promise<SkillView[]> {
    const wanted = stringList(slugs);
    const skills =
      wanted.length > 0
        ? ((await this.prisma.skill.findMany({
            where: { slug: { in: wanted } },
          })) as SkillModel[])
        : [];
    await this.prisma.$transaction([
      this.prisma.botSkill.deleteMany({ where: { botId } }),
      ...skills.map((skill) =>
        this.prisma.botSkill.create({
          data: { botId, skillId: skill.id },
        }),
      ),
    ]);
    return this.forBot(botId);
  }

  /** Instructions for a set of skill slugs; unknown slugs are ignored. */
  async instructions(slugs: string[]): Promise<{ slug: string; text: string }[]> {
    if (slugs.length === 0) return [];
    const rows = (await this.prisma.skill.findMany({
      where: { slug: { in: slugs }, enabled: true },
    })) as SkillModel[];
    return rows.map((skill) => ({
      slug: skill.slug,
      text: skill.instructions,
    }));
  }

  async toolsFor(slugs: string[]): Promise<string[]> {
    if (slugs.length === 0) return [];
    const rows = (await this.prisma.skill.findMany({
      where: { slug: { in: slugs }, enabled: true },
    })) as SkillModel[];
    return rows.flatMap((skill) => parseTools(skill.tools));
  }
}
