import type { AccountsService } from '../accounts/accounts.service.js';
import { apiError } from '../common/api-error.js';
import type { ChatView } from '../messaging/message-view.js';
import { MessagingService } from '../messaging/messaging.service.js';
import type { TdMessagingService } from './td-messaging.service.js';

const USER_ID = 'local';
const ACCOUNT_ID = 'account';
const CHAT_ID = 1830539716;

const chatView: ChatView = {
  id: CHAT_ID,
  type: 'user',
  title: 'Alice',
  username: 'alice',
  lastMessage: null,
  unreadCount: 0,
  pinned: false,
  muted: false,
  archived: false,
  readInboxMaxId: 0,
  canSendMessages: true,
};

const dialog = {
  peer: {
    id: CHAT_ID,
    type: 'user',
    displayName: 'Alice',
    username: 'alice',
    permissions: { canSendMessages: true },
  },
  lastMessage: null,
  unreadCount: 0,
  isPinned: false,
  isMuted: false,
  isArchived: false,
  raw: { readInboxMaxId: 0 },
};

const sentMessage = {
  id: 77,
  text: 'hello',
  date: new Date('2026-11-20T10:00:00.000Z'),
  isOutgoing: true,
  sender: {
    id: CHAT_ID,
    type: 'user',
    displayName: 'Alice',
    username: 'alice',
  },
  chat: { id: CHAT_ID, type: 'user', displayName: 'Alice', username: 'alice' },
  replyToMessage: null,
  media: null,
  raw: { _: 'message' },
};

function fakeAccounts(client: Record<string, unknown>) {
  const resolveSession = vi.fn(async () => ({ client }));
  const accounts = { resolveSession } as unknown as AccountsService;
  return { accounts, resolveSession };
}

function fakeTd(overrides: Record<string, unknown> = {}) {
  const messenger = {
    listChats: vi.fn(async () => [chatView]),
    sendMessage: vi.fn(async () => ({ ...chatView, id: 1 })),
    ...overrides,
  };
  const forAccount = vi.fn(async () => messenger);
  const td = { forAccount } as unknown as TdMessagingService;
  return { td, forAccount, messenger };
}

describe('MessagingService TDLib routing', () => {
  it('uses TDLib when the account has a live TDLib session', async () => {
    const { accounts, resolveSession } = fakeAccounts({});
    const { td, forAccount } = fakeTd();
    const service = new MessagingService(accounts, td);

    const result = await service.listChats(USER_ID, ACCOUNT_ID, {
      limit: '5',
    });

    expect(result).toEqual([chatView]);
    expect(forAccount).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, undefined);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('falls back to mtcute when TDLib throws', async () => {
    const client = {
      async *iterDialogs() {
        yield dialog;
      },
    };
    const { accounts, resolveSession } = fakeAccounts(client);
    const { td } = fakeTd({
      listChats: vi.fn(async () => {
        throw new Error('TDLib is down');
      }),
    });
    const service = new MessagingService(accounts, td);

    const result = await service.listChats(USER_ID, ACCOUNT_ID, {});

    expect(result.map((view) => view.id)).toEqual([CHAT_ID]);
    expect(resolveSession).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, undefined);
  });

  it('falls back to mtcute when the TDLib client cannot be opened', async () => {
    const client = {
      async *iterDialogs() {
        yield dialog;
      },
    };
    const { accounts, resolveSession } = fakeAccounts(client);
    const td = {
      forAccount: vi.fn(async () => {
        throw new Error('TDLib did not become ready in time');
      }),
    } as unknown as TdMessagingService;
    const service = new MessagingService(accounts, td);

    const result = await service.listChats(USER_ID, ACCOUNT_ID, {});

    expect(result).toHaveLength(1);
    expect(resolveSession).toHaveBeenCalled();
  });

  it('falls back to mtcute for writes too', async () => {
    const sendText = vi.fn(async () => sentMessage);
    const { accounts } = fakeAccounts({ sendText });
    const { td } = fakeTd({
      sendMessage: vi.fn(async () => {
        throw new Error('CHAT_WRITE_FORBIDDEN');
      }),
    });
    const service = new MessagingService(accounts, td);

    const result = await service.sendMessage(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      {
        text: 'hello',
      },
    );

    expect(sendText).toHaveBeenCalledWith(CHAT_ID, 'hello', {});
    expect(result).toMatchObject({ id: 77, text: 'hello', outgoing: true });
  });

  it('keeps working with no TdMessagingService at all', async () => {
    const client = {
      async *iterDialogs() {
        yield dialog;
      },
    };
    const service = new MessagingService(fakeAccounts(client).accounts);

    const result = await service.listChats(USER_ID, ACCOUNT_ID, {});
    expect(result).toHaveLength(1);
  });
});

