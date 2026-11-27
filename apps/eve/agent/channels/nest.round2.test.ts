import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import channel, {
  deliverCompletedReply,
  isStaleDeletionReply,
  resetChannelCaches,
  type NestState,
} from './nest';

/**
 * Integration test for the live channel, with Nest mocked at the `fetch` edge.
 *
 * It exercises the real route handlers (`/eve/v1/nest/events`,
 * `/eve/v1/nest/turn`) and the real `content.completed` writer, which is the
 * path that used to hide the sticky `applied` flag and the dead reaction plan.
 */

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

interface FakeNest {
  calls: Call[];
  callsTo(suffix: string): Call[];
}

const ADDRESS = {
  personaId: 'persona-1',
  accountId: 'account-1',
  chatId: '42',
  threadId: 0,
};

const definition = channel as unknown as {
  routes: Array<{
    method: string;
    path: string;
    handler: (
      request: Request,
      args: Record<string, unknown>,
    ) => Promise<Response>;
  }>;
  adapter: {
    deliver: (
      payload: { state?: Partial<NestState> },
      ctx: { state: NestState },
    ) => Promise<unknown>;
    'turn.started'?: (
      event: Record<string, unknown>,
      ctx: { channel: { state: NestState }; waitUntil: (task: Promise<unknown>) => void },
    ) => Promise<void> | void;
    'content.completed'?: (
      event: Record<string, unknown>,
      ctx: { channel: { state: NestState }; waitUntil: (task: Promise<unknown>) => void },
    ) => Promise<void> | void;
    'turn.settled'?: (
      event: Record<string, unknown>,
      ctx: { channel: { state: NestState }; waitUntil: (task: Promise<unknown>) => void },
    ) => Promise<void> | void;
  };
};

function route(path: string) {
  const found = definition.routes.find((entry) => entry.path === path);
  if (!found) throw new Error(`route ${path} not found`);
  return found;
}

function contextBody(
  options: {
    stage?: string;
    busy?: unknown;
    history?: Array<Record<string, unknown>>;
    sleepFrom?: number;
    sleepTo?: number;
  } = {},
): Record<string, unknown> {
  const stage = options.stage ?? 'convinced';
  return {
    persona: {
      name: 'Ника',
      age: 23,
      timezone: 'UTC',
      stage,
      sleepFrom: options.sleepFrom ?? 0,
      sleepTo: options.sleepTo ?? 0,
      nightWakeChance: 0,
      busySchedule: options.busy ?? null,
    },
    relationship: {
      stage,
      interest: 55,
      trust: 40,
      attraction: 45,
      annoyance: 0,
      cringe: 0,
    },
    conflict: {},
    history: { messages: options.history ?? [] },
    dailyLife: null,
  };
}

let originalFetch: typeof fetch;
let originalRandom: () => number;
let nest: FakeNest;

function installFetch(context: Record<string, unknown>): FakeNest {
  const calls: Call[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body,
    });
    let data: unknown = { ok: true };
    if (url.pathname.endsWith('/context')) data = context;
    else if (url.pathname.endsWith('/messages/send')) {
      data = { messageIds: [1000 + calls.length] };
    } else if (url.pathname.endsWith('/stickers')) data = [];
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  globalThis.fetch = fake;
  return {
    calls,
    callsTo: (suffix: string) =>
      calls.filter((call) => call.path.endsWith(suffix)),
  };
}

function fakeFrom() {
  const sends: Array<{
    address: string;
    content: unknown;
    options: { state?: Partial<NestState>; turnPolicy?: string; idempotencyKey?: string };
    deliveryId: string;
  }> = [];
  let deliverySequence = 0;
  const from = (address: string) => ({
    send: async (
      content: unknown,
      options: { state?: Partial<NestState>; turnPolicy?: string; idempotencyKey?: string },
    ) => {
      const deliveryId = `delivery-${++deliverySequence}`;
      sends.push({ address, content, options, deliveryId });
      return { ok: true, deliveryId };
    },
  });
  return { sends, from };
}

async function inbound(body: Record<string, unknown>) {
  const from = fakeFrom();
  const response = await route('/eve/v1/nest/events').handler(
    new Request('http://127.0.0.1/eve/v1/nest/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { from: from.from } as never,
  );
  return { response, body: (await response.json()) as Record<string, unknown>, from };
}

async function deliverTurn(payload: Record<string, unknown>) {
  const from = fakeFrom();
  const response = await route('/eve/v1/nest/turn').handler(
    new Request('http://127.0.0.1/eve/v1/nest/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ADDRESS, ...payload }),
    }),
    { from: from.from } as never,
  );
  return { response, from };
}

