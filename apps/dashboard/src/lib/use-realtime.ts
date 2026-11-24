"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL } from "./api";
import { publishRealtimeEvent } from "./realtime-bus";
import type {
  AiReplyEvent,
  AiThinkingEvent,
  LogEntryView,
  RealtimeAuthDoneEvent,
  RealtimeAuthFailedEvent,
  RealtimeDeletedEvent,
  RealtimeMessageEvent,
  RealtimeQrUpdatedEvent,
  RealtimeReadEvent,
  RealtimeTypingEvent,
} from "./types";

export interface RealtimeHandlers {
  onMessageNew?: (payload: RealtimeMessageEvent) => void;
  onMessageEdited?: (payload: RealtimeMessageEvent) => void;
  onMessageDeleted?: (payload: RealtimeDeletedEvent) => void;
  onMessageRead?: (payload: RealtimeReadEvent) => void;
  onChatTyping?: (payload: RealtimeTypingEvent) => void;
  onQrUpdated?: (payload: RealtimeQrUpdatedEvent) => void;
  onQrScanned?: (payload: { attemptId: string }) => void;
  onQrPasswordRequired?: (payload: { attemptId: string }) => void;
  onAuthDone?: (payload: RealtimeAuthDoneEvent) => void;
  onAuthFailed?: (payload: RealtimeAuthFailedEvent) => void;
  onLogNew?: (payload: LogEntryView) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * One Socket.IO connection to the `/events` namespace. The API is single-user,
 * so the socket needs no token; it reconnects automatically.
 */
export function useRealtime(handlers: RealtimeHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket: Socket = io(`${API_URL}/events`, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      transports: ["websocket", "polling"],
    });

    const listen = <T>(
      event: string,
      handler: ((payload: T) => void) | undefined,
    ): void => {
      socket.on(event, (payload: T) => {
        publishRealtimeEvent(event, payload);
        handler?.(payload);
      });
    };

    listen<RealtimeMessageEvent>("message.new", (payload) => {
      handlersRef.current.onMessageNew?.(payload);
    });
    listen<RealtimeMessageEvent>("message.edited", (payload) => {
      handlersRef.current.onMessageEdited?.(payload);
    });
    listen<RealtimeDeletedEvent>("message.deleted", (payload) => {
      handlersRef.current.onMessageDeleted?.(payload);
    });
    listen<RealtimeReadEvent>("message.read", (payload) => {
      handlersRef.current.onMessageRead?.(payload);
    });
    listen<RealtimeTypingEvent>("chat.typing", (payload) => {
      handlersRef.current.onChatTyping?.(payload);
    });
    // Reasoning of an autopilot reply: published on the local bus only.
    listen<AiReplyEvent>("ai.reply", undefined);
    listen<AiThinkingEvent>("ai.thinking", undefined);
    listen<RealtimeQrUpdatedEvent>("auth.qr.updated", (payload) => {
      handlersRef.current.onQrUpdated?.(payload);
    });
    listen("auth.qr.scanned", (payload) => {
      handlersRef.current.onQrScanned?.(payload as { attemptId: string });
    });
    listen("auth.qr.password_required", (payload) => {
      handlersRef.current.onQrPasswordRequired?.(
        payload as { attemptId: string },
      );
    });
    listen<RealtimeAuthDoneEvent>("auth.done", (payload) => {
      handlersRef.current.onAuthDone?.(payload);
    });
    listen<RealtimeAuthFailedEvent>("auth.failed", (payload) => {
      handlersRef.current.onAuthFailed?.(payload);
    });
    listen<LogEntryView>("log.new", (payload) => {
      handlersRef.current.onLogNew?.(payload);
    });
    listen("connect", () => {
      handlersRef.current.onConnect?.();
    });
    listen("disconnect", () => {
      handlersRef.current.onDisconnect?.();
    });

    return () => {
      socket.disconnect();
    };
  }, []);
}
