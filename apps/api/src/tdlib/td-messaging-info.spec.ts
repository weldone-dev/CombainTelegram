import { describe, expect, it, vi } from 'vitest';
import type { chat, message, user } from 'tdlib-native/types';
import type { TelegramSessionModel } from '@repo/database';
import { TdSessionMessenger } from './td-messaging.service.js';

const SUPERGROUP_ID = 111;
const CHANNEL_ID = -(1_000_000_000_000 + SUPERGROUP_ID);
const SIMILAR_SUPERGROUP_ID = 222;
const SIMILAR_CHAT_ID = -(1_000_000_000_000 + SIMILAR_SUPERGROUP_ID);
const USER_ID = 501;
const NOW = 1_700_000_000;

const text = (value: string) => ({
  _: 'formattedText',
  text: value,
  entities: [],
});

function chatFixture(
  id: number,
  supergroupId: number,
  title = 'Channel',
  isChannel = true,
): chat {
  return {
    _: 'chat',
    id,
    type: {
      _: 'chatTypeSupergroup',
      supergroup_id: supergroupId,
      is_channel: isChannel,
    },
    title,
    photo: null,
    permissions: { _: 'chatPermissions', can_send_basic_messages: true },
    last_message: null,
    positions: [],
    chat_lists: [],
    notification_settings: null,
    unread_count: 0,
    last_read_inbox_message_id: 0,
  } as unknown as chat;
}

function messageFixture(
  id: number,
  content: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): message {
  return {
    _: 'message',
    id,
    sender_id: { _: 'messageSenderUser', user_id: USER_ID },
    chat_id: CHANNEL_ID,
    sending_state: null,
    is_outgoing: false,
    date: NOW,
    edit_date: 0,
    reply_to: null,
    topic_id: null,
    content,
    ...overrides,
  } as unknown as message;
}

function photoContent(caption: string) {
  return {
    _: 'messagePhoto',
    photo: {
      sizes: [
        {
          type: 'm',
          width: 320,
          height: 200,
          photo: { id: 1, size: 1234, unique_id: 'photo-1' },
        },
      ],
    },
    video: null,
    caption: text(caption),
    show_caption_above_media: false,
    has_spoiler: false,
  };
}

function pollContent() {
  return {
    _: 'messagePoll',
    poll: {
      id: 7,
      question: text('Best option?'),
      options: [
        { text: text('First'), voter_count: 3, is_chosen: true },
        { text: text('Second'), voter_count: 1, is_chosen: false },
      ],
      total_voter_count: 4,
      type: { _: 'pollTypeRegular' },
      is_closed: false,
      allows_multiple_answers: false,
      can_see_results: true,
    },
  };
}

function voiceContent(speech: unknown) {
  return {
    _: 'messageVoiceNote',
    voice_note: {
      duration: 3,
      waveform: '',
      mime_type: 'audio/ogg',
      speech_recognition_result: speech,
      voice: { id: 2, size: 10, unique_id: 'voice-1' },
    },
    caption: text(''),
    is_listened: false,
  };
}

function userFixture(): user {
  return {
    _: 'user',
    id: USER_ID,
    first_name: 'Bob',
    last_name: '',
    usernames: { active_usernames: ['bob'], editable_username: 'bob' },
    profile_photo: null,
  } as unknown as user;
}