async function proactive(payload: Record<string, unknown> = {}) {
  const from = fakeFrom();
  const response = await route('/eve/v1/nest/proactive').handler(
    new Request('http://127.0.0.1/eve/v1/nest/proactive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ADDRESS, ...payload }),
    }),
    { from: from.from } as never,
  );
  return { response, from };
}

/** A sleep window that always contains the current UTC hour. */
function sleepingHours(): { sleepFrom: number; sleepTo: number } {
  const hour = new Date().getUTCHours();
  return { sleepFrom: (hour + 23) % 24, sleepTo: (hour + 2) % 24 };
}

/** Runs the reply event on a state that was delivered by the channel. */
async function completeReply(state: Partial<NestState>, value: string) {
  const channelState = {} as NestState;
  await definition.adapter.deliver({ state }, { state: channelState });
  const tasks: Promise<unknown>[] = [];
  await deliverCompletedReply(
    { phase: 'reply', value },
    channelState,
    (task) => tasks.push(task),
  );
  await Promise.allSettled(tasks);
  return channelState;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalRandom = Math.random;
  resetChannelCaches();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

describe('live channel: applied is per turn', () => {
  test('two inbounds produce two /turn/apply and two reflect calls', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());

    const applied: number[] = [];
    for (const messageId of [11, 12]) {
      await inbound({
        ...ADDRESS,
        allowed: true,
        kind: 'message.new',
        id: `event-${messageId}`,
        message: {
          id: messageId,
          text: `сообщение ${messageId}`,
          date: new Date().toISOString(),
          outgoing: false,
        },
      });

      // The reply path is deferred through the durable queue; Nest calls this
      // route when the delay elapses.
      const action = nest
        .callsTo('/actions')
        .map((call) => call.body)
        .find((body) => body.kind === 'turn');
      expect(action).toBeTruthy();
      const payload = action!.payload as Record<string, unknown>;

      const turn = await deliverTurn({
        incoming: payload.incoming,
        messageId: payload.messageId,
        behavior: payload.behavior,
        hint: payload.hint,
        hints: payload.hints,
        media: payload.media,
        idempotencyKey: payload.idempotencyKey,
      });
      expect(turn.response.status).toBe(202);
      expect(turn.from.sends.length).toBe(1);

      // A new inbound must reset `applied`, otherwise the second turn would
      // silently skip counters and memory. Inside one turn it stays true so a
      // second `content.completed` cannot apply twice.
      const state = await completeReply(
        turn.from.sends[0]!.options.state ?? {},
        'привет, как ты',
      );
      expect(state.applied).toBe(true);
      applied.push(nest.callsTo('/turn/apply').length);
    }

    expect(nest.callsTo('/turn/apply').length).toBe(2);
    expect(nest.callsTo('/memory/reflect').length).toBe(2);
    // The LLM extractor is throttled per chat, but it must run at least once.
    expect(nest.callsTo('/agenda/extract').length).toBe(1);
  });
});

