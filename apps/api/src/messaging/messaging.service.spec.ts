import { tl } from '@mtcute/node';
import type { TelegramClient } from '@mtcute/node';
import type { AccountsService } from '../accounts/accounts.service.js';
import { MAX_MEDIA_BYTES, MAX_MEDIA_THUMB_BYTES } from './media.js';
import { MessagingService } from './messaging.service.js';
import { downloadFileBuffer } from './telegram-download.js';

vi.mock('./telegram-download.js', () => ({
  downloadFileBuffer: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(downloadFileBuffer).mockReset();
  vi.mocked(downloadFileBuffer).mockImplementation(async () =>
    Buffer.from([1, 2, 3]),
  );
});

const USER_ID = 'local';
const ACCOUNT_ID = 'account';
const CHAT_ID = 1830539716;
const CHANNEL_ID = -1002060803714;

interface FakeClient {
  client: TelegramClient;
  getPeer: ReturnType<typeof vi.fn>;
  resolvePeer: ReturnType<typeof vi.fn>;
  getUser: ReturnType<typeof vi.fn>;
  getChat: ReturnType<typeof vi.fn>;
  getFullUser: ReturnType<typeof vi.fn>;
  getFullChat: ReturnType<typeof vi.fn>;
  searchMessages: ReturnType<typeof vi.fn>;
  getDiscussionMessage: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  deleteHistory: ReturnType<typeof vi.fn>;
  leaveChat: ReturnType<typeof vi.fn>;
  downloadAsBuffer: ReturnType<typeof vi.fn>;
  iterDialogs: ReturnType<typeof vi.fn>;
}

const inputPeerUser = {
  _: 'inputPeerUser',
  userId: CHAT_ID,
  accessHash: 1n,
};
const inputPeerChannel = {
  _: 'inputPeerChannel',
  channelId: 2060803714,
  accessHash: 2n,
};

const userPeer = {
  id: CHAT_ID,
  type: 'user',
  displayName: 'Peer',
  username: 'peer',
  photo: null,
  inputPeer: inputPeerUser,
};
const channelPeer = {
  id: CHANNEL_ID,
  type: 'chat',
  chatType: 'channel',
  displayName: 'AID Notes',
  username: 'AIcode_AID',
  photo: null,
  inputPeer: inputPeerChannel,
};

const discussionChatId = -1001234567890;
const discussionRoot = {
  id: 900,
  chat: { id: discussionChatId, type: 'chat', displayName: 'AID Notes' },
};
const commentMessage = {
  id: 901,
  text: 'первый комментарий',
  date: new Date('2026-11-20T10:00:00.000Z'),
  isOutgoing: false,
  sender: {
    id: 777,
    type: 'user',
    displayName: 'Bob',
    username: 'bob',
  },
  chat: { id: discussionChatId, type: 'chat', displayName: 'AID Notes' },
  replyToMessage: null,
  media: null,
  raw: { _: 'message' },
};

/** Client whose cache lookup (`getPeer`) always misses, like an uncached chat. */
function createFakeClient(
  overrides: {
    resolved?: Record<string, unknown>;
    resolveFails?: boolean;
    peer?: Record<string, unknown>;
    dialogs?: Array<{ peer: Record<string, unknown> }>;
    discussion?: Record<string, unknown> | null;
    threadMessages?: Array<Record<string, unknown>>;
    sentMessage?: Record<string, unknown>;
  } = {},
): FakeClient {
  const resolved = overrides.resolved ?? inputPeerUser;
  const peer = overrides.peer ?? userPeer;
  const dialogs = overrides.dialogs ?? [];

  const getPeer = vi.fn(async () => {
    throw new Error(`Peer ${CHAT_ID} is not found in local cache`);
  });
  const resolvePeer = vi.fn(async () => {
    if (overrides.resolveFails) {
      throw new Error(`Peer ${CHAT_ID} is not found in local cache`);
    }
    return resolved;
  });
  const getUser = vi.fn(async () => peer);
  const getChat = vi.fn(async () => peer);
  const getFullUser = vi.fn(async () => ({
    id: CHAT_ID,
    type: peer.type,
    displayName: 'Peer',
    username: 'peer',
    bio: 'hello there',
  }));
  const getFullChat = vi.fn(async () => ({
    id: CHANNEL_ID,
    type: 'chat',
    chatType: 'channel',
    displayName: 'AID Notes',
    username: 'AIcode_AID',
    bio: 'Автоматизация',
    membersCount: 375,
  }));
  const searchMessages = vi.fn(async () => overrides.threadMessages ?? []);
  const getDiscussionMessage = vi.fn(
    async () =>
      overrides.discussion === undefined ? null : overrides.discussion,
  );
  const sendText = vi.fn(
    async () => overrides.sentMessage ?? { ...commentMessage },
  );
  const deleteHistory = vi.fn(async () => undefined);
  const leaveChat = vi.fn(async () => undefined);
  const downloadAsBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const iterDialogs = vi.fn(async function* () {
    for (const dialog of dialogs) yield dialog;
  });

  const client = {
    getPeer,
    resolvePeer,
    getUser,
    getChat,
    getFullUser,
    getFullChat,
    searchMessages,
    getDiscussionMessage,
    sendText,
    deleteHistory,
    leaveChat,
    downloadAsBuffer,
    iterDialogs,
  } as unknown as TelegramClient;

  return {
    client,
    getPeer,
    resolvePeer,
    getUser,
    getChat,
    getFullUser,
    getFullChat,
    searchMessages,
    getDiscussionMessage,
    sendText,
    deleteHistory,
    leaveChat,
    downloadAsBuffer,
    iterDialogs,
  };
}

function createService(
  client: TelegramClient,
  speech?: { available(): boolean; transcribe: unknown } | null,
  frames?: { collage(input: { data: Buffer; mimeType: string }): Promise<Buffer | null> },
  prisma?: { soul: { findUnique(args: unknown): Promise<unknown> } } | null,
): MessagingService {
  const accounts = {
    resolveSession: async () => ({ client }),
  } as unknown as AccountsService;
  return new MessagingService(
    accounts,
    undefined,
    speech as never,
    frames as never,
    prisma as never,
  );
}

describe('uncached peer resolution', () => {
  it('resolves a private chat through Telegram instead of getChat', async () => {
    const fake = createFakeClient();
    const service = createService(fake.client);

    const info = await service.getChatInfo(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
    );

    expect(info).toMatchObject({
      id: CHAT_ID,
      type: 'user',
      title: 'Peer',
      about: 'hello there',
      isChannel: false,
      isGroup: false,
    });
    expect(fake.getPeer).toHaveBeenCalledWith(CHAT_ID);
    expect(fake.resolvePeer).toHaveBeenCalledWith(CHAT_ID, true);
    expect(fake.getUser).toHaveBeenCalledTimes(1);
    expect(fake.getFullUser).toHaveBeenCalledWith(CHAT_ID);
    expect(fake.getChat).not.toHaveBeenCalled();
    expect(fake.getFullChat).not.toHaveBeenCalled();
  });

  it('keeps bots on the full-user path, never getChat/getFullChat', async () => {
    const fake = createFakeClient({
      peer: { ...userPeer, type: 'bot' },
    });
    const service = createService(fake.client);

    const info = await service.getChatInfo(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
    );

    expect(info).toMatchObject({
      type: 'bot',
      isChannel: false,
      isGroup: false,
    });
    expect(fake.getFullUser).toHaveBeenCalledTimes(1);
    expect(fake.getFullChat).not.toHaveBeenCalled();
    expect(fake.getChat).not.toHaveBeenCalled();
  });

  it('resolves a channel through getChat and reads getFullChat', async () => {
    const fake = createFakeClient({
      resolved: inputPeerChannel,
      peer: channelPeer,
    });
    const service = createService(fake.client);

    const info = await service.getChatInfo(
      USER_ID,
      ACCOUNT_ID,
      String(CHANNEL_ID),
    );

    expect(info).toMatchObject({
      id: CHANNEL_ID,
      type: 'channel',
      title: 'AID Notes',
      memberCount: 375,
      isChannel: true,
    });
    expect(fake.getChat).toHaveBeenCalledTimes(1);
    expect(fake.getFullChat).toHaveBeenCalledWith(CHANNEL_ID);
    expect(fake.getUser).not.toHaveBeenCalled();
    expect(fake.getFullUser).not.toHaveBeenCalled();
  });

  it('falls back to the dialog list when no access hash is available', async () => {
    const fake = createFakeClient({
      resolveFails: true,
      dialogs: [{ peer: userPeer }],
    });
    const service = createService(fake.client);

    const info = await service.getChatInfo(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
    );

    expect(info).toMatchObject({
      id: CHAT_ID,
      type: 'user',
      title: 'Peer',
      about: 'hello there',
      isChannel: false,
      isGroup: false,
    });
    expect(fake.getPeer).toHaveBeenCalledWith(CHAT_ID);
    expect(fake.resolvePeer).toHaveBeenCalledWith(CHAT_ID, true);
    expect(fake.iterDialogs).toHaveBeenCalled();
    // The dialog list already carries the peer, so no extra lookup is needed.
    expect(fake.getUser).not.toHaveBeenCalled();
    expect(fake.getFullUser).toHaveBeenCalledWith(CHAT_ID);
    expect(fake.getChat).not.toHaveBeenCalled();
    expect(fake.getFullChat).not.toHaveBeenCalled();
  });

  it('uses the dialog peer for a channel and reads getFullChat', async () => {
    const fake = createFakeClient({
      resolveFails: true,
      peer: channelPeer,
      dialogs: [{ peer: channelPeer }],
    });
    const service = createService(fake.client);

    const info = await service.getChatInfo(
      USER_ID,
      ACCOUNT_ID,
      String(CHANNEL_ID),
    );

    expect(info).toMatchObject({
      id: CHANNEL_ID,
      type: 'channel',
      title: 'AID Notes',
      memberCount: 375,
      isChannel: true,
    });
    expect(fake.iterDialogs).toHaveBeenCalled();
    expect(fake.getFullChat).toHaveBeenCalledWith(CHANNEL_ID);
    expect(fake.getChat).not.toHaveBeenCalled();
    expect(fake.getUser).not.toHaveBeenCalled();
    expect(fake.getFullUser).not.toHaveBeenCalled();
  });

  it('rethrows the original resolution error when the dialog scan misses', async () => {
    const fake = createFakeClient({ resolveFails: true });
    const service = createService(fake.client);

    await expect(
      service.getChatInfo(USER_ID, ACCOUNT_ID, String(CHAT_ID)),
    ).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'TELEGRAM_ERROR',
        message: `Peer ${CHAT_ID} is not found in local cache`,
      },
    });
    expect(fake.iterDialogs).toHaveBeenCalled();
    expect(fake.getChat).not.toHaveBeenCalled();
  });

  it('resolves GET /chats/:id from the dialog list', async () => {
    const fake = createFakeClient({
      resolveFails: true,
      dialogs: [{ peer: userPeer }],
    });
    const service = createService(fake.client);

    const chat = await service.getChat(USER_ID, ACCOUNT_ID, String(CHAT_ID));

    expect(chat).toEqual({
      id: CHAT_ID,
      type: 'user',
      title: 'Peer',
      username: 'peer',
    });
    expect(fake.iterDialogs).toHaveBeenCalled();
    expect(fake.getChat).not.toHaveBeenCalled();
  });

  it('uses the resolved peer for chat media search', async () => {
    const fake = createFakeClient();
    const service = createService(fake.client);

    const media = await service.getChatInfoMedia(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      { kind: 'media' },
    );

    expect(media).toEqual({ items: [], nextOffsetId: null });
    expect(fake.getPeer).toHaveBeenCalledWith(CHAT_ID);
    expect(fake.resolvePeer).toHaveBeenCalledWith(CHAT_ID, true);
    expect(fake.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: userPeer }),
    );
  });

  it('loads an avatar for an uncached private chat', async () => {
    const photo = { small: { type: 'photo', fileId: 1n } };
    const fake = createFakeClient({
      peer: { ...userPeer, photo },
    });
    const service = createService(fake.client);

    const avatar = await service.chatAvatar(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
    );

    expect(avatar?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(fake.getUser).toHaveBeenCalledTimes(1);
    expect(downloadFileBuffer).toHaveBeenCalledWith(fake.client, photo.small);
  });

  it('branches deleteChat by the resolved peer type', async () => {    const fake = createFakeClient();
    const service = createService(fake.client);

    await service.deleteChat(USER_ID, ACCOUNT_ID, String(CHAT_ID));

    expect(fake.resolvePeer).toHaveBeenCalledWith(CHAT_ID, true);
    expect(fake.deleteHistory).toHaveBeenCalledWith(CHAT_ID, {
      mode: 'delete',
    });
    expect(fake.leaveChat).not.toHaveBeenCalled();
    expect(fake.getChat).not.toHaveBeenCalled();
  });
});

