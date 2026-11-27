import { describe, expect, it, vi } from 'vitest';
import type { TelegramClient } from '@mtcute/node';
import type { AccountsService } from '../accounts/accounts.service.js';
import { setLogSink } from '../logs/log-sink.js';
import type { LogInput } from '../logs/log-sink.js';
import type {
  TdMessenger,
  TdSendStickerInput,
  TdSendVoiceInput,
} from '../tdlib/td-messaging.service.js';
import { MAX_MEDIA_BYTES } from './media.js';
import { MessagingService } from './messaging.service.js';
import type { ContactBlockView } from './messaging.service.js';
import type { MessageView } from './message-view.js';

const USER_ID = 'local';
const ACCOUNT_ID = 'account';
const CHAT_ID = 1830539716;
const CONTACT_ID = 777;

const textMessage = {
  id: 77,
  text: '',
  date: new Date('2026-11-27T10:00:00.000Z'),
  isOutgoing: true,
  sender: {
    id: 1,
    type: 'user',
    displayName: 'Me',
    username: 'me',
  },
  chat: {
    id: CHAT_ID,
    type: 'user',
    displayName: 'Peer',
    username: 'peer',
  },
  replyToMessage: null,
  media: null,
  raw: { _: 'message' },
};

function createService(
  client: TelegramClient,
  messenger?: Partial<TdMessenger>,
): MessagingService {
  const accounts = {
    resolveSession: async () => ({ client }),
  } as unknown as AccountsService;
  const td = messenger
    ? ({
        forAccount: async () => messenger as unknown as TdMessenger,
      } as unknown as TdMessenger)
    : undefined;
  return new MessagingService(accounts, td as never);
}

