import { Injectable } from '@nestjs/common';
import { MessagingService } from '../messaging/messaging.service.js';
import type {
  ContactBlockView,
  VoiceUploadInput,
} from '../messaging/messaging.service.js';
import type { MessageView } from '../messaging/message-view.js';

/**
 * Transport primitives the Eve channel needs, as thin wrappers over
 * {@link MessagingService}.
 *
 * Deliberately **not** registered in `EveModule` yet: importing this file is
 * side-effect free, and nothing is reachable from a controller until the
 * channel wiring lands. All ownership/session checks, engine routing and error
 * mapping stay in `MessagingService`.
 */
@Injectable()
export class EveMediaService {
  constructor(private readonly messaging: MessagingService) {}

  /** Send one sticker by its Telegram file id. */
  sendSticker(
    userId: string,
    accountId: string,
    chatId: string,
    fileId: string,
    sessionId?: string,
  ): Promise<MessageView> {
    return this.messaging.sendSticker(
      userId,
      accountId,
      chatId,
      fileId,
      sessionId,
    );
  }

  /**
   * Send a recorded voice message. OGG/Opus becomes a real voice note; other
   * audio types go out as an audio document (the service logs the downgrade).
   */
  sendVoice(
    userId: string,
    accountId: string,
    chatId: string,
    input: VoiceUploadInput,
  ): Promise<MessageView> {
    return this.messaging.sendVoice(userId, accountId, chatId, input);
  }

  /** Block one Telegram user. */
  blockContact(
    userId: string,
    accountId: string,
    contactUserId: string,
    sessionId?: string,
  ): Promise<ContactBlockView> {
    return this.messaging.blockContact(
      userId,
      accountId,
      contactUserId,
      true,
      sessionId,
    );
  }

  /** Unblock one Telegram user. */
  unblockContact(
    userId: string,
    accountId: string,
    contactUserId: string,
    sessionId?: string,
  ): Promise<ContactBlockView> {
    return this.messaging.unblockContact(
      userId,
      accountId,
      contactUserId,
      sessionId,
    );
  }
}