describe('live channel: an unanswered series is one turn', () => {
  test('two fast inbounds answer both messages, one reply, one apply', async () => {
    Math.random = () => 0.9;
    const now = Date.now();
    nest = installFetch(
      contextBody({
        history: [
          {
            id: 11,
            outgoing: false,
            text: 'первое сообщение',
            date: new Date(now - 30_000).toISOString(),
          },
          {
            id: 10,
            outgoing: true,
            text: 'ага',
            date: new Date(now - 60_000).toISOString(),
          },
        ],
      }),
    );

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-burst-2',
      message: {
        id: 12,
        text: 'второе сообщение',
        date: new Date(now).toISOString(),
        outgoing: false,
      },
    });
    expect(result.response.status).toBe(202);

    // Deferred reply: this is the live path where the previous pending turn is
    // superseded, so the first message must survive in the payload.
    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    expect(action).toBeTruthy();
    expect(Number(action!.delaySec)).toBeGreaterThan(0);
    const payload = action!.payload as Record<string, unknown>;
    expect(payload.burst).toEqual([
      { id: 11, text: 'первое сообщение' },
      { id: 12, text: 'второе сообщение' },
    ]);

    const turn = await deliverTurn({
      incoming: payload.incoming,
      messageId: payload.messageId,
      burst: payload.burst,
      behavior: payload.behavior,
      hint: payload.hint,
      hints: payload.hints,
      idempotencyKey: payload.idempotencyKey,
    });
    expect(turn.response.status).toBe(202);
    expect(turn.from.sends.length).toBe(1);
    const content = turn.from.sends[0]!.content;
    const prompt = typeof content === 'string' ? content : JSON.stringify(content);
    expect(prompt).toContain('он(11): первое сообщение');
    expect(prompt).toContain('он(12): второе сообщение');

    await completeReply(turn.from.sends[0]!.options.state ?? {}, 'ответ на оба');

    // One series → one sent reply and one `turn/apply` that knows both ids.
    expect(nest.callsTo('/messages/send').length).toBe(1);
    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
    expect(applies[0]!.messageId).toBe(12);
    expect(applies[0]!.messageIds).toEqual([11, 12]);
    expect(applies[0]!.messages).toEqual([
      { id: 11, text: 'первое сообщение' },
      { id: 12, text: 'второе сообщение' },
    ]);

    // Agenda reads the whole series once, not just the last message.
    const agenda = nest.callsTo('/agenda/extract');
    expect(agenda.length).toBe(1);
    expect(String(agenda[0]!.body.incoming)).toContain('первое сообщение');
    expect(String(agenda[0]!.body.incoming)).toContain('второе сообщение');
  });

  test('the series dropped by Nest is merged even without history', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-burst-carried',
      // Nest already dropped a deferred turn for the first message and sent
      // its text along; `/context` had no history row for it.
      supersededBurst: [{ id: 11, text: 'первое сообщение' }],
      message: {
        id: 12,
        text: 'второе сообщение',
        date: new Date().toISOString(),
        outgoing: false,
      },
    });
    expect(result.response.status).toBe(202);

    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    const payload = action!.payload as Record<string, unknown>;
    expect(payload.burst).toEqual([
      { id: 11, text: 'первое сообщение' },
      { id: 12, text: 'второе сообщение' },
    ]);
  });

  test('a single message keeps the plain prompt and one apply id', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-single',
      message: {
        id: 77,
        text: 'привет',
        date: new Date().toISOString(),
        outgoing: false,
      },
    });
    expect(result.response.status).toBe(202);

    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    const payload = action!.payload as Record<string, unknown>;
    expect(payload.burst).toEqual([{ id: 77, text: 'привет' }]);

    const turn = await deliverTurn({
      incoming: payload.incoming,
      messageId: payload.messageId,
      burst: payload.burst,
      behavior: payload.behavior,
      hint: payload.hint,
      hints: payload.hints,
      idempotencyKey: payload.idempotencyKey,
    });
    const prompt =
      typeof turn.from.sends[0]!.content === 'string'
        ? (turn.from.sends[0]!.content as string)
        : '';
    // No series labels for one message: the old prompt shape is preserved.
    expect(prompt).not.toContain('он(');
    expect(prompt).toContain('привет');

    await completeReply(turn.from.sends[0]!.options.state ?? {}, 'ответ');
    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
    expect(applies[0]!.messageId).toBe(77);
    expect(applies[0]!.messageIds).toEqual([77]);
    expect(applies[0]!.messages).toEqual([{ id: 77, text: 'привет' }]);
  });
});

describe('live channel: proactive is not an inbound', () => {
  test('inbound A + proactive applies A once and never replays it', async () => {
    Math.random = () => 0.9;
    const now = Date.now();
    nest = installFetch(
      contextBody({
        history: [
          {
            id: 4,
            outgoing: true,
            text: 'ага',
            date: new Date(now - 60_000).toISOString(),
          },
        ],
      }),
    );

    const first = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-a',
      message: {
        id: 11,
        text: 'привет',
        date: new Date(now).toISOString(),
        outgoing: false,
      },
    });
    expect(first.response.status).toBe(202);
    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    expect(action).toBeTruthy();
    expect(action!.payload).toMatchObject({ messageId: 11 });

    const payload = action!.payload as Record<string, unknown>;
    const turn = await deliverTurn({
      incoming: payload.incoming,
      messageId: payload.messageId,
      behavior: payload.behavior,
      hint: payload.hint,
      hints: payload.hints,
      media: payload.media,
      idempotencyKey: payload.idempotencyKey,
    });
    const state = await completeReply(
      turn.from.sends[0]!.options.state ?? {},
      'ответ на привет',
    );
    expect(state.applied).toBe(true);

    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
    expect(applies[0]!.messageId).toBe(11);
    expect(applies[0]!.text).toBe('привет');
    expect(
      (applies[0]!.decision as { moodDelta?: { interest?: number } }).moodDelta
        ?.interest,
    ).toBe(1);

    const pro = await proactive({
      item: { id: 'agenda-a', about: 'тренировка', reason: 'вечер' },
    });
    expect(pro.response.status).toBe(202);
    expect(pro.from.sends.length).toBe(1);
    const proState = pro.from.sends[0]!.options.state ?? {};
    // Explicitly cleared by the route; `deliver` would also reset them.
    expect(proState.applied).toBe(true);
    expect(proState.incoming).toBe('');
    expect(proState.messageId).toBeUndefined();
    expect(proState.behavior).toBeUndefined();
    // A proactive turn must wait for its own turn instead of steering into an
    // answer that is still being generated.
    expect(pro.from.sends[0]!.options.turnPolicy).toBe('queue');

    const after = await completeReply(
      proState,
      'я записалась на тренировку',
    );
    expect(after.applied).toBe(true);

    // The proactive turn added no apply/reflect of its own, and no payload
    // carries the old message, its text or its mood delta.
    expect(nest.callsTo('/turn/apply').length).toBe(1);
    expect(nest.callsTo('/memory/reflect').length).toBe(1);
    const finalApplies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(finalApplies.every((body) => body.messageId === 11)).toBe(true);
    expect(finalApplies.every((body) => body.text === 'привет')).toBe(true);
  });
});