describe('message-level features', () => {
  const message = {
    id: 77,
    text: 'hello',
    date: new Date('2026-11-20T12:00:00.000Z'),
    isOutgoing: false,
    sender: userPeer,
    chat: userPeer,
    replyToMessage: null,
    media: null,
    raw: { _: 'message' },
  };

  it('sends a reaction and returns the refreshed message', async () => {
    const sendReaction = vi.fn(async () => message);
    const getMessages = vi.fn(async () => [message]);
    const service = createService({
      sendReaction,
      getMessages,
    } as unknown as TelegramClient);

    const view = await service.sendReaction(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
      { emoji: '👍' },
    );

    expect(sendReaction).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      message: 77,
      emoji: '👍',
    });
    expect(view).toMatchObject({ id: 77, text: 'hello' });
  });

  it('removes a reaction with null and tolerates a failed re-fetch', async () => {
    const sendReaction = vi.fn(async () => null);
    const getMessages = vi.fn(async () => {
      throw new Error('gone');
    });
    const service = createService({
      sendReaction,
      getMessages,
    } as unknown as TelegramClient);

    const view = await service.sendReaction(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
      { emoji: null },
    );

    expect(sendReaction).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      message: 77,
      emoji: null,
    });
    expect(view).toBeNull();
  });

  it('votes in a poll and maps its new state', async () => {
    const poll = {
      type: 'poll',
      id: { toString: () => '99' },
      question: 'Pick one',
      answers: [
        { text: 'A', voters: 2, chosen: true, correct: true },
        { text: 'B', voters: 0, chosen: false, correct: false },
      ],
      voters: 2,
      isClosed: false,
      isQuiz: true,
      isMultiple: false,
      hideResultsUntilClose: false,
      solution: 'A is right',
    };
    const sendVote = vi.fn(async () => poll);
    const service = createService({ sendVote } as unknown as TelegramClient);

    const view = await service.votePoll(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
      { options: [0] },
    );

    expect(sendVote).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      message: 77,
      options: [0],
    });
    expect(view).toMatchObject({
      id: '99',
      quiz: true,
      answers: [{ index: 0, chosen: true }, { index: 1, chosen: false }],
      solution: 'A is right',
    });
  });

  it('retracts a vote with null options', async () => {
    const sendVote = vi.fn(async () => ({
      type: 'poll',
      answers: [],
      voters: 0,
    }));
    const service = createService({ sendVote } as unknown as TelegramClient);

    await service.votePoll(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77', {});

    expect(sendVote).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      message: 77,
      options: null,
    });
  });

  it('translates message text with the default target', async () => {
    const getMessages = vi.fn(async () => [message]);
    const translateText = vi.fn(async () => ({ text: 'привет', entities: [] }));
    const service = createService({
      getMessages,
      translateText,
    } as unknown as TelegramClient);

    const result = await service.translateMessage(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
    );

    expect(translateText).toHaveBeenCalledWith('hello', 'ru');
    expect(result).toEqual({ text: 'привет', to: 'ru' });
  });

  it('rejects translating a message without text', async () => {
    const getMessages = vi.fn(async () => [{ ...message, text: '   ' }]);
    const translateText = vi.fn();
    const service = createService({
      getMessages,
      translateText,
    } as unknown as TelegramClient);

    await expect(
      service.translateMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77'),
    ).rejects.toMatchObject({ status: 400 });
    expect(translateText).not.toHaveBeenCalled();
  });

  it('transcribes a voice note through the raw TL call', async () => {    const resolvePeer = vi.fn(async () => inputPeerUser);
    const call = vi.fn(async () => ({ text: 'привет', pending: true }));
    const service = createService({
      resolvePeer,
      call,
    } as unknown as TelegramClient);

    const result = await service.transcribeVoice(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
    );

    expect(call).toHaveBeenCalledWith({
      _: 'messages.transcribeAudio',
      peer: inputPeerUser,
      msgId: 77,
    });
    expect(result).toEqual({ text: 'привет', pending: true });
  });

  it('falls back to the local engine when Telegram requires Premium', async () => {
    const call = vi.fn(async () => {
      throw new tl.RpcError(403, 'PREMIUM_ACCOUNT_REQUIRED' as never);
    });
    const speech = {
      available: () => true,
      transcribe: vi.fn(async () => ({
        text: 'локальная расшифровка',
        language: null,
        durationMs: 900,
      })),
    };
    const service = createService(
      {
        resolvePeer: vi.fn(async () => inputPeerUser),
        call,
      } as unknown as TelegramClient,
      speech,
    );
    const download = vi.spyOn(service, 'downloadMedia').mockResolvedValue({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
      disposition: 'inline',
      length: 5,
    });

    const result = await service.transcribeVoice(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
    );

    expect(result).toEqual({ text: 'локальная расшифровка', pending: false });
    expect(download).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
      undefined,
    );
    expect(speech.transcribe).toHaveBeenCalledWith({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
    });
  });

  it('rethrows the Premium error when the local engine fails', async () => {
    const call = vi.fn(async () => {
      throw new tl.RpcError(403, 'PREMIUM_ACCOUNT_REQUIRED' as never);
    });
    const speech = {
      available: () => true,
      transcribe: vi.fn(async () => null),
    };
    const service = createService(
      {
        resolvePeer: vi.fn(async () => inputPeerUser),
        call,
      } as unknown as TelegramClient,
      speech,
    );
    vi.spyOn(service, 'downloadMedia').mockResolvedValue({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
      disposition: 'inline',
      length: 5,
    });

    await expect(
      service.transcribeVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77'),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'PREMIUM_REQUIRED' },
    });
  });

  it('does not call the local engine for a non-Premium transcription error', async () => {
    const call = vi.fn(async () => {
      throw new tl.RpcError(400, 'MSG_VOICE_MISSING' as never);
    });
    const speech = { available: () => true, transcribe: vi.fn() };
    const service = createService(
      {
        resolvePeer: vi.fn(async () => inputPeerUser),
        call,
      } as unknown as TelegramClient,
      speech,
    );
    const download = vi.spyOn(service, 'downloadMedia');

    await expect(
      service.transcribeVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77'),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'TRANSCRIPTION_UNAVAILABLE' },
    });
    expect(speech.transcribe).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('serves and caches a thumbnail for ?thumb=1', async () => {
    const thumb = { width: 320, isVideo: false };
    const media = {
      type: 'photo',
      getThumbnail: (type: string) => (type === 'm' ? thumb : null),
      thumbnails: [thumb],
    };
    const getMessages = vi.fn(async () => [{ ...message, media }]);
    vi.mocked(downloadFileBuffer).mockResolvedValueOnce(Buffer.from([9]));
    const service = createService({
      getMessages,
    } as unknown as TelegramClient);

    const first = await service.downloadMedia(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
      undefined,
      undefined,
      '1',
    );

    expect(downloadFileBuffer).toHaveBeenCalledWith(expect.anything(), thumb, {
      maxBytes: MAX_MEDIA_THUMB_BYTES,
    });
    expect(first.mimeType).toBe('image/jpeg');
    expect(first.disposition.startsWith('inline')).toBe(true);

    // The preview is cached under `:thumb`, so the second request is free.
    await service.downloadMedia(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
      undefined,
      undefined,
      '1',
    );
    expect(downloadFileBuffer).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it('falls back to the full file when there is no thumbnail', async () => {
    const media = { type: 'photo' };
    const getMessages = vi.fn(async () => [{ ...message, media }]);
    const service = createService({
      getMessages,
    } as unknown as TelegramClient);

    const result = await service.downloadMedia(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '77',
      undefined,
      undefined,
      'true',
    );

    expect(downloadFileBuffer).toHaveBeenCalledWith(expect.anything(), media, {
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(result.data).toEqual(Buffer.from([1, 2, 3]));
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('deletes a message for everyone by default and honours revoke=false', async () => {
    const deleteMessagesById = vi.fn(async () => undefined);
    const service = createService({
      deleteMessagesById,
    } as unknown as TelegramClient);

    await service.deleteMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77');
    expect(deleteMessagesById).toHaveBeenLastCalledWith(
      CHAT_ID,
      [77],
      { revoke: true },
    );

    await service.deleteMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), '77', {
      revoke: 'false',
    });
    expect(deleteMessagesById).toHaveBeenLastCalledWith(
      CHAT_ID,
      [77],
      { revoke: false },
    );
  });

  it('retries a rejected photo once as a document', async () => {
    const sendMedia = vi
      .fn()
      .mockRejectedValueOnce(new tl.RpcError(400, 'IMAGE_PROCESS_FAILED' as never))
      .mockResolvedValueOnce(message);
    const service = createService({ sendMedia } as unknown as TelegramClient);

    const view = await service.sendMedia(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      buffer: Buffer.from([1, 2, 3]),
      fileName: 'tiny.png',
      mimeType: 'image/png',
      size: 3,
    });

    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(sendMedia.mock.calls[0]?.[1]).toMatchObject({ type: 'photo' });
    expect(sendMedia.mock.calls[1]?.[1]).toMatchObject({ type: 'document' });
    expect(view.id).toBe(77);
  });

  it('does not retry a non-photo media failure', async () => {
    const sendMedia = vi
      .fn()
      .mockRejectedValue(new tl.RpcError(400, 'CHAT_SEND_MEDIA_FORBIDDEN' as never));
    const service = createService({ sendMedia } as unknown as TelegramClient);

    await expect(
      service.sendMedia(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
        buffer: Buffer.from([1]),
        fileName: 'a.bin',
        mimeType: 'application/octet-stream',
        size: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(sendMedia).toHaveBeenCalledTimes(1);
  });
});

describe('channel comment threads', () => {
  it('returns an empty thread when the post has no discussion', async () => {
    const fake = createFakeClient({ discussion: null });
    const service = createService(fake.client);

    const thread = await service.getMessageThread(
      USER_ID,
      ACCOUNT_ID,
      String(CHANNEL_ID),
      '42',
    );

    expect(thread).toEqual({
      chatId: CHANNEL_ID,
      messageId: 42,
      discussionChatId: null,
      comments: [],
      nextOffsetId: null,
    });
    expect(fake.getDiscussionMessage).toHaveBeenCalledWith({
      chatId: CHANNEL_ID,
      message: 42,
    });
    expect(fake.searchMessages).not.toHaveBeenCalled();
  });

  it('maps newest-first comments and pages older by offsetId', async () => {
    const fake = createFakeClient({
      discussion: discussionRoot,
      threadMessages: [commentMessage, { ...commentMessage, id: 900 }],
    });
    const service = createService(fake.client);

    const thread = await service.getMessageThread(
      USER_ID,
      ACCOUNT_ID,
      String(CHANNEL_ID),
      '42',
      { limit: '20', offsetId: '1000' },
    );

    expect(fake.searchMessages).toHaveBeenCalledWith({
      chatId: discussionChatId,
      threadId: discussionRoot.id,
      limit: 20,
      offset: 1000,
    });
    expect(thread.discussionChatId).toBe(discussionChatId);
    // The thread root (id 900) is not a comment.
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({
      id: 901,
      chatId: discussionChatId,
      text: 'первый комментарий',
      senderName: 'Bob',
    });
  });

  it('sends a comment as a reply to the discussion root', async () => {
    const fake = createFakeClient({ discussion: discussionRoot });
    const service = createService(fake.client);

    const created = await service.sendComment(
      USER_ID,
      ACCOUNT_ID,
      String(CHANNEL_ID),
      '42',
      { text: '  привет  ' },
    );

    expect(fake.sendText).toHaveBeenCalledWith(
      discussionChatId,
      'привет',
      { replyTo: discussionRoot.id },
    );
    expect(created).toMatchObject({ id: 901, text: 'первый комментарий' });
  });

  it('rejects a comment on a post without a discussion', async () => {
    const fake = createFakeClient({ discussion: null });
    const service = createService(fake.client);

    await expect(
      service.sendComment(USER_ID, ACCOUNT_ID, String(CHANNEL_ID), '42', {
        text: 'привет',
      }),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'THREAD_NOT_FOUND' },
    });
    expect(fake.sendText).not.toHaveBeenCalled();
  });

  it('rejects empty comment text before touching Telegram', async () => {
    const fake = createFakeClient({ discussion: discussionRoot });
    const service = createService(fake.client);

    await expect(
      service.sendComment(USER_ID, ACCOUNT_ID, String(CHANNEL_ID), '42', {
        text: '   ',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_ERROR' },
    });
    expect(fake.getDiscussionMessage).not.toHaveBeenCalled();
  });
});

describe('message frame collages', () => {
  const stickerMessage = {
    id: 88,
    text: '',
    date: new Date('2026-11-20T12:00:00.000Z'),
    isOutgoing: false,
    sender: userPeer,
    chat: userPeer,
    replyToMessage: null,
    media: {
      type: 'sticker',
      mimeType: 'application/x-tgsticker',
      fileName: null,
      fileSize: 101,
      emoji: '🐷',
      sourceType: 'animated',
      width: 512,
      height: 512,
      thumbnails: [],
    },
    raw: { _: 'message' },
  };

  it('returns a JPEG collage of a sticker', async () => {
    const getMessages = vi.fn(async () => [stickerMessage]);
    vi.mocked(downloadFileBuffer).mockResolvedValueOnce(Buffer.from('tgs'));
    const collage = vi.fn(async () => Buffer.from('jpeg-collage'));
    const service = createService(
      { getMessages } as unknown as TelegramClient,
      undefined,
      { collage },
    );

    const frames = await service.messageFrames(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '88',
    );

    expect(collage).toHaveBeenCalledWith({
      data: Buffer.from('tgs'),
      mimeType: 'application/x-tgsticker',
    });
    expect(frames.mimeType).toBe('image/jpeg');
    expect(frames.data.toString()).toBe('jpeg-collage');
    expect(frames.disposition.startsWith('inline')).toBe(true);
    expect(frames.length).toBe(Buffer.byteLength('jpeg-collage'));
  });

  it('serves a cached collage without downloading again', async () => {
    const getMessages = vi.fn(async () => [stickerMessage]);
    vi.mocked(downloadFileBuffer).mockResolvedValue(Buffer.from('tgs'));
    const collage = vi.fn(async () => Buffer.from('jpeg-collage'));
    const service = createService(
      { getMessages } as unknown as TelegramClient,
      undefined,
      { collage },
    );

    await service.messageFrames(USER_ID, ACCOUNT_ID, String(CHAT_ID), '88');
    const second = await service.messageFrames(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      '88',
    );

    expect(second.data.toString()).toBe('jpeg-collage');
    expect(collage).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it('404s with FRAMES_UNAVAILABLE when no collage can be produced', async () => {
    const getMessages = vi.fn(async () => [stickerMessage]);
    vi.mocked(downloadFileBuffer).mockResolvedValue(Buffer.from('tgs'));
    const service = createService(
      { getMessages } as unknown as TelegramClient,
      undefined,
      { collage: async () => null },
    );

    await expect(
      service.messageFrames(USER_ID, ACCOUNT_ID, String(CHAT_ID), '88'),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'FRAMES_UNAVAILABLE' },
    });
  });

  it('404s with FRAMES_UNAVAILABLE when the message has no media', async () => {
    const noMedia = { ...stickerMessage, media: null };
    const getMessages = vi.fn(async () => [noMedia]);
    const service = createService(
      { getMessages } as unknown as TelegramClient,
      undefined,
      { collage: async () => Buffer.from('never') },
    );

    await expect(
      service.messageFrames(USER_ID, ACCOUNT_ID, String(CHAT_ID), '88'),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'FRAMES_UNAVAILABLE' },
    });
  });
});

describe('sendMessage typing', () => {
  it('shows "typing…" for an explicit duration and cancels it after sending', async () => {
    const fake = createFakeClient();
    const service = createService(fake.client);
    const typing = vi
      .spyOn(service, 'sendTyping')
      .mockResolvedValue({ status: 'typing' });

    await service.sendMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      text: 'привет',
      typing: 5,
    });

    expect(typing).toHaveBeenNthCalledWith(
      1,
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      { status: 'typing', sessionId: undefined },
    );
    expect(typing).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      { status: 'cancel', sessionId: undefined },
    );
    expect(fake.sendText).toHaveBeenCalledTimes(1);
  });

  it('sends instantly when typing is off', async () => {
    const fake = createFakeClient();
    const service = createService(fake.client);
    const typing = vi.spyOn(service, 'sendTyping');

    await service.sendMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      text: 'привет',
      typing: 'off',
    });

    expect(typing).not.toHaveBeenCalled();
    expect(fake.sendText).toHaveBeenCalledTimes(1);
  });

  it('keeps the old behaviour when typing is omitted', async () => {
    const fake = createFakeClient();
    const service = createService(fake.client);
    const typing = vi.spyOn(service, 'sendTyping');

    await service.sendMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      text: 'привет',
    });

    expect(typing).not.toHaveBeenCalled();
  });

  it('applies the soul policy for typing: auto', async () => {
    const fake = createFakeClient();
    const prisma = {
      soul: {
        findUnique: async () => ({
          settings: JSON.stringify({
            typingMode: 'on_compose',
            typingSpeed: 300,
            // A 1 ms window keeps the test fast; the clamp is unit-tested.
            typingMinMs: 1,
            typingMaxMs: 1,
            typingHeartbeatMs: 4_000,
          }),
        }),
      },
    };
    const service = createService(fake.client, null, undefined, prisma);
    const typing = vi
      .spyOn(service, 'sendTyping')
      .mockResolvedValue({ status: 'typing' });

    await service.sendMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      text: 'привет',
      typing: 'auto',
    });

    expect(typing).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      { status: 'typing', sessionId: undefined },
    );
    expect(fake.sendText).toHaveBeenCalledTimes(1);
  });

  it('honours an off policy with typing: auto', async () => {
    const fake = createFakeClient();
    const prisma = {
      soul: {
        findUnique: async () => ({
          settings: JSON.stringify({ typingMode: 'off' }),
        }),
      },
    };
    const service = createService(fake.client, null, undefined, prisma);
    const typing = vi.spyOn(service, 'sendTyping');

    await service.sendMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      text: 'привет',
      typing: 'auto',
    });

    expect(typing).not.toHaveBeenCalled();
  });

  it('rejects a junk typing value', async () => {
    const fake = createFakeClient();
    const service = createService(fake.client);

    await expect(
      service.sendMessage(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
        text: 'привет',
        typing: 'soon',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fake.sendText).not.toHaveBeenCalled();
  });
});
