import type { TelegramClient } from '@mtcute/node';
import type { AccountsService } from '../accounts/accounts.service.js';
import { MessagingService } from './messaging.service.js';

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

/** Client whose cache lookup (`getPeer`) always misses, like an uncached chat. */
function createFakeClient(
  overrides: {
    resolved?: Record<string, unknown>;
    resolveFails?: boolean;
    peer?: Record<string, unknown>;
    dialogs?: Array<{ peer: Record<string, unknown> }>;
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
  const searchMessages = vi.fn(async () => []);
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
    deleteHistory,
    leaveChat,
    downloadAsBuffer,
    iterDialogs,
  };
}

function createService(client: TelegramClient): MessagingService {
  const accounts = {
    resolveSession: async () => ({ client }),
  } as unknown as AccountsService;
  return new MessagingService(accounts);
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
    expect(fake.downloadAsBuffer).toHaveBeenCalledWith(photo.small);
  });

  it('branches deleteChat by the resolved peer type', async () => {
    const fake = createFakeClient();
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
