import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { SpeechService } from './speech.service.js';

/**
 * Local speech-to-text for voice notes.
 *
 * Kept in its own module because two siblings need the same recognizer
 * instance: `AiModule` (the autopilot reads incoming voice messages) and
 * `MessagingModule` (the transcription endpoint falls back to it when
 * Telegram answers `PREMIUM_REQUIRED`). `MessagingModule` is imported by
 * `AiModule`, so importing `AiModule` back would close a cycle; a module that
 * only provides `SpeechService` lets both depend on it without one.
 *
 * `TelegramModule` supplies `SessionCryptoService` for the sealed STT key in
 * `AiSetting.sttApiKey`; it imports nothing, so this stays acyclic.
 */
@Module({
  imports: [TelegramModule],
  providers: [SpeechService],
  exports: [SpeechService],
})
export class SpeechModule {}