describe('live channel: active dialog is her last reply', () => {
  test('asleep beats a recent reply: no instant answer at night', async () => {
    Math.random = () => 0.9;
    const now = Date.now();
    const sleep = sleepingHours();
    nest = installFetch(
      contextBody({
        ...sleep,
        history: [
          {
            id: 30,
            outgoing: true,
            text: 'ага',
            date: new Date(now - 2 * 60_000).toISOString(),
          },
          {
            id: 29,
            outgoing: false,
            text: 'ты тут?',
            date: new Date(now - 3 * 60_000).toISOString(),
          },
          {
            id: 28,
            outgoing: false,
            text: 'эй',
            date: new Date(now - 4 * 60_000).toISOString(),
          },
          {
            id: 27,
            outgoing: false,
            text: 'спишь?',
            date: new Date(now - 5 * 60_000).toISOString(),
          },
        ],
      }),
    );

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-night',
      message: {
        id: 91,
        text: 'ты спишь?',
        date: new Date(now).toISOString(),
        outgoing: false,
      },
    });

    expect(result.response.status).not.toBe(500);
    // Neither an immediate send nor a fast active-dialog turn: sleep wins.
    expect(nest.callsTo('/messages/send').length).toBe(0);
    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    if (action) {
      expect(Number(action.delaySec)).toBeGreaterThanOrEqual(60);
    } else {
      expect(result.body.ignored).toBe('behavior');
    }
  });

  test('her reply two minutes ago answers quickly', async () => {
    Math.random = () => 0.9;
    const now = Date.now();
    nest = installFetch(
      contextBody({
        history: [
          {
            id: 30,
            outgoing: true,
            text: 'ага',
            date: new Date(now - 2 * 60_000).toISOString(),
          },
          {
            id: 29,
            outgoing: false,
            text: 'ты тут?',
            date: new Date(now - 3 * 60_000).toISOString(),
          },
        ],
      }),
    );

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-dialog',
      message: {
        id: 92,
        text: 'ну что',
        date: new Date(now).toISOString(),
        outgoing: false,
      },
    });

    expect(result.response.status).toBe(202);
    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    expect(action).toBeTruthy();
    expect(Number(action!.delaySec)).toBeLessThanOrEqual(180);
    expect(nest.callsTo('/messages/send').length).toBe(0);
  });

  test('a burst of his messages during busy is not an active dialog', async () => {
    Math.random = () => 0.9;
    const now = Date.now();
    nest = installFetch(
      contextBody({
        busy: [
          {
            label: 'пары',
            from: '00:00',
            to: '23:59',
            checkAfterMin: [20, 25],
          },
        ],
        history: [
          {
            id: 41,
            outgoing: false,
            text: 'эй',
            date: new Date(now - 2 * 60_000).toISOString(),
          },
          {
            id: 40,
            outgoing: false,
            text: 'ты тут?',
            date: new Date(now - 5 * 60_000).toISOString(),
          },
          {
            id: 39,
            outgoing: false,
            text: 'ау',
            date: new Date(now - 8 * 60_000).toISOString(),
          },
        ],
      }),
    );

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-burst',
      message: {
        id: 93,
        text: 'ответь',
        date: new Date(now).toISOString(),
        outgoing: false,
      },
    });

    expect(result.response.status).toBe(202);
    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    expect(action).toBeTruthy();
    expect(Number(action!.delaySec)).toBeGreaterThanOrEqual(20 * 60);
  });
});

