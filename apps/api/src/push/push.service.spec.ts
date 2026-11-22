import {
  PUSH_BODY_LIMIT,
  PushThrottle,
  buildPushPayload,
  mediaPlaceholder,
  resolveVapidConfig,
  truncatePushBody,
} from './push.service.js';

describe('push payload', () => {
  it('uses message text and the chat title without an account name', () => {
    expect(
      buildPushPayload(
        { accountId: 'acc', chatId: 42, text: '  hello\n world ' },
        { chatTitle: 'Alice' },
      ),
    ).toEqual({
      title: 'Alice',
      body: 'hello world',
      chatId: 42,
      accountId: 'acc',
      tag: 'chat:42',
    });
  });

  it('prefixes the account name when it is known', () => {
    const payload = buildPushPayload(
      { accountId: 'acc', chatId: 7, text: 'hi' },
      { accountName: 'Roman', chatTitle: 'Work chat' },
    );
    expect(payload.title).toBe('Roman: Work chat');
  });

  it('falls back to a generic title without a dialog title', () => {
    const payload = buildPushPayload({ accountId: 'acc', chatId: 9, text: '' });
    expect(payload.title).toBe('Чат 9');
  });

  it('uses a media placeholder for text-less messages', () => {
    expect(
      buildPushPayload({ accountId: 'acc', chatId: 1, text: '', mediaType: 'photo' })
        .body,
    ).toBe('Фото');
    expect(
      buildPushPayload({
        accountId: 'acc',
        chatId: 1,
        text: '',
        mediaType: 'voice',
      }).body,
    ).toBe('Голосовое сообщение');
    expect(
      buildPushPayload({
        accountId: 'acc',
        chatId: 1,
        text: '',
        mediaType: 'unknown-media',
      }).body,
    ).toBe('Медиа');
    expect(
      buildPushPayload({ accountId: 'acc', chatId: 1, text: '' }).body,
    ).toBe('Новое сообщение');
  });

  it('labels known media types and generic ones', () => {
    expect(mediaPlaceholder('video')).toBe('Видео');
    expect(mediaPlaceholder(null)).toBe('Новое сообщение');
    expect(mediaPlaceholder('something')).toBe('Медиа');
  });
});

describe('push body truncation', () => {
  it('keeps short text and collapses whitespace', () => {
    expect(truncatePushBody(' a   b ')).toBe('a b');
  });

  it('cuts long text to the limit with an ellipsis', () => {
    const long = 'x'.repeat(PUSH_BODY_LIMIT + 50);
    const result = truncatePushBody(long);
    expect(result.length).toBe(PUSH_BODY_LIMIT);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('x')).toBe(true);
  });

  it('honours a custom limit', () => {
    expect(truncatePushBody('abcdef', 4)).toBe('abc…');
  });
});

describe('push throttle', () => {
  it('allows one push per chat per 10 seconds', () => {
    const throttle = new PushThrottle();
    const now = 1_000_000;
    expect(throttle.allow('u', 1, now)).toBe(true);
    throttle.record('u', 1, now);
    expect(throttle.allow('u', 1, now + 1_000)).toBe(false);
    expect(throttle.allow('u', 1, now + 10_000)).toBe(true);
    // Another chat of the same user is independent.
    expect(throttle.allow('u', 2, now + 1_000)).toBe(true);
    // Another user is independent as well.
    expect(throttle.allow('other', 1, now + 1_000)).toBe(true);
  });

  it('caps one user at 20 pushes per minute', () => {
    const throttle = new PushThrottle();
    const now = 5_000_000;
    for (let chat = 0; chat < 20; chat += 1) {
      expect(throttle.allow('u', chat, now)).toBe(true);
      throttle.record('u', chat, now);
    }
    expect(throttle.allow('u', 21, now + 1_000)).toBe(false);
    // A minute after the first batch the budget is free again.
    expect(throttle.allow('u', 21, now + 60_000)).toBe(true);
    // Other users are unaffected.
    expect(throttle.allow('other', 99, now + 1_000)).toBe(true);
  });

  it('does not consume the budget when a check is denied', () => {
    const throttle = new PushThrottle();
    const now = 9_000_000;
    expect(throttle.allow('u', 1, now)).toBe(true);
    throttle.record('u', 1, now);
    expect(throttle.allow('u', 1, now + 500)).toBe(false);
    // The denied check left no extra timestamp behind.
    expect(throttle.allow('u', 1, now + 10_000)).toBe(true);
  });
});

describe('VAPID configuration', () => {
  it('is enabled with both keys and the default subject', () => {
    const result = resolveVapidConfig({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
    });
    expect(result.enabled).toBe(true);
    expect(result.config).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:admin@localhost',
    });
    expect(result.missing).toEqual([]);
  });

  it('keeps a configured subject', () => {
    const result = resolveVapidConfig({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:me@example.com',
    });
    expect(result.config?.subject).toBe('mailto:me@example.com');
  });

  it('is disabled when either key is missing', () => {
    const missingPrivate = resolveVapidConfig({ VAPID_PUBLIC_KEY: 'pub' });
    expect(missingPrivate.enabled).toBe(false);
    expect(missingPrivate.config).toBeNull();
    expect(missingPrivate.missing).toEqual(['VAPID_PRIVATE_KEY']);

    const empty = resolveVapidConfig({});
    expect(empty.enabled).toBe(false);
    expect(empty.missing).toEqual(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']);
  });
});
