import { describe, expect, it, vi } from 'vitest';
import type { MessagingService } from '../messaging/messaging.service.js';
import { EveMediaService } from './eve-media.service.js';

const USER_ID = 'local';
const ACCOUNT_ID = 'account-1';
const CHAT_ID = '1830539716';
const SESSION_ID = 'session-1';

function harness() {
  const messaging = {
    sendSticker: vi.fn(async () => ({ id: 1 })),
    sendVoice: vi.fn(async () => ({ id: 2 })),
    blockContact: vi.fn(async () => ({ userId: 777, blocked: true })),
    unblockContact: vi.fn(async () => ({ userId: 777, blocked: false })),
  };
  const service = new EveMediaService(messaging as unknown as MessagingService);
  return { service, messaging };
}

describe('EveMediaService', () => {
  it('forwards a sticker with its session id', async () => {
    const { service, messaging } = harness();

    await service.sendSticker(
      USER_ID,
      ACCOUNT_ID,
      CHAT_ID,
      'CAACAgIAAxkBAAI',
      SESSION_ID,
    );

    expect(messaging.sendSticker).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      CHAT_ID,
      'CAACAgIAAxkBAAI',
      SESSION_ID,
    );
  });

  it('forwards the voice payload unchanged', async () => {
    const { service, messaging } = harness();
    const input = {
      buffer: Buffer.from([1, 2, 3]),
      mimeType: 'audio/ogg',
      durationSec: 4,
      caption: 'hi',
    };

    await service.sendVoice(USER_ID, ACCOUNT_ID, CHAT_ID, input);

    expect(messaging.sendVoice).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      CHAT_ID,
      input,
    );
  });

  it('blocks with block=true and forwards the session id', async () => {
    const { service, messaging } = harness();

    await service.blockContact(USER_ID, ACCOUNT_ID, '777', SESSION_ID);

    expect(messaging.blockContact).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      '777',
      true,
      SESSION_ID,
    );
  });

  it('unblocks through the dedicated MessagingService method', async () => {
    const { service, messaging } = harness();

    await service.unblockContact(USER_ID, ACCOUNT_ID, '777');

    expect(messaging.unblockContact).toHaveBeenCalledWith(
      USER_ID,
      ACCOUNT_ID,
      '777',
      undefined,
    );
  });
});
