export interface RealtimeEvent {
  event: string;
  payload: unknown;
}

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();

/** Publishes a socket event to component-local subscribers. */
export function publishRealtimeEvent(event: string, payload: unknown): void {
  for (const listener of listeners) {
    try {
      listener({ event, payload });
    } catch {
      // A broken subscriber must not stop the others.
    }
  }
}

export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
