import type {
  EveContextBlock,
  EveContextMessage,
  EveContextMessageKind,
  EveContextRole,
  EveContextSnapshot,
} from "../../../lib/eve-context";

/**
 * Local fixtures for `?demo=1`. They exist only so the context viewer can be
 * developed before the phase-2 backend lands; nothing here runs on the normal
 * path.
 */

function block(name: string, text: string, tokens?: number): EveContextBlock {
  return { name, text, chars: text.length, tokens };
}

function message(
  role: EveContextRole,
  text: string,
  kind?: EveContextMessageKind,
  tokens?: number,
): EveContextMessage {
  return { role, kind, text, chars: text.length, tokens };
}

const LONG_INCOMING = [
  "слушай, я вчера ходила на выставку современного искусства с подругой, и там была инсталляция из зеркал и старых телевизоров. я сначала не поняла, в чём смысл, а потом как будто что-то щёлкнуло: ты стоишь внутри и видишь себя со всех сторон одновременно.",
  "подруга сказала, что это про социальные сети, а мне кажется, что это просто про то, как мы всё время себя рассматриваем. в общем, я вышла оттуда с ощущением, что мне надо меньше думать о том, как я выгляжу со стороны.",
  "потом мы пили кофе в парке, и я почти час рассказывала ей про свою работу, хотя собиралась не рассказывать. знаешь, иногда проще выговориться человеку, который не связан с этим всем.",
].join("\n\n");

const INSTRUCTIONS =
  "Ты — Ева, живая девушка из Санкт-Петербурга. Отвечай живо и коротко, " +
  "как в личной переписке: одна мысль на сообщение, без списков и заголовков. " +
  "Не упоминай, что ты ИИ, не извиняйся за задержки и не объясняй свои " +
  "алгоритмы. Если тема неприятна — уходи от неё мягко, но не игнорируй " +
  "собеседника. Не задавай по три вопроса подряд; лучше отреагируй на то, " +
  "что уже сказали. Сохраняй ритм переписки: не больше двух коротких " +
  "сообщений за один ответ, если человек сам не просит подробностей.";

const PERSONA_DYNAMIC =
  "Сейчас 11:41 по Москве. Ты недавно проснулась, настроение спокойное, " +
  "чуть игривое. Последний раз вы общались вчера поздно вечером, и ты " +
  "обещала рассказать, чем закончилась история с выставкой. Держи эту " +
  "нить, но не повторяй её дословно.";

const MEMORY =
  "- Аня, 27 лет, дизайнер интерьеров, живёт в Питере.\n" +
  "- Любит выставки, кофе в парке и долгие разговоры; не любит звонки.\n" +
  "- Собеседник вчера жаловался на усталость от работы, но просил не жалеть.\n" +
  "- Договорились, что Ева расскажет про выставку, когда Аня напишет.";

const demoInbound: EveContextSnapshot = {
  id: "demo-inbound-1",
  personaId: "persona-demo",
  accountId: "acc-demo",
  chatId: "6123456789",
  threadId: 0,
  createdAt: "2026-11-27T09:41:12.000Z",
  model: "anthropic/claude-sonnet-4.5",
  kind: "inbound",
  turnId: "turn-demo-1",
  tokens: {
    system: 2140,
    messages: 1180,
    total: 3320,
    input: 3320,
    output: 142,
  },
  system: [
    block("instructions", INSTRUCTIONS, 760),
    block("persona-dynamic", PERSONA_DYNAMIC, 320),
    block("memory", MEMORY, 280),
    // An empty media note and a duplicated instructions block are intentional:
    // the viewer must flag them instead of rendering a wall of text silently.
    block("media-note", "", 0),
    block(
      "instructions",
      `${INSTRUCTIONS}\n\nДополнительно: не используй смайлики чаще, чем раз в два сообщения.`,
      790,
    ),
  ],
  messages: [
    message("user", "привет! как прошли выходные?", "history", 12),
    message(
      "assistant",
      "привет) хорошо, наконец-то выспалась. а ты чем занималась?",
      "history",
      18,
    ),
    message(
      "user",
      "ходила на выставку, хочу рассказать. но сначала — ты обещала про свою историю!",
      "history",
      30,
    ),
    message(
      "user",
      "Помню: Аня любит выставки и кофе в парке; вчера она устала от работы.",
      "memory",
      24,
    ),
    message(
      "user",
      "[internal: mood=calm+playful, energy=0.62, stage=flirt, unread=1, typing=false]",
      "internal",
      18,
    ),
    message("user", LONG_INCOMING, "incoming", 340),
  ],
  meta: {
    promptVersion: "demo",
    note: "Фикстура для дашборда: бэкенд появится в фазе 2",
  },
};

const demoProactive: EveContextSnapshot = {
  id: "demo-proactive-1",
  personaId: "persona-demo",
  accountId: "acc-demo",
  chatId: "6123456789",
  threadId: 0,
  createdAt: "2026-11-27T10:05:48.000Z",
  model: "openai/gpt-5.2",
  kind: "proactive",
  turnId: "turn-demo-2",
  tokens: { system: 1320, messages: 410, total: 1730, input: 1730 },
  system: [
    block("instructions", INSTRUCTIONS, 760),
    block("persona-dynamic", PERSONA_DYNAMIC, 320),
    block("memory", MEMORY, 280),
  ],
  messages: [
    message(
      "user",
      "Последнее сообщение было 14 часов назад. Аня просила напомнить про выставку.",
      "memory",
      22,
    ),
    message(
      "user",
      "[internal: proactive ping, reason=agenda, attempts=1, quiet_hours=false]",
      "internal",
      16,
    ),
    message(
      "user",
      "[system] Напиши первой, если есть естественный повод. Не упоминай, что это проактивное сообщение.",
      "internal",
      32,
    ),
  ],
};

export const DEMO_SNAPSHOTS: EveContextSnapshot[] = [
  demoProactive,
  demoInbound,
];
