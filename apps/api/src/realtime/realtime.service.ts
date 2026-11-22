import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface RealtimeEvent {
  userId: string;
  event: string;
  payload: unknown;
}

/**
 * In-process event bus between services (updates, auth flows) and the
 * Socket.IO gateway.
 *
 * Services only publish; the gateway subscribes and fans out to the
 * `user:<id>` room. No service imports the gateway, which keeps the module
 * graph acyclic and would let a future multi-node deployment swap the Subject
 * for Redis pub/sub.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly subject = new Subject<RealtimeEvent>();
  readonly events$ = this.subject.asObservable();

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.subject.next({ userId, event, payload });
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}
