import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { emitLog } from '../logs/log-sink.js';
import { SoulsService, parseSoulSettings } from './souls.service.js';

/** Clamps a number of seconds into `[0, max]`. */
function seconds(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value)));
}

interface PresenceState {
  /** Whether the account is currently shown as online. */
  online: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Pending "come back online" delay after a message arrived offline. */
  onlineTimer?: ReturnType<typeof setTimeout>;
  onlineAt?: number;
}

/** How long the autopilot should wait before reading and before typing. */
export interface PresenceGate {
  /** Delay before the read receipt, measured from the incoming message. */
  readDelayMs: number;
  /** Extra pause between the read receipt and the first "typing…". */
  typingDelayMs: number;
}

interface PresencePayload {
  accountId?: unknown;
  chatId?: unknown;
  message?: { outgoing?: boolean };
}

/**
 * Keeps the account looking like a person: online while there is activity,
 * offline after `presenceIdleMinutes` without any, and back online when a
 * message arrives. The first message after the pause is read after
 * `presenceReadDelaySeconds` instead of instantly.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private subscription?: Subscription;
  private readonly states = new Map<string, PresenceState>();

  constructor(
    private readonly users: DefaultUserService,
    private readonly realtime: RealtimeService,
    private readonly souls: SoulsService,
    private readonly messaging: MessagingService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscription = this.realtime.events$.subscribe((event) => {
      const payload = (event.payload ?? {}) as PresencePayload;
      const accountId =
        typeof payload.accountId === 'string' ? payload.accountId : '';
      if (!accountId) return;
      if (event.event === 'ai.reply') {
        this.touch(accountId);
        return;
      }
      if (event.event === 'message.new' && payload.message?.outgoing) {
        this.touch(accountId);
      }
    });

    // Arm the idle timer for every account that has a soul, so a restart does
    // not leave the account online forever.
    try {
      const souls = await this.souls.list();
      for (const soul of souls) await this.scheduleIdle(soul.accountId);
    } catch (error) {
      this.logger.warn(
        `Could not arm presence timers: ${(error as Error).message}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    for (const state of this.states.values()) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      if (state.onlineTimer) clearTimeout(state.onlineTimer);
    }
    this.states.clear();
  }

  /** Marks the account active; it goes offline again after the idle window. */
  touch(accountId: string): void {
    const state = this.state(accountId);
    if (state.onlineTimer) {
      clearTimeout(state.onlineTimer);
      state.onlineTimer = undefined;
      state.onlineAt = undefined;
    }
    if (!state.online) {
      state.online = true;
      void this.applyOnline(accountId, true);
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'presence.online',
        message: 'Activity after the pause; the account is online again',
        status: 'ok',
        accountId,
      });
    }
    void this.scheduleIdle(accountId);
  }

  /**
   * Explicit owner switch: forces the account online or offline right now.
   *
   * Pending "come back online" and idle timers are cancelled first, so the
   * forced value is not immediately overwritten by the scheduler. Going
   * online re-arms the idle window, so the account still goes offline after
   * `presenceIdleMinutes` of inactivity.
   */
  async setOnline(
    accountId: string,
    online: boolean,
  ): Promise<{ online: boolean }> {
    const state = this.state(accountId);
    if (state.onlineTimer) {
      clearTimeout(state.onlineTimer);
      state.onlineTimer = undefined;
      state.onlineAt = undefined;
    }
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    state.online = online;
    await this.applyOnline(accountId, online);
    if (online) void this.scheduleIdle(accountId);
    emitLog({
      level: 'info',
      source: 'ai',
      action: 'presence.forced',
      message: `Presence forced ${online ? 'online' : 'offline'} by the owner`,
      status: 'ok',
      accountId,
      details: { online },
    });
    return { online };
  }

  /**
   * Called for an incoming DM before the autopilot reads it. Returns how long
   * to wait before marking it read: `0` while the account is already online,
   * otherwise "time until online" + the configured read delay. The account
   * does not jump online instantly — it looks like the person picked up the
   * phone after a few seconds.
   */
  async incoming(accountId: string, chatId: number): Promise<PresenceGate> {
    const settings = await this.settingsFor(accountId);
    const state = this.state(accountId);
    if (state.online) {
      this.touch(accountId);
      return { readDelayMs: 0, typingDelayMs: 0 };
    }
    const readDelayMs =
      seconds(settings?.presenceReadDelaySeconds ?? 0, 300) * 1000;
    const typingDelayMs =
      seconds(settings?.presenceTypingDelaySeconds ?? 3, 120) * 1000;
    const onlineDelayMs =
      seconds(settings?.presenceOnlineDelaySeconds ?? 5, 600) * 1000;
    let onlineInMs = onlineDelayMs;
    if (state.onlineTimer && state.onlineAt !== undefined) {
      onlineInMs = Math.max(0, state.onlineAt - Date.now());
    } else {
      state.onlineAt = Date.now() + onlineDelayMs;
      const timer = setTimeout(() => {
        void this.goOnline(accountId);
      }, onlineDelayMs);
      timer.unref?.();
      state.onlineTimer = timer;
    }
    const untilReadMs = onlineInMs + readDelayMs;
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'presence.pending',
      message: `Offline; online in ${onlineInMs} ms, read in ${untilReadMs} ms, typing ${typingDelayMs} ms later`,
      status: 'ok',
      accountId,
      chatId,
      details: { onlineInMs, readDelayMs: untilReadMs, typingDelayMs },
    });
    return { readDelayMs: untilReadMs, typingDelayMs };
  }

  /** Switches the account online after the "picked up the phone" delay. */
  private async goOnline(accountId: string): Promise<void> {
    const state = this.state(accountId);
    state.onlineTimer = undefined;
    state.onlineAt = undefined;
    if (state.online) return;
    state.online = true;
    await this.applyOnline(accountId, true);
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'presence.online',
      message: 'Back online after the pause',
      status: 'ok',
      accountId,
    });
    void this.scheduleIdle(accountId);
  }

  private state(accountId: string): PresenceState {
    let state = this.states.get(accountId);
    if (!state) {
      // TDLib keeps the account online while it runs.
      state = { online: true };
      this.states.set(accountId, state);
    }
    return state;
  }

  private async settingsFor(accountId: string) {
    const soul = await this.souls.model(accountId);
    return soul ? parseSoulSettings(soul.settings) : null;
  }

  private async scheduleIdle(accountId: string): Promise<void> {
    const settings = await this.settingsFor(accountId);
    if (!settings) return;
    const state = this.state(accountId);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    const minutes = Math.min(
      180,
      Math.max(0, settings.presenceIdleMinutes),
    );
    if (minutes === 0) {
      if (!state.online) {
        state.online = true;
        await this.applyOnline(accountId, true);
      }
      return;
    }
    const timer = setTimeout(() => {
      void this.goOffline(accountId, minutes);
    }, minutes * 60_000);
    timer.unref?.();
    state.idleTimer = timer;
  }

  private async goOffline(accountId: string, minutes: number): Promise<void> {
    const state = this.state(accountId);
    state.idleTimer = undefined;
    if (!state.online) return;
    state.online = false;
    await this.applyOnline(accountId, false);
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'presence.offline',
      message: `No activity for ${minutes} min; the account looks offline`,
      status: 'ok',
      accountId,
      details: { idleMinutes: minutes },
    });
  }

  private async applyOnline(accountId: string, online: boolean): Promise<void> {
    try {
      const user = await this.users.get();
      const applied = await this.messaging.setOnline(
        user.id,
        accountId,
        online,
      );
      if (applied.online !== online) {
        emitLog({
          level: 'warn',
          source: 'ai',
          action: 'presence.option_ignored',
          message: `TDLib kept the account ${applied.online ? 'online' : 'offline'} instead of switching`,
          status: 'failed',
          accountId,
          details: { requested: online, applied: applied.online },
        });
      }
    } catch (error) {
      this.logger.warn(
        `Could not switch presence of ${accountId}: ${(error as Error).message}`,
      );
    }
  }
}
