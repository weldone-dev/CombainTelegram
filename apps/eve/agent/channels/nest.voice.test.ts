import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import channel, { resetChannelCaches } from './nest';

/**
 * Voice notes in the live channel.
 *
 * The model used to receive only `[он прислал голосовое]`: a note's content
 * never entered the prompt. These tests drive the real route with Nest mocked
 * at the `fetch` edge and assert that `/internal/eve/transcribe` is asked, the
 * text reaches the turn, and every failure falls back to an honest placeholder
 * without failing the turn.
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
  chatId: '1830539716',
  threadId: 0,
};

const definition = channel as unknown as {
  routes: Array<{
    path: string;
    handler: (
      request: Request,
      args: Record<string, unknown>,
    ) => Promise<Response>;
  }>;
};

function route(path: string) {
  const found = definition.routes.find((entry) => entry.path === path);
  if (!found) throw new Error(`route ${path} not found`);
  return found;
}

function contextBody(): Record<string, unknown> {
  return {
    persona: {
      name: 'Ника',
      age: 23,
      timezone: 'UTC',
      stage: 'convinced',
      sleepFrom: 0,
      sleepTo: 0,
      nightWakeChance: 0,
      busySchedule: null,
    },
    relationship: {
      stage: 'convinced',
      interest: 55,
      trust: 40,
      attraction: 45,
      annoyance: 0,
      cringe: 0,
    },
    conflict: {},
    history: { messages: [] },
    dailyLife: null,
  };
}

type TranscribeAnswer =
  | { status: number; body: unknown }
  | 'throw';

function installFetch(answer: TranscribeAnswer = { status: 200, body: { text: null } }): FakeNest {
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
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    if (url.pathname.endsWith('/transcribe')) {
      if (answer === 'throw') {
        throw new DOMException('timed out', 'TimeoutError');
      }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    let data: unknown = { ok: true };
    if (url.pathname.endsWith('/context')) data = contextBody();
    else if (url.pathname.endsWith('/messages/send')) {
      data = { messageIds: [2000 + calls.length] };
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
  const sends: Array<{ content: unknown }> = [];
  const from = (_address: string) => ({
    send: async (content: unknown) => {
      sends.push({ content });
      return { ok: true, deliveryId: `delivery-${sends.length}` };
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
  return {
    response,
    payload: (await response.json()) as Record<string, unknown>,
    from,
  };
}

/** The prompt of the turn, whether it was sent now or queued by Nest. */
function promptOf(
  nest: FakeNest,
  from: ReturnType<typeof fakeFrom>,
): string {
  const direct = from.sends[0]?.content;
  if (direct !== undefined) {
    return typeof direct === 'string' ? direct : JSON.stringify(direct);
  }
  const action = nest
    .callsTo('/actions')
    .map((call) => call.body)
    .find((body) => body.kind === 'turn');
  const payload = action?.payload as Record<string, unknown> | undefined;
  return typeof payload?.incoming === 'string' ? payload.incoming : '';
}

function voiceEvent(
  messageId: number,
  kind = 'voice',
  eventId = `event-${messageId}`,
): Record<string, unknown> {
  return {
    ...ADDRESS,
    allowed: true,
    kind: 'message.new',
    id: eventId,
    message: {
      id: messageId,
      text: '',
      date: new Date().toISOString(),
      outgoing: false,
      media: { kind },
    },
  };
}

let originalFetch: typeof fetch;
let originalRandom: () => number;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalRandom = Math.random;
  // A high roll keeps the behavior policy on the "reply" branch, as the other
  // live-channel tests do.
  Math.random = () => 0.9;
  resetChannelCaches();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

describe('live channel: voice transcription', () => {
  test('asks Nest for the transcript and puts the text in the turn', async () => {
    const nest = installFetch({
      status: 200,
      body: { text: 'привет, это голосовое сообщение' },
    });

    const { response, from } = await inbound(voiceEvent(501));
    expect(response.status).toBe(202);

    const calls = nest.callsTo('/transcribe');
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toMatchObject({
      personaId: ADDRESS.personaId,
      accountId: ADDRESS.accountId,
      chatId: ADDRESS.chatId,
      messageId: 501,
    });

    expect(promptOf(nest, from)).toContain(
      '[он прислал голосовое: «привет, это голосовое сообщение»]',
    );
  });

  test('a video note is labelled as a circle with the transcript', async () => {
    const nest = installFetch({ status: 200, body: { text: 'смотри что я нашёл' } });

    const { from } = await inbound(voiceEvent(502, 'video_note'));

    expect(nest.callsTo('/transcribe').length).toBe(1);
    expect(promptOf(nest, from)).toContain(
      '[он прислал кружок: «смотри что я нашёл»]',
    );
  });

  test('an empty transcript keeps an honest placeholder', async () => {
    const nest = installFetch({ status: 200, body: { text: null } });

    const { response, from } = await inbound(voiceEvent(503));
    expect(response.status).toBe(202);
    expect(promptOf(nest, from)).toContain(
      '[он прислал голосовое, не расслышала]',
    );
  });

  test('a failing Nest endpoint falls back to the placeholder, not an error', async () => {
    const nest = installFetch({ status: 500, body: { error: 'boom' } });

    const { response, from } = await inbound(voiceEvent(504));
    expect(response.status).toBe(202);
    expect(promptOf(nest, from)).toContain(
      '[он прислал голосовое, не расслышала]',
    );
  });

  test('a timeout/unreachable Nest does not fail the turn', async () => {
    const nest = installFetch('throw');

    const { response, from } = await inbound(voiceEvent(505));
    expect(response.status).toBe(202);
    expect(promptOf(nest, from)).toContain(
      '[он прислал голосовое, не расслышала]',
    );
  });

  test('the same message in a burst is transcribed once', async () => {
    const nest = installFetch({ status: 200, body: { text: 'одно и то же' } });

    await inbound(voiceEvent(506, 'voice', 'event-a'));
    await inbound(voiceEvent(506, 'voice', 'event-b'));

    expect(nest.callsTo('/transcribe').length).toBe(1);
  });

  test('photos keep the old label and never hit /transcribe', async () => {
    const nest = installFetch();

    const { from } = await inbound({
      ...ADDRESS,
      allowed: true,
      kind: 'message.new',
      id: 'event-photo',
      message: {
        id: 507,
        text: '',
        date: new Date().toISOString(),
        outgoing: false,
        media: { kind: 'photo', mimeType: 'image/jpeg' },
      },
    });

    expect(nest.callsTo('/transcribe').length).toBe(0);
    expect(promptOf(nest, from)).toContain('[он прислал фото]');
  });
});