function createMessenger(overrides: Record<string, unknown> = {}) {
  const chats = new Map<number, chat>([
    [CHANNEL_ID, chatFixture(CHANNEL_ID, SUPERGROUP_ID)],
    [
      SIMILAR_CHAT_ID,
      chatFixture(SIMILAR_CHAT_ID, SIMILAR_SUPERGROUP_ID, 'Similar'),
    ],
  ]);
  const listeners = new Set<(update: unknown) => void>();
  const emit = (update: unknown): void => {
    for (const listener of listeners) listener(update);
  };

  const api = {
    loadChats: vi.fn(async () => undefined),
    getChats: vi.fn(async () => ({ chat_ids: [] })),
    getChat: vi.fn(async ({ chat_id }: { chat_id: number }) => {
      const entry = chats.get(chat_id);
      if (!entry) throw new Error(`unknown chat ${chat_id}`);
      return entry;
    }),
    getUser: vi.fn(async () => userFixture()),
    getSupergroup: vi.fn(async () => ({
      usernames: {
        active_usernames: ['channel'],
        editable_username: 'channel',
      },
      status: { _: 'chatMemberStatusMember' },
    })),
    getSupergroupFullInfo: vi.fn(async () => ({ member_count: 1234 })),
    searchChatMessages: vi.fn(async () => ({ messages: [] })),
    getChatSimilarChats: vi.fn(async () => ({ chat_ids: [] })),
    translateMessageText: vi.fn(async () => text('')),
    getMessage: vi.fn(async () => {
      throw new Error('message not found');
    }),
    recognizeSpeech: vi.fn(async () => ({ _: 'ok' })),
    ...overrides,
  };

  const client = {
    api,
    updates: {
      subscribe: vi.fn((listener: (update: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
  };

  const messenger = new TdSessionMessenger(
    {} as TelegramSessionModel,
    client as never,
    {} as never,
  );
  messenger.registry.put(chats.get(CHANNEL_ID) as chat);
  messenger.registry.put(chats.get(SIMILAR_CHAT_ID) as chat);
  return { messenger, api, emit };
}

describe('TdSessionMessenger.getChatInfoMedia', () => {
  it('searches photos and keeps TDLib message ids and media', async () => {
    const { messenger, api } = createMessenger({
      searchChatMessages: vi.fn(async () => ({
        messages: [
          messageFixture(500, photoContent('first')),
          messageFixture(400, photoContent('second')),
          messageFixture(300, photoContent('third')),
        ],
      })),
    });

    const view = await messenger.getChatInfoMedia(CHANNEL_ID, {
      kind: 'media',
      limit: 2,
    });

    expect(api.searchChatMessages).toHaveBeenCalledWith({
      chat_id: CHANNEL_ID,
      query: '',
      from_message_id: 0,
      offset: 0,
      limit: 2,
      filter: { _: 'searchMessagesFilterPhotoAndVideo' },
    });
    expect(view.items.map((item) => item.messageId)).toEqual([500, 400]);
    expect(view.items[0]).toEqual({
      messageId: 500,
      date: new Date(NOW * 1000).toISOString(),
      text: 'first',
      media: {
        kind: 'photo',
        mimeType: 'image/jpeg',
        fileName: null,
        size: 1234,
        downloadable: true,
      },
      url: null,
      poll: null,
    });
    expect(view.nextOffsetId).toBe(400);
  });

  it('paginates strictly older than the offset id', async () => {
    const { messenger, api } = createMessenger({
      searchChatMessages: vi.fn(async () => ({
        messages: [
          messageFixture(400, photoContent('boundary')),
          messageFixture(300, photoContent('older')),
        ],
      })),
    });

    const view = await messenger.getChatInfoMedia(CHANNEL_ID, {
      kind: 'media',
      limit: 2,
      offsetId: 400,
    });

    expect(api.searchChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        from_message_id: 400,
        offset: 0,
        limit: 3,
      }),
    );
    expect(view.items.map((item) => item.messageId)).toEqual([300]);
    expect(view.nextOffsetId).toBe(300);
  });

  it('extracts the first url for the links tab', async () => {
    const { messenger, api } = createMessenger({
      searchChatMessages: vi.fn(async () => ({
        messages: [
          messageFixture(700, {
            _: 'messageText',
            text: text('see https://t.me/similar for more'),
            link_preview: null,
            link_preview_options: null,
          }),
        ],
      })),
    });

    const view = await messenger.getChatInfoMedia(CHANNEL_ID, {
      kind: 'links',
      limit: 10,
    });

    expect(api.searchChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { _: 'searchMessagesFilterUrl' } }),
    );
    expect(view.items[0].url).toBe('https://t.me/similar');
  });

  it('maps poll results for the polls tab', async () => {
    const { messenger, api } = createMessenger({
      searchChatMessages: vi.fn(async () => ({
        messages: [messageFixture(800, pollContent())],
      })),
    });

    const view = await messenger.getChatInfoMedia(CHANNEL_ID, {
      kind: 'polls',
      limit: 10,
    });

    expect(api.searchChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { _: 'searchMessagesFilterPoll' } }),
    );
    expect(view.items[0].poll).toEqual({
      question: 'Best option?',
      options: ['First', 'Second'],
      totalVoters: 4,
    });
  });

  it('retries a cold search cache briefly', async () => {
    const searchChatMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [messageFixture(500, photoContent('warm'))],
      });
    const { messenger } = createMessenger({ searchChatMessages });

    const view = await messenger.getChatInfoMedia(CHANNEL_ID, {
      kind: 'media',
      limit: 1,
    });

    expect(searchChatMessages).toHaveBeenCalledTimes(2);
    expect(view.items.map((item) => item.messageId)).toEqual([500]);
  });
});

