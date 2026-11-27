import { Module } from '@nestjs/common';
import { SpeechService } from './speech.service.js';

/**
 * Speech-to-text for voice notes.
 *
 * Kept in its own module so the voice-note pipeline and the messaging
 * transcription endpoint share one recognizer instance without pulling in the
 * rest of the messaging layer. Everything comes from the `STT_*` environment;
 * the module imports nothing, so it stays acyclic.
 */
@Module({
  providers: [SpeechService],
  exports: [SpeechService],
})
export class SpeechModule {}
