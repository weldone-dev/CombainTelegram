import type { chat } from 'tdlib-native/types';
import { TdChatRegistry } from './td-chat-registry.js';
import type { TdRegistryClient } from './td-chat-registry.js';

const USER_ID = 1830539716;
const BASIC_GROUP_ID = 123456;
const CHANNEL_ID = -(1_000_000_000_000 + 2060803714);

function makeChat(id: number, type: chat['type'], title = `chat ${id}`) {
  return { _: 'chat', id, type, title } as unknown as chat;
}

const privateChat = makeChat(USER_ID, {
  _: 'chatTypePrivate',
  user_id: USER_ID,
});
const channelChat = makeChat(
  CHANNEL_ID,
  {
    _: 'chatTypeSupergroup',
    supergroup_id: 2060803714,
    is_channel: true,
  },
  'Channel',
);
const basicChat = makeChat(-BASIC_GROUP_ID, {
  _: 'chatTypeBasicGroup',
  basic_group_id: BASIC_GROUP_ID,
});

interface FakeClient {
  client: TdRegistryClient;
  getChats: ReturnType<typeof vi.fn>;
  loadChats: ReturnType<typeof vi.fn>;
  getChat: ReturnType<typeof vi.fn>;
  emit: (update: Record<string, unknown>) => void;
}

function fakeClient(
  options: {
    chats?: chat[];
    listAfterLoad?: chat[];
    direct?: Record<number, chat>;
  } = {},
): FakeClient {
  let loaded = false;
  const chats = options.chats ?? [];
  const handlers = new Set<(update: Record<string, unknown>) => void>();

  const getChats = vi.fn(async () => {
    const source = loaded ? (options.listAfterLoad ?? chats) : chats;
    return {
      _: 'chats',
      total_count: source.length,
      chat_ids: source.map((c) => c.id),
    };
  });
  const loadChats = vi.fn(async () => {
    loaded = true;
    return { _: 'ok' };
  });
  const getChat = vi.fn(async ({ chat_id }: { chat_id: number }) => {
    const found =
      options.direct?.[chat_id] ??
      [...chats, ...(options.listAfterLoad ?? []), basicChat].find(
        (entry) => entry.id === chat_id,
      );
    if (!found) throw new Error(`chat ${chat_id} not found`);
    return found;
  });

  const client = {
    api: { getChats, loadChats, getChat },
    updates: {
      subscribe(handler: (update: Record<string, unknown>) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  } as unknown as TdRegistryClient;

  return {
    client,
    getChats,
    loadChats,
    getChat,
    emit: (update) => {
      for (const handler of handlers) handler(update);
    },
  };
}

describe('TdChatRegistry', () => {
  it('seeds main and archive lists and resolves a peer id', async () => {
    const fake = fakeClient({ chats: [privateChat, channelChat] });
    const registry = new TdChatRegistry(fake.client);
    registry.attach();

    await registry.seed();

    expect(fake.loadChats).toHaveBeenCalled();
    expect(await registry.resolve(USER_ID)).toBe(USER_ID);
    expect(await registry.resolve(CHANNEL_ID)).toBe(CHANNEL_ID);
    expect(registry.size).toBe(2);
    registry.dispose();
  });

  it('stays fresh from updateNewChat', async () => {
    const fake = fakeClient({ chats: [] });
    const registry = new TdChatRegistry(fake.client);
    registry.attach();

    fake.emit({ _: 'updateNewChat', chat: channelChat });

    expect(registry.tryResolve(CHANNEL_ID)).toBe(CHANNEL_ID);
    expect(await registry.resolve(CHANNEL_ID)).toBe(CHANNEL_ID);
    registry.dispose();
  });

  it('retries loadChats + getChats before giving up', async () => {
    const fake = fakeClient({ chats: [], listAfterLoad: [privateChat] });
    const registry = new TdChatRegistry(fake.client);
    registry.attach();

    expect(await registry.resolve(USER_ID)).toBe(USER_ID);
    expect(fake.loadChats).toHaveBeenCalled();
    registry.dispose();
  });

  it('falls back to getChat for a basic group that is not listed yet', async () => {
    const fake = fakeClient({ chats: [] });
    const registry = new TdChatRegistry(fake.client);
    registry.attach();

    expect(await registry.resolve(BASIC_GROUP_ID)).toBe(-BASIC_GROUP_ID);
    // Positive id is tried first (user), then the negative basic-group id.
    expect(fake.getChat).toHaveBeenCalledWith({ chat_id: BASIC_GROUP_ID });
    expect(fake.getChat).toHaveBeenCalledWith({ chat_id: -BASIC_GROUP_ID });
    registry.dispose();
  });

  it('throws a 404-style error for an unknown peer', async () => {
    const fake = fakeClient({ chats: [] });
    const registry = new TdChatRegistry(fake.client);
    registry.attach();

    await expect(registry.resolve(999)).rejects.toMatchObject({
      response: { code: 'TD_CHAT_NOT_FOUND' },
    });
    registry.dispose();
  });

  it('caches folders from updateChatFolders', () => {
    const fake = fakeClient();
    const registry = new TdChatRegistry(fake.client);
    registry.attach();

    fake.emit({
      _: 'updateChatFolders',
      chat_folders: [
        {
          id: 2,
          name: {
            _: 'chatFolderName',
            text: { _: 'formattedText', text: 'Work', entities: [] },
            animate_custom_emoji: false,
          },
          icon: null,
          color_id: -1,
          is_shareable: false,
          has_my_invite_links: false,
        },
      ],
      main_chat_list_position: 0,
      are_tags_enabled: false,
    });

    expect(registry.folders().map((folder) => folder.id)).toEqual([2]);
    registry.dispose();
  });
});
