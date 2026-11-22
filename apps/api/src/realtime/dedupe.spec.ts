import { EventDeduplicator } from './dedupe.js';

describe('EventDeduplicator', () => {
  it('emits the first occurrence and suppresses the same key inside the TTL', () => {
    let now = 1_000;
    const dedupe = new EventDeduplicator(10_000, () => now);
    const key = 'account-1:42:100:new';

    expect(dedupe.shouldEmit(key)).toBe(true);
    expect(dedupe.shouldEmit(key)).toBe(false);

    now += 9_999;
    expect(dedupe.shouldEmit(key)).toBe(false);

    now += 1;
    expect(dedupe.shouldEmit(key)).toBe(true);
  });

  it('keeps different keys independent', () => {
    const dedupe = new EventDeduplicator();

    expect(dedupe.shouldEmit('account-1:42:100:new')).toBe(true);
    expect(dedupe.shouldEmit('account-1:42:101:new')).toBe(true);
    expect(dedupe.shouldEmit('account-1:42:100:edited')).toBe(true);
    expect(dedupe.shouldEmit('account-2:42:100:new')).toBe(true);
    expect(dedupe.shouldEmit('account-1:42:100:new')).toBe(false);
  });

  it('prunes expired keys so the map does not grow forever', () => {
    let now = 0;
    const dedupe = new EventDeduplicator(1_000, () => now);
    for (let index = 0; index < 1_100; index += 1) {
      dedupe.shouldEmit(`key-${index}`);
    }

    expect(dedupe.size).toBeLessThanOrEqual(1_100);

    now = 10_000;
    expect(dedupe.shouldEmit('fresh')).toBe(true);
    expect(dedupe.size).toBeLessThan(1_100);
  });

  it('can be reset', () => {
    const dedupe = new EventDeduplicator();
    expect(dedupe.shouldEmit('key')).toBe(true);
    dedupe.reset();
    expect(dedupe.shouldEmit('key')).toBe(true);
  });
});