describe('live channel: reaction gating', () => {
  test('a reaction on an indexed outgoing message is answered', async () => {
    nest = installFetch(
      contextBody({
        history: [
          {
            id: 480,
            outgoing: false,
            text: 'его сообщение',
            date: new Date().toISOString(),
          },
        ],
      }),
    );
    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.reaction',
      id: 'event-reaction-mine',
      emoji: '👍',
      targetIsMine: true,
      messageId: 501,
      fromId: 7,
      outgoing: false,
    });

    expect(result.response.status).toBe(200);
    expect(result.body.reaction).toBe('react');
    const reactions = nest.callsTo('/messages/react');
    expect(reactions.length).toBe(1);
    // She reacts back to his latest message, not to her own.
    expect(reactions[0]!.body.messageId).toBe(480);
  });

  test('a reaction on his own message stays ignored', async () => {
    nest = installFetch(contextBody());
    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.reaction',
      id: 'event-reaction-his',
      emoji: '👍',
      targetIsMine: false,
      messageId: 502,
      fromId: 7,
      outgoing: false,
    });

    expect(result.body.ignored).toBe('reaction:not-mine');
    expect(nest.callsTo('/messages/react').length).toBe(0);
  });

  test('a warm strong reaction replies in a queued turn, not a steering one', async () => {
    nest = installFetch(
      contextBody({
        stage: 'convinced',
        history: [
          {
            id: 480,
            outgoing: false,
            text: 'его сообщение',
            date: new Date().toISOString(),
          },
        ],
      }),
    );
    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.reaction',
      id: 'event-reaction-reply',
      emoji: '❤',
      targetIsMine: true,
      messageId: 501,
      fromId: 7,
      outgoing: false,
    });

    expect(result.response.status).toBe(202);
    expect(result.body.reaction).toBe('reply');
    expect(result.from.sends.length).toBe(1);
    expect(result.from.sends[0]!.options.turnPolicy).toBe('queue');
    const state = result.from.sends[0]!.options.state ?? {};
    // Reaction turns never apply his counters.
    expect(state.applied).toBe(true);
  });
});

describe('live channel: reaction-only', () => {
  test('a warm ignore sends /messages/react before any early return', async () => {
    // rand 0: the ignore roll wins, and the reaction roll wins too.
    Math.random = () => 0;
    nest = installFetch(contextBody());

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-react',
      message: {
        id: 77,
        text: 'просто смайлик',
        date: new Date().toISOString(),
        outgoing: false,
      },
    });

    expect(result.response.status).toBe(200);
    expect(result.body.ignored).toBe('behavior');
    const reactions = nest.callsTo('/messages/react');
    expect(reactions.length).toBe(1);
    expect(reactions[0]!.body.messageId).toBe(77);
    expect(typeof reactions[0]!.body.emoji).toBe('string');
    // The turn is still written back as an ignore: Nest counts it in
    // `ignoresInStage` exactly like a plain ignore.
    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
    expect(applies[0]!.decision).toMatchObject({
      intent: 'reaction-only',
      shouldReply: false,
    });
    expect(applies[0]!.turnKey).toBe('inbound:event-react');
  });
});

describe('live channel: busy gate', () => {
  test('busy outside a dialog delays the reply by checkAfterMin', async () => {
    Math.random = () => 0.9;
    nest = installFetch(
      contextBody({
        busy: [
          {
            label: 'пары',
            from: '00:00',
            to: '23:59',
            checkAfterMin: [20, 25],
          },
        ],
      }),
    );

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-busy',
      message: {
        id: 55,
        text: 'ты где?',
        date: new Date().toISOString(),
        outgoing: false,
      },
    });

    expect(result.response.status).toBe(202);
    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    expect(action).toBeTruthy();
    expect(Number(action!.delaySec)).toBeGreaterThanOrEqual(20 * 60);
  });

  test('busy inside an active dialog answers fast', async () => {
    Math.random = () => 0.9;
    const now = Date.now();
    nest = installFetch(
      contextBody({
        busy: [
          {
            label: 'пары',
            from: '00:00',
            to: '23:59',
            checkAfterMin: [20, 25],
          },
        ],
        // Three recent turns = an active dialog; the busy block must not win.
        history: [
          { id: 4, outgoing: true, text: 'ага', date: new Date(now - 60_000).toISOString() },
          { id: 3, outgoing: false, text: 'ты тут?', date: new Date(now - 120_000).toISOString() },
          { id: 2, outgoing: true, text: 'да', date: new Date(now - 180_000).toISOString() },
        ],
      }),
    );

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-active',
      message: {
        id: 56,
        text: 'ну что',
        date: new Date().toISOString(),
        outgoing: false,
      },
    });

    expect(result.response.status).toBe(202);
    const action = nest
      .callsTo('/actions')
      .map((call) => call.body)
      .find((body) => body.kind === 'turn');
    expect(action).toBeTruthy();
    expect(Number(action!.delaySec)).toBeLessThan(20 * 60);
  });
});

