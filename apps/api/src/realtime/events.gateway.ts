import { Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { OnGatewayConnection, OnGatewayInit } from '@nestjs/websockets';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Subscription } from 'rxjs';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { emitLog } from '../logs/log-sink.js';
import { RealtimeService } from './realtime.service.js';
import { UpdatesService } from './updates.service.js';
import { TdUpdatesService } from '../tdlib/td-updates.service.js';

/**
 * `/events` namespace.
 *
 * The app is single-user: every socket joins `user:<DEFAULT_USER_ID>` without a
 * token. Events are still namespaced by user so a future multi-user mode only
 * has to change the guard here.
 */
@WebSocketGateway({
  namespace: '/events',
  cors: { origin: true, credentials: true },
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy
{
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  private subscription?: Subscription;

  constructor(
    private readonly realtime: RealtimeService,
    private readonly users: DefaultUserService,
    private readonly updates: UpdatesService,
    private readonly tdUpdates: TdUpdatesService,
  ) {}

  afterInit(): void {
    this.subscription = this.realtime.events$.subscribe((event) => {
      this.server.to(`user:${event.userId}`).emit(event.event, event.payload);
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    const user = await this.users.get();
    await client.join(`user:${user.id}`);
    client.data.userId = user.id;

    try {
      await this.updates.startForUser(user.id);
    } catch (error) {
      this.logger.warn(
        `Could not start updates for user ${user.id}: ${(error as Error).message}`,
      );
      emitLog({
        level: 'warn',
        source: 'realtime',
        action: 'realtime.updates.start',
        message: `Could not start updates for user ${user.id}: ${(error as Error).message}`,
        status: 'failed',
        userId: user.id,
        details: { error: (error as Error).message },
      });
    }

    try {
      await this.tdUpdates.startForUser(user.id);
    } catch (error) {
      this.logger.warn(
        `Could not start TDLib updates for user ${user.id}: ${(error as Error).message}`,
      );
      emitLog({
        level: 'warn',
        source: 'realtime',
        action: 'realtime.tdlib.start',
        message: `Could not start TDLib updates for user ${user.id}: ${(error as Error).message}`,
        status: 'failed',
        userId: user.id,
        details: { error: (error as Error).message },
      });
    }

    client.emit('ready', { userId: user.id });
  }

  // Declared explicitly so Nest's lifecycle hooks stay obvious in tests.
  async onModuleDestroy(): Promise<void> {
    this.subscription?.unsubscribe();
  }
}
