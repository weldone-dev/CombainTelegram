/**
 * Suppresses the same event arriving twice — Telegram delivers updates for one
 * Telegram account to every attached session (PC + phone), so a message from a
 * third party shows up once per session within the same second.
 *
 * A key (`accountId:chatId:messageId:kind`) is emitted at most once per TTL
 * window (10 s by default). Old keys are pruned opportunistically.
 */
export class EventDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns `true` the first time `key` is seen inside the TTL window. */
  shouldEmit(key: string): boolean {
    const timestamp = this.now();
    const previous = this.seen.get(key);
    if (previous !== undefined && timestamp - previous < this.ttlMs) {
      return false;
    }
    this.seen.set(key, timestamp);
    if (this.seen.size > 1024) this.prune(timestamp);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(timestamp: number): void {
    for (const [key, seenAt] of this.seen) {
      if (timestamp - seenAt >= this.ttlMs) this.seen.delete(key);
    }
  }
}