describe('TdSessionMessenger.translateMessage', () => {
  it('translates through TDLib and returns the same DTO', async () => {
    const { messenger, api } = createMessenger({
      translateMessageText: vi.fn(async () => text('привет')),
    });

    const view = await messenger.translateMessage(CHANNEL_ID, 77, 'ru');

    expect(api.translateMessageText).toHaveBeenCalledWith({
      chat_id: CHANNEL_ID,
      message_id: 77,
      to_language_code: 'ru',
      tone: '',
    });
    expect(view).toEqual({ text: 'привет', to: 'ru' });
  });

  it('rejects an empty translation like the mtcute endpoint', async () => {
    const { messenger } = createMessenger({
      translateMessageText: vi.fn(async () => text('   ')),
    });

    await expect(
      messenger.translateMessage(CHANNEL_ID, 77, 'ru'),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_ERROR' },
    });
  });
});

describe('TdSessionMessenger.transcribeVoice', () => {
  it('returns an already recognized text without a second request', async () => {
    const { messenger, api } = createMessenger({
      getMessage: vi.fn(async () =>
        messageFixture(
          77,
          voiceContent({
            _: 'speechRecognitionResultText',
            text: 'привет',
          }),
        ),
      ),
    });

    const view = await messenger.transcribeVoice(CHANNEL_ID, 77);

    expect(view).toEqual({ text: 'привет', pending: false });
    expect(api.recognizeSpeech).not.toHaveBeenCalled();
  });

  it('waits for the update that finishes a pending recognition', async () => {
    const { messenger, api, emit } = createMessenger({
      getMessage: vi.fn(async () =>
        messageFixture(
          77,
          voiceContent({
            _: 'speechRecognitionResultPending',
            partial_text: 'прив',
          }),
        ),
      ),
    });

    const pending = messenger.transcribeVoice(CHANNEL_ID, 77);
    await vi.waitFor(() => expect(api.recognizeSpeech).toHaveBeenCalled());
    emit({
      _: 'updateMessageContent',
      chat_id: CHANNEL_ID,
      message_id: 77,
      new_content: voiceContent({
        _: 'speechRecognitionResultText',
        text: 'привет',
      }),
    });

    await expect(pending).resolves.toEqual({ text: 'привет', pending: false });
  });

  it('returns the partial text as pending on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { messenger, api } = createMessenger({
        getMessage: vi.fn(async () =>
          messageFixture(
            77,
            voiceContent({
              _: 'speechRecognitionResultPending',
              partial_text: 'прив',
            }),
          ),
        ),
      });

      const pending = messenger.transcribeVoice(CHANNEL_ID, 77);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.recognizeSpeech).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toEqual({ text: 'прив', pending: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a recognition error to the transcription error contract', async () => {
    const { messenger } = createMessenger({
      getMessage: vi.fn(async () =>
        messageFixture(
          77,
          voiceContent({
            _: 'speechRecognitionResultError',
            error: { code: 400, message: 'MSG_VOICE_TOO_LONG' },
          }),
        ),
      ),
    });

    await expect(
      messenger.transcribeVoice(CHANNEL_ID, 77),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'TRANSCRIPTION_UNAVAILABLE',
        message: 'This voice message is too long to transcribe',
      },
    });
  });
});

describe('TdSessionMessenger.getChatInfoSimilar', () => {
  it('maps similar channels with marked ids and member counts', async () => {
    const { messenger, api } = createMessenger({
      getChatSimilarChats: vi.fn(async () => ({
        chat_ids: [SIMILAR_CHAT_ID],
      })),
    });

    const view = await messenger.getChatInfoSimilar(CHANNEL_ID);

    expect(api.getChatSimilarChats).toHaveBeenCalledWith({
      chat_id: CHANNEL_ID,
    });
    expect(api.getSupergroupFullInfo).toHaveBeenCalledWith({
      supergroup_id: SIMILAR_SUPERGROUP_ID,
    });
    expect(view).toEqual({
      chats: [
        {
          id: SIMILAR_CHAT_ID,
          title: 'Similar',
          username: 'channel',
          memberCount: 1234,
        },
      ],
    });
  });

  it('returns an empty list for a chat that is not a channel', async () => {
    const { messenger, api } = createMessenger({
      getChatSimilarChats: vi.fn(),
      getChat: vi.fn(async () => chatFixture(555, 5, 'Group', false)),
    });
    messenger.registry.put(chatFixture(555, 5, 'Group', false));

    const view = await messenger.getChatInfoSimilar(-(1_000_000_000_000 + 5));

    expect(view).toEqual({ chats: [] });
    expect(api.getChatSimilarChats).not.toHaveBeenCalled();
  });

  it('returns an empty list when TDLib rejects the request', async () => {
    const { messenger } = createMessenger({
      getChatSimilarChats: vi.fn(async () => {
        throw new Error('Chat is not a channel');
      }),
    });

    await expect(messenger.getChatInfoSimilar(CHANNEL_ID)).resolves.toEqual({
      chats: [],
    });
  });
});