describe('live channel: deletion', () => {
  test('a deletion turn is excluded from relationship counters', async () => {
    Math.random = () => 0.9;
    const now = Date.now();
    nest = installFetch(
      contextBody({
        history: [
          {
            id: 9,
            outgoing: true,
            text: 'ага',
            date: new Date(now - 60_000).toISOString(),
          },
        ],
      }),
    );

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.deleted',
      id: 'event-deleted',
      outgoing: false,
      messages: [
        {
          id: 8,
          outgoing: false,
          text: 'секрет',
          date: new Date(now - 120_000).toISOString(),
        },
      ],
    });

    expect(result.response.status).toBe(202);
    expect(result.from.sends.length).toBe(1);
    expect(result.from.sends[0]!.options.turnPolicy).toBe('queue');
    const state = await completeReply(
      result.from.sends[0]!.options.state ?? {},
      'ты куда удалил',
    );
    expect(nest.callsTo('/turn/apply').length).toBe(0);
    expect(nest.callsTo('/memory/reflect').length).toBe(0);
    expect(state.applied).toBe(true);
  });
});

describe('live channel: deletion spam guards', () => {
  test('a bulk delete (39 ids) is silent', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());
    const now = Date.now();

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.deleted',
      dedupeKey: 'bulk-key',
      outgoing: false,
      messageIds: Array.from({ length: 39 }, (_value, index) => 1000 + index),
      messages: Array.from({ length: 39 }, (_value, index) => ({
        id: 1000 + index,
        outgoing: false,
        text: `old ${index}`,
        date: new Date(now - 60_000).toISOString(),
      })),
    });

    expect(result.response.status).toBe(200);
    expect(result.body.ignored).toBe('deletion:bulk');
    expect(result.from.sends.length).toBe(0);
  });

  test('a deletion older than ten minutes is silent even if delivered now', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());
    const now = Date.now();

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.deleted',
      dedupeKey: 'stale-key',
      outgoing: false,
      messageIds: [77],
      messages: [
        {
          id: 77,
          outgoing: false,
          text: 'старое',
          date: new Date(now - 20 * 60_000).toISOString(),
        },
      ],
    });

    expect(result.response.status).toBe(200);
    expect(result.body.ignored).toBe('deletion:stale');
    expect(result.from.sends.length).toBe(0);
  });

  test('a deletion with unknown author is silent', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.deleted',
      dedupeKey: 'unknown-key',
      messageIds: [78],
      messages: [{ id: 78, text: 'кто-то удалил' }],
    });

    expect(result.response.status).toBe(200);
    expect(result.body.ignored).toBe('deletion:no-payload');
    expect(result.from.sends.length).toBe(0);
  });

  test('three replays with a growing id list produce one comment', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());
    const now = Date.now();

    let sends = 0;
    for (const ids of [[81, 82], [81, 82, 83], [81, 82, 83, 84]]) {
      const result = await inbound({
        ...ADDRESS,
        allowed: true,
        kind: 'message.deleted',
        dedupeKey: `grow-${ids.length}`,
        outgoing: false,
        messageIds: ids,
        messages: ids.map((id) => ({
          id,
          outgoing: false,
          text: `текст ${id}`,
          date: new Date(now - 30_000).toISOString(),
        })),
      });
      sends += result.from.sends.length;
      if (result.from.sends.length === 0) {
        expect(result.body.ignored).toBe('deletion:throttled');
      }
    }

    expect(sends).toBe(1);
  });

  test('a newer inbound cancels an in-flight deletion reply', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());
    const now = Date.now();

    const deletion = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.deleted',
      dedupeKey: 'stale-turn-key',
      outgoing: false,
      messageIds: [91],
      messages: [
        {
          id: 91,
          outgoing: false,
          text: 'секрет',
          date: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    expect(deletion.from.sends.length).toBe(1);
    const deletionState = deletion.from.sends[0]!.options.state ?? {};
    const deletionAt = Number(deletionState.deletionAt);

    const state = { ...deletionState, lastInboundAt: deletionAt + 1 } as NestState;
    await deliverCompletedReply(
      { phase: 'reply', value: 'ты куда удалил' },
      state,
      () => undefined,
    );

    expect(nest.callsTo('/messages/send').length).toBe(0);
  });

  test('the turn-scoped deletion check survives a steering inbound', () => {
    const state = {
      ...ADDRESS,
      origin: 'inbound',
      applied: false,
      lastInboundAt: 200,
    } as NestState;

    // `turnDeletionAt` is authoritative even when the shared channel state
    // already describes the newer inbound.
    expect(isStaleDeletionReply(state, 100)).toBe(true);
    expect(isStaleDeletionReply(state, 300)).toBe(false);
  });

  test('the deletion idempotency key prefers dedupeKey over the row id', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());
    const now = Date.now();

    const result = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.deleted',
      id: 'row-id',
      dedupeKey: 'stable-key',
      outgoing: false,
      messageIds: [95],
      messages: [
        {
          id: 95,
          outgoing: false,
          text: 'текст',
          date: new Date(now - 60_000).toISOString(),
        },
      ],
    });

    expect(result.from.sends[0]!.options.idempotencyKey).toBe(
      'deleted:stable-key',
    );
  });

  test('a fresh small deletion and a following inbound both work', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());
    const now = Date.now();

    const deletion = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.deleted',
      dedupeKey: 'one-delete',
      outgoing: false,
      messageIds: [97],
      messages: [
        {
          id: 97,
          outgoing: false,
          text: 'текст',
          date: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    expect(deletion.from.sends.length).toBe(1);

    const next = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'after-delete',
      message: {
        id: 98,
        text: 'новое сообщение',
        date: new Date(now).toISOString(),
        outgoing: false,
      },
    });
    expect(next.response.status).toBe(202);
    expect(next.from.sends.length + nest.callsTo('/actions').length).toBeGreaterThan(0);
  });
});

