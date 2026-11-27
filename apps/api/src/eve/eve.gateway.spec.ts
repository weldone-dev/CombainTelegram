import type { Server, Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EveGateway } from './eve.gateway.js';

const TOKEN = 'test-eve-token';

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  handshake: {
    auth: Record<string, unknown>;
    query: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
  join: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function socket(handshake: Partial<FakeSocket['handshake']> = {}): FakeSocket {
  return {
    id: 'socket-1',
    data: {},
    handshake: {
      auth: {},
      query: {},
      headers: {},
      ...handshake,
    },
    join: vi.fn(async () => undefined),
    disconnect: vi.fn(),
  };
}

function connect(gateway: EveGateway, client: FakeSocket): Promise<void> {
  return gateway.handleConnection(client as unknown as Socket);
}

beforeEach(() => {
  process.env.EVE_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.EVE_TOKEN;
});

describe('EveGateway', () => {
  it('disconnects when EVE_TOKEN is not configured', async () => {
    delete process.env.EVE_TOKEN;
    const gateway = new EveGateway();
    const client = socket({ auth: { token: TOKEN } });

    await connect(gateway, client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('disconnects a socket without a valid token', async () => {
    const gateway = new EveGateway();

    for (const handshake of [
      {},
      { auth: { token: 'wrong' } },
      { query: { token: 'wrong' } },
    ]) {
      const client = socket(handshake);
      await connect(gateway, client);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    }
  });

  it('joins the eve room only after a valid token', async () => {
    const gateway = new EveGateway();

    const fromAuth = socket({ auth: { token: TOKEN } });
    await connect(gateway, fromAuth);
    expect(fromAuth.join).toHaveBeenCalledWith('eve');
    expect(fromAuth.data.eve).toBe(true);

    const fromQuery = socket({ query: { token: TOKEN } });
    await connect(gateway, fromQuery);
    expect(fromQuery.join).toHaveBeenCalledWith('eve');

    const fromHeader = socket({ headers: { 'x-eve-token': TOKEN } });
    await connect(gateway, fromHeader);
    expect(fromHeader.join).toHaveBeenCalledWith('eve');
  });

  it('broadcasts only to the authenticated eve room', () => {
    const gateway = new EveGateway();
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;

    gateway.broadcast({ id: 'evt-1' });

    expect(to).toHaveBeenCalledWith('eve');
    expect(emit).toHaveBeenCalledWith('eve.event', { id: 'evt-1' });
  });

  it('does not throw before the server is attached', () => {
    const gateway = new EveGateway();

    expect(() => gateway.broadcast({ id: 'evt-1' })).not.toThrow();
  });
});
