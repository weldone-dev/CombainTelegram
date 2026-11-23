import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotApiError, TelegramBotApi } from './telegram-bot-api.js';

const TOKEN = '123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const ORIGINAL_BASE = process.env.TELEGRAM_BOT_API_BASE;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

interface Reply {
  status?: number;
  body: unknown;
}

let server: Server;
let calls: Call[];
let responder: (method: string, body: Record<string, unknown>) => Reply;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

beforeEach(async () => {
  calls = [];
  responder = () => ({ body: { ok: true, result: true } });
  server = createServer((request, response) => {
    void readBody(request)
      .then((raw) => {
        const method = (request.url ?? '').split('/').pop() ?? '';
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        calls.push({ method, path: request.url ?? '', body });
        const reply = responder(method, body);
        response.writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify(reply.body));
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, description: String(error) }));
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  // A trailing slash must be stripped from the configurable base.
  process.env.TELEGRAM_BOT_API_BASE = `http://127.0.0.1:${address.port}/`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (ORIGINAL_BASE === undefined) {
    delete process.env.TELEGRAM_BOT_API_BASE;
  } else {
    process.env.TELEGRAM_BOT_API_BASE = ORIGINAL_BASE;
  }
});

async function errorOf(run: () => Promise<unknown>): Promise<BotApiError> {
  const error = await run().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BotApiError);
  return error as BotApiError;
}

describe('TelegramBotApi', () => {
  it('calls getMe through the configured base and token', async () => {
    responder = () => ({
      body: {
        ok: true,
        result: { id: 777, username: 'soul_bot', first_name: 'Soul', is_bot: true },
      },
    });
    const api = new TelegramBotApi(TOKEN);

    const me = await api.getMe();

    expect(me).toEqual({
      id: 777,
      username: 'soul_bot',
      first_name: 'Soul',
      is_bot: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'getMe',
      path: `/bot${TOKEN}/getMe`,
      body: {},
    });
  });

  it('sends the getUpdates offset, timeout and allowed updates', async () => {
    responder = () => ({
      body: {
        ok: true,
        result: [{ update_id: 11, message: { message_id: 1 } }],
      },
    });
    const api = new TelegramBotApi(TOKEN);

    const updates = await api.getUpdates(11, 3);

    expect(updates).toEqual([
      { update_id: 11, message: { message_id: 1 } },
    ]);
    expect(calls[0].body).toEqual({
      offset: 11,
      timeout: 3,
      allowed_updates: ['message'],
    });
  });

  it('sends messages with a reply target when requested', async () => {
    responder = () => ({ body: { ok: true, result: { message_id: 9 } } });
    const api = new TelegramBotApi(TOKEN);

    await api.sendMessage(42, 'hello', { replyToMessageId: 7 });
    await api.sendMessage(42, 'plain');

    expect(calls[0].body).toEqual({
      chat_id: 42,
      text: 'hello',
      disable_web_page_preview: true,
      reply_to_message_id: 7,
    });
    expect(calls[1].body).toEqual({
      chat_id: 42,
      text: 'plain',
      disable_web_page_preview: true,
    });
  });

  it('raises BotApiError with the Telegram description on ok:false', async () => {
    responder = () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    });
    const api = new TelegramBotApi(TOKEN);

    const error = await errorOf(() => api.sendMessage(1, 'hi'));

    expect(error.message).toBe('Bad Request: chat not found');
    expect(error.status).toBe(400);
    expect(error.retryAfter).toBeUndefined();
  });

  it('reports 429 with retryAfter parsed from the description', async () => {
    responder = () => ({
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 7',
      },
    });
    const api = new TelegramBotApi(TOKEN);

    const error = await errorOf(() => api.getUpdates(0, 1));

    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(7);
    expect(error.message).toContain('retry after 7');
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    responder = () => ({ status: 502, body: null });
    const api = new TelegramBotApi(TOKEN);

    const error = await errorOf(() => api.getMe());

    expect(error.status).toBe(502);
    expect(error.message).toBe('Bot API 502');
  });
});