describe('live channel: a deferred turn drops already answered messages', () => {
  test('a message answered while the turn waited is not in the series', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());

    // Turn B was queued with the series [11, 12]; by the time it is due, 11
    // has already been answered (Nest reports lastHisMessageId = 11).
    const turn = await deliverTurn({
      incoming: 'второе сообщение',
      messageId: 12,
      burst: [
        { id: 11, text: 'первое сообщение' },
        { id: 12, text: 'второе сообщение' },
      ],
      lastHisMessageId: 11,
      behavior: { intent: 'reply', bubbles: 1, moodDelta: { interest: 1 } },
    });

    expect(turn.response.status).toBe(202);
    expect(turn.from.sends.length).toBe(1);
    const prompt =
      typeof turn.from.sends[0]!.content === 'string'
        ? (turn.from.sends[0]!.content as string)
        : '';
    expect(prompt).not.toContain('первое сообщение');
    expect(prompt).toContain('второе сообщение');

    await completeReply(turn.from.sends[0]!.options.state ?? {}, 'ответ');
    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
    expect(applies[0]!.messageIds).toEqual([12]);
    expect(applies[0]!.messages).toEqual([
      { id: 12, text: 'второе сообщение' },
    ]);
  });

  test('a turn whose whole series was applied sends nothing', async () => {
    nest = installFetch(contextBody());

    const turn = await deliverTurn({
      incoming: 'второе сообщение',
      messageId: 12,
      burst: [
        { id: 11, text: 'первое сообщение' },
        { id: 12, text: 'второе сообщение' },
      ],
      lastHisMessageId: 12,
      behavior: { intent: 'reply', bubbles: 1 },
    });

    expect(turn.response.status).toBe(200);
    expect(turn.from.sends.length).toBe(0);
    expect(nest.callsTo('/messages/send').length).toBe(0);
  });

  test('without an applied id the whole series is still answered', async () => {
    nest = installFetch(contextBody());

    const turn = await deliverTurn({
      incoming: 'второе сообщение',
      messageId: 12,
      burst: [
        { id: 11, text: 'первое сообщение' },
        { id: 12, text: 'второе сообщение' },
      ],
      behavior: { intent: 'reply', bubbles: 1 },
    });

    const prompt =
      typeof turn.from.sends[0]!.content === 'string'
        ? (turn.from.sends[0]!.content as string)
        : '';
    expect(prompt).toContain('он(11): первое сообщение');
    expect(prompt).toContain('он(12): второе сообщение');
  });
});