describe('sendSticker', () => {
  it('dispatches a sticker media through mtcute when no TDLib session is live', async () => {
    const sendMedia = vi.fn(async () => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient);

    const view = await service.sendSticker(
      USER_ID,
      ACCOUNT_ID,
      String(CHAT_ID),
      'CAACAgIAAxkBAAI',
    );

    expect(view.id).toBe(77);
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({ type: 'sticker', file: 'CAACAgIAAxkBAAI' }),
      {},
    );
  });

  it('prefers the TDLib sticker path and skips mtcute', async () => {
    const sendSticker = vi.fn(async () => textMessage as unknown as MessageView);
    const sendMedia = vi.fn(async () => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient, {
      sendSticker,
    });

    await service.sendSticker(USER_ID, ACCOUNT_ID, String(CHAT_ID), 'remote-id');

    expect(sendSticker).toHaveBeenCalledWith(CHAT_ID, {
      fileId: 'remote-id',
    } satisfies TdSendStickerInput);
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it('falls back to mtcute when TDLib cannot resolve the file id', async () => {
    const sendSticker = vi.fn(async () => {
      throw new Error('FILE_ID_INVALID');
    });
    const sendMedia = vi.fn(async () => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient, {
      sendSticker,
    });

    await service.sendSticker(USER_ID, ACCOUNT_ID, String(CHAT_ID), 'bot-api-id');

    expect(sendSticker).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty file id before touching Telegram', async () => {
    const sendMedia = vi.fn(async () => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient);

    await expect(
      service.sendSticker(USER_ID, ACCOUNT_ID, String(CHAT_ID), '   '),
    ).rejects.toMatchObject({ status: 400 });
    expect(sendMedia).not.toHaveBeenCalled();
  });
});

describe('sendVoice', () => {
  const buffer = Buffer.from([0x4f, 0x67, 0x67, 0x53]);

  it('sends OGG/Opus as a real voice note with its duration', async () => {
    const sendMedia = vi.fn(async () => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient);

    await service.sendVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      buffer,
      mimeType: 'audio/ogg',
      durationSec: 3.4,
    });

    expect(sendMedia).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        type: 'voice',
        file: buffer,
        fileMime: 'audio/ogg',
        duration: 3,
      }),
      {},
    );
  });

  it('sends non-OGG audio as an audio document and logs the downgrade', async () => {
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));

    const sendMedia = vi.fn(async (..._args: unknown[]) => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient);

    await service.sendVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      buffer,
      mimeType: 'audio/mpeg',
      durationSec: 7,
    });

    const media = sendMedia.mock.calls[0]?.[1] as { type: string };
    expect(media.type).toBe('audio');
    expect(media).toMatchObject({
      fileMime: 'audio/mpeg',
      fileName: 'voice.mp3',
      duration: 7,
    });

    const warning = logs.find(
      (entry) => entry.action === 'messaging.sendVoice.audio-document',
    );
    expect(warning).toMatchObject({
      level: 'warn',
      status: 'ok',
      chatId: CHAT_ID,
      details: { mimeType: 'audio/mpeg' },
    });
    expect(warning?.message).toContain('audio document');

    setLogSink(null);
  });

  it('rejects a non-audio MIME type instead of sending a photo', async () => {
    const sendMedia = vi.fn(async () => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient);

    await expect(
      service.sendVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
        buffer,
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it(`rejects payloads above ${MAX_MEDIA_BYTES} bytes before any engine call`, async () => {
    const sendMedia = vi.fn(async () => textMessage);
    const sendVoice = vi.fn(async () => textMessage as unknown as MessageView);
    const service = createService({ sendMedia } as unknown as TelegramClient, {
      sendVoice,
    });
    const oversized = {
      byteLength: MAX_MEDIA_BYTES + 1,
    } as unknown as Buffer;

    await expect(
      service.sendVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
        buffer: oversized,
        mimeType: 'audio/ogg',
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(sendVoice).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it('maps a TDLib voice note and skips mtcute', async () => {
    const sendVoice = vi.fn(
      async (..._args: unknown[]) => textMessage as unknown as MessageView,
    );
    const sendMedia = vi.fn(async () => textMessage);
    const service = createService({ sendMedia } as unknown as TelegramClient, {
      sendVoice,
    });

    await service.sendVoice(USER_ID, ACCOUNT_ID, String(CHAT_ID), {
      buffer,
      mimeType: 'audio/ogg',
      durationSec: 5,
      caption: 'hi',
      replyToId: 12,
    });

    expect(sendVoice).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({
        mimeType: 'audio/ogg',
        durationSec: 5,
        voiceNote: true,
        caption: 'hi',
        replyToId: 12,
      }),
    );
    // The input object is the TDLib transport shape, not the mtcute media DTO.
    const sent = sendVoice.mock.calls[0]?.[1] as TdSendVoiceInput;
    expect(sent.fileName).toBe('voice.ogg');
    expect(sendMedia).not.toHaveBeenCalled();
  });
});

describe('blockContact / unblockContact', () => {
  const blockedView: ContactBlockView = { userId: CONTACT_ID, blocked: true };

  it('blocks a user through mtcute after resolving the peer', async () => {
    const peer = { _: 'inputPeerUser', userId: CONTACT_ID, accessHash: 1n };
    const resolvePeer = vi.fn(async () => peer);
    const blockUser = vi.fn(async () => undefined);
    const service = createService({
      resolvePeer,
      blockUser,
    } as unknown as TelegramClient);

    const view = await service.blockContact(
      USER_ID,
      ACCOUNT_ID,
      String(CONTACT_ID),
      true,
    );

    expect(resolvePeer).toHaveBeenCalledWith(CONTACT_ID, true);
    expect(blockUser).toHaveBeenCalledWith(peer);
    expect(view).toEqual({ userId: CONTACT_ID, blocked: true });
  });

  it('unblocks a user through mtcute', async () => {
    const peer = { _: 'inputPeerUser', userId: CONTACT_ID, accessHash: 1n };
    const resolvePeer = vi.fn(async () => peer);
    const unblockUser = vi.fn(async () => undefined);
    const service = createService({
      resolvePeer,
      unblockUser,
    } as unknown as TelegramClient);

    const view = await service.unblockContact(
      USER_ID,
      ACCOUNT_ID,
      String(CONTACT_ID),
    );

    expect(unblockUser).toHaveBeenCalledWith(peer);
    expect(view).toEqual({ userId: CONTACT_ID, blocked: false });
  });

  it('prefers TDLib and reports the mapped block state', async () => {
    const setContactBlocked = vi.fn(async () => blockedView);
    const resolvePeer = vi.fn();
    const service = createService({ resolvePeer } as unknown as TelegramClient, {
      setContactBlocked,
    });

    const view = await service.blockContact(
      USER_ID,
      ACCOUNT_ID,
      String(CONTACT_ID),
      true,
    );

    expect(setContactBlocked).toHaveBeenCalledWith(CONTACT_ID, true);
    expect(resolvePeer).not.toHaveBeenCalled();
    expect(view).toEqual(blockedView);
  });

  it('rejects a non-positive user id before any engine call', async () => {
    const resolvePeer = vi.fn();
    const service = createService({ resolvePeer } as unknown as TelegramClient);

    await expect(
      service.blockContact(USER_ID, ACCOUNT_ID, '-5', true),
    ).rejects.toMatchObject({ status: 400 });
    expect(resolvePeer).not.toHaveBeenCalled();
  });
});