const DISCUSSION_CHAT_ID = -1001234567890;
const discussionRoot = {
  id: 900,
  chat: { id: DISCUSSION_CHAT_ID, type: 'chat', displayName: 'Comments' },
};

describe('MessagingService channel thread routing', () => {
  it('serves comments from TDLib without touching mtcute', async () => {
    const threadView = {
      chatId: CHAT_ID,
      messageId: 42,
      discussionChatId: DISCUSSION_CHAT_ID,
      comments: [],
      nextOffsetId: null,
    };
    const getMessageThread = vi.fn(async () => threadView);
    const { accounts, resolveSession } = fakeAccounts({});
    const { td, forAccount } = fakeTd({ getMessageThread });
    const service = new MessagingService(accounts, td);

    const thread = await service.getMessageThread(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '42',
      { limit: '20', offsetId: '900' },
    );

    expect(thread).toEqual(threadView);
    expect(forAccount).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, undefined);
    expect(getMessageThread).toHaveBeenCalledWith(CHAT_ID, 42, {
      limit: 20,
      offsetId: 900,
    });
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('surfaces the TDLib thread error instead of replaying the message id', async () => {
    const getDiscussionMessage = vi.fn(async () => discussionRoot);
    const { accounts, resolveSession } = fakeAccounts({ getDiscussionMessage });
    const { td } = fakeTd({
      getMessageThread: vi.fn(async () => {
        throw new Error('TDLib does not know this message id');
      }),
    });
    const service = new MessagingService(accounts, td);

    await expect(
      service.getMessageThread(
        USER_ID,
        ACCOUNT_ID,
        String(CHAT_ID),
        '42',
      ),
    ).rejects.toMatchObject({
      status: 502,
      response: { code: 'TELEGRAM_ERROR' },
    });
    expect(getDiscussionMessage).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('surfaces the TDLib commenting error instead of replaying the message id', async () => {
    const { accounts, resolveSession } = fakeAccounts({});
    const { td } = fakeTd({
      sendComment: vi.fn(async () => {
        throw new Error('TDLib cannot send here');
      }),
    });
    const service = new MessagingService(accounts, td);

    await expect(
      service.sendComment(USER_ID, ACCOUNT_ID, String(CHAT_ID), '42', {
        text: 'привет',
      }),
    ).rejects.toMatchObject({
      status: 502,
      response: { code: 'TELEGRAM_ERROR' },
    });
    expect(resolveSession).not.toHaveBeenCalled();
  });
});

const infoPeer = {
  id: CHAT_ID,
  type: 'user',
  displayName: 'Alice',
  username: 'alice',
  photo: null,
  inputPeer: { _: 'inputPeerUser', userId: CHAT_ID, accessHash: 1n },
};

describe('MessagingService id-scoped routing', () => {
  it('does not replay a failed TDLib reaction through mtcute', async () => {
    const sendReaction = vi.fn(async () => sentMessage);
    const { accounts, resolveSession } = fakeAccounts({ sendReaction });
    const { td } = fakeTd({
      sendReaction: vi.fn(async () => {
        throw new Error("The reaction isn't available for the message");
      }),
    });
    const service = new MessagingService(accounts, td);

    await expect(
      service.sendReaction(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77', {
        emoji: '👍',
      }),
    ).rejects.toMatchObject({
      status: 502,
      response: { code: 'TELEGRAM_ERROR' },
    });
    expect(sendReaction).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('keeps the mtcute fallback for chat-scoped calls', async () => {
    const readHistory = vi.fn(async () => undefined);
    const { accounts, resolveSession } = fakeAccounts({ readHistory });
    const { td } = fakeTd({
      markRead: vi.fn(async () => {
        throw new Error('TDLib is down');
      }),
    });
    const service = new MessagingService(accounts, td);

    const view = await service.markRead(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      { maxId: '5' },
    );

    expect(view).toEqual({ read: true, maxId: 5 });
    expect(readHistory).toHaveBeenCalledWith(CHAT_ID, { maxId: 5 });
    expect(resolveSession).toHaveBeenCalled();
  });
});

describe('MessagingService chat-info and text routing', () => {
  it('serves chat info media from TDLib with its message ids', async () => {
    const item = {
      messageId: 500,
      date: '2026-11-20T10:00:00.000Z',
      text: 'photo',
      media: null,
      url: null,
      poll: null,
    };
    const getChatInfoMedia = vi.fn(async () => ({
      items: [item],
      nextOffsetId: 500,
    }));
    const { accounts, resolveSession } = fakeAccounts({});
    const { td } = fakeTd({ getChatInfoMedia });
    const service = new MessagingService(accounts, td);

    const view = await service.getChatInfoMedia(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      { kind: 'media', limit: '10', offsetId: '900' },
    );

    expect(view).toEqual({ items: [item], nextOffsetId: 500 });
    expect(getChatInfoMedia).toHaveBeenCalledWith(CHAT_ID, {
      kind: 'media',
      limit: 10,
      offsetId: 900,
    });
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('falls back to mtcute when TDLib media search throws', async () => {
    const getPeer = vi.fn(async () => infoPeer);
    const searchMessages = vi.fn(async () => []);
    const { accounts, resolveSession } = fakeAccounts({
      getPeer,
      searchMessages,
    });
    const { td } = fakeTd({
      getChatInfoMedia: vi.fn(async () => {
        throw new Error('TDLib is not ready');
      }),
    });
    const service = new MessagingService(accounts, td);

    const view = await service.getChatInfoMedia(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      { kind: 'media' },
    );

    expect(view).toEqual({ items: [], nextOffsetId: null });
    expect(resolveSession).toHaveBeenCalled();
    expect(searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: infoPeer }),
    );
  });

  it('translates through TDLib, not the mtcute transcript', async () => {
    const translateMessage = vi.fn(async () => ({ text: 'привет', to: 'ru' }));
    const { accounts, resolveSession } = fakeAccounts({});
    const { td } = fakeTd({ translateMessage });
    const service = new MessagingService(accounts, td);

    const view = await service.translateMessage(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
    );

    expect(view).toEqual({ text: 'привет', to: 'ru' });
    expect(translateMessage).toHaveBeenCalledWith(CHAT_ID, 77, 'ru');
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('does not replay a TDLib transcription error against mtcute', async () => {
    const { accounts, resolveSession } = fakeAccounts({});
    const { td } = fakeTd({
      transcribeVoice: vi.fn(async () => {
        throw apiError(
          'TRANSCRIPTION_FAILED',
          'Telegram could not transcribe this voice message',
          502,
        );
      }),
    });
    const service = new MessagingService(accounts, td);

    await expect(
      service.transcribeVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77'),
    ).rejects.toMatchObject({
      status: 502,
      response: { code: 'TRANSCRIPTION_FAILED' },
    });
    expect(resolveSession).not.toHaveBeenCalled();
  });
});