describe('live channel: an ignore and a late reply are different turns', () => {
  test('the ignore carries its own turn key, the reply its own', async () => {
    // rand 0: the deterministic ignore wins, so B applies the series without a
    // model turn while A is still generating.
    Math.random = () => 0;
    const now = Date.now();
    nest = installFetch(
      contextBody({
        history: [
          {
            id: 101,
            outgoing: false,
            text: 'первое',
            date: new Date(now - 20_000).toISOString(),
          },
        ],
      }),
    );

    const ignored = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-b',
      message: {
        id: 102,
        text: 'второе',
        date: new Date(now).toISOString(),
        outgoing: false,
      },
    });
    expect(ignored.response.status).toBe(200);
    expect(ignored.body.ignored).toBe('behavior');

    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
    // The ignore counted the whole unanswered series [A, B].
    expect(applies[0]!.messageIds).toEqual([101, 102]);
    expect(applies[0]!.turnKey).toBe('inbound:event-b');

    // A's deferred turn finishes later under its own key, so Nest does not
    // mistake its outcome for a replay of the ignore.
    const turn = await deliverTurn({
      actionId: 'action-a',
      incoming: 'первое',
      messageId: 101,
      burst: [{ id: 101, text: 'первое' }],
      behavior: { intent: 'reply', shouldReply: true, bubbles: 1 },
    });
    expect(turn.from.sends.length).toBe(1);
    await completeReply(turn.from.sends[0]!.options.state ?? {}, 'ответ');

    const all = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(all.length).toBe(2);
    expect(all[1]!.messageIds).toEqual([101]);
    expect(all[1]!.turnKey).toBe('deferred:action-a');
    expect(all[1]!.turnKey).not.toBe(all[0]!.turnKey);
  });
});

describe('live channel: a coalesced queue delivery keeps the inbound apply', () => {
  test('an inbound followed by a queued proactive turn applies it once', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());

    // The inbound turn does not answer immediately; this is the payload Eve
    // got from the durable deferred turn.
    const turn = await deliverTurn({
      incoming: 'привет',
      messageId: 11,
      burst: [{ id: 11, text: 'привет' }],
      behavior: { intent: 'reply', bubbles: 1, moodDelta: { interest: 1 } },
    });
    expect(turn.from.sends.length).toBe(1);

    // Eve coalesced the inbound delivery with a queued proactive one
    // (`takeNext` + `takeFollowingDeliveriesFrom`): `deliver` runs for both
    // before the turn starts, and the queue delivery is last.
    const pro = await proactive({
      item: { id: 'agenda-coalesced', about: 'тренировка' },
    });
    const channelState = {} as NestState;
    await definition.adapter.deliver(
      { state: turn.from.sends[0]!.options.state ?? {} },
      { state: channelState },
    );
    await definition.adapter.deliver(
      { state: pro.from.sends[0]!.options.state ?? {} },
      { state: channelState },
    );

    // The queued delivery carries no inbound of its own: it must not erase the
    // pending one, otherwise the answer would be sent without counters.
    expect(channelState.applied).toBe(false);
    expect(channelState.messageId).toBe(11);
    expect(channelState.incoming).toBe('привет');

    const tasks: Promise<unknown>[] = [];
    await deliverCompletedReply(
      { phase: 'reply', value: 'ответ на привет' },
      channelState,
      (task) => tasks.push(task),
    );
    await Promise.allSettled(tasks);

    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
    expect(applies[0]!.messageId).toBe(11);
    expect(applies[0]!.messageIds).toEqual([11]);
    expect(applies[0]!.text).toBe('привет');
    expect(channelState.applied).toBe(true);
  });

  test('a queue-only delivery still clears a completed inbound', async () => {
    Math.random = () => 0.9;
    nest = installFetch(contextBody());

    const turn = await deliverTurn({
      incoming: 'привет',
      messageId: 11,
      burst: [{ id: 11, text: 'привет' }],
      behavior: { intent: 'reply', bubbles: 1 },
    });
    const channelState = {} as NestState;
    await definition.adapter.deliver(
      { state: turn.from.sends[0]!.options.state ?? {} },
      { state: channelState },
    );
    const tasks: Promise<unknown>[] = [];
    await deliverCompletedReply(
      { phase: 'reply', value: 'ответ' },
      channelState,
      (task) => tasks.push(task),
    );
    await Promise.allSettled(tasks);
    expect(channelState.applied).toBe(true);

    // After the inbound is applied, a proactive delivery behaves as before:
    // per-turn fields are cleared and the queued turn applies nothing.
    const pro = await proactive({
      item: { id: 'agenda-after', about: 'кино' },
    });
    await definition.adapter.deliver(
      { state: pro.from.sends[0]!.options.state ?? {} },
      { state: channelState },
    );
    expect(channelState.applied).toBe(true);
    expect(channelState.messageId).toBeUndefined();
    expect(channelState.behavior).toBeUndefined();

    const applies = nest.callsTo('/turn/apply').map((call) => call.body);
    expect(applies.length).toBe(1);
  });
});
