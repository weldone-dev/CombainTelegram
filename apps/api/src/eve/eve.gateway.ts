import { Logger } from '@nestjs/common';
import type { OnGatewayConnection } from '@nestjs/websockets';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { eveTokenEnabled, eveTokenMatches } from './eve-token.js';

/**
 * Live feed for the Eve channel: `/internal/eve` namespace.
 *
 * This is only the low-latency path. The durable path is
 * `GET /internal/eve/events?cursor=...`; Eve must replay it after a restart.
 *
 * A socket is disconnected unless it presents the shared `EVE_TOKEN`; only
 * authenticated sockets join the `eve` room, so `broadcast()` can never reach
 * an unauthenticated client.
 */
@WebSocketGateway({
  namespace: '/internal/eve',
  cors: { origin: true, credentials: true },
})
export class EveGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EveGateway.name);

  @WebSocketServer()
  server?: Server;

  async handleConnection(client: Socket): Promise<void> {
    if (!eveTokenEnabled()) {
      client.disconnect(true);
      return;
    }
    if (!eveTokenMatches(this.tokenOf(client))) {
      this.logger.warn(`Eve socket rejected: ${client.id}`);
      client.disconnect(true);
      return;
    }
    client.data.eve = true;
    await client.join('eve');
  }

  broadcast(event: unknown): void {
    try {
      this.server?.to('eve').emit('eve.event', event);
    } catch (error) {
      this.logger.warn(`Eve broadcast failed: ${(error as Error).message}`);
    }
  }

  private tokenOf(client: Socket): string | undefined {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    if (typeof auth?.token === 'string') return auth.token;
    const query = client.handshake.query as { token?: unknown } | undefined;
    if (typeof query?.token === 'string') return query.token;
    const header = client.handshake.headers['x-eve-token'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    return undefined;
  }
}
