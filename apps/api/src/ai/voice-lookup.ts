/**
 * Pure helpers for following a text question back to the voice note it asks
 * about. Kept free of Nest DI so the rules are easy to read and test.
 */
import type { MessageMediaView } from '../messaging/message-view.js';

/**
 * Whether the media is audio the speech engine can listen to: a voice note or
 * an audio file sent as a document.
 */
export function isAudioMedia(
  media: MessageMediaView | null | undefined,
): boolean {
  if (!media || !media.downloadable) return false;
  if (media.kind === 'voice') return true;
  return (
    media.kind === 'document' &&
    (media.mimeType ?? '').toLowerCase().startsWith('audio/')
  );
}

/**
 * Words that mean the peer is talking about a voice/audio message. Matching is
 * a case-insensitive substring test, so the list holds stems: "прослуш" covers
 * "прослушай" and "прослушал", "скажи" covers "скажи-ка".
 *
 * A match alone is not enough: the caller only treats it as a voice reference
 * when an audio message really exists nearby (see {@link pickRecentAudio}), so
 * "скинул файл" is not hijacked by the verb.
 */
export const VOICE_WORDS = [
  'голосов',
  'голосом',
  'аудио',
  'прослуш',
  'послуша',
  'сказал',
  'скажи',
  'скинул',
  'записал',
  'voice',
  'audio',
];

/** Whether one text mentions audio, ignoring case and language. */
export function mentionsVoiceText(text: string): boolean {
  const lower = text.toLowerCase();
  return VOICE_WORDS.some((word) => lower.includes(word));
}

/** Minimal shape of a burst item for detection. */
export interface VoiceHintLike {
  text: string;
  media?: MessageMediaView | null;
}

/**
 * Whether any incoming text refers to a voice/audio note. Audio items
 * themselves are excluded: their placeholder text would always match.
 */
export function mentionsVoice(texts: readonly VoiceHintLike[]): boolean {
  return texts.some(
    (item) => !isAudioMedia(item.media) && mentionsVoiceText(item.text),
  );
}

/** Minimal shape of a history message for {@link pickRecentAudio}. */
export interface AudioCandidateLike {
  media: MessageMediaView | null;
  date: string;
}

/**
 * Newest audio message no older than `maxAgeMs`, or `null` when the window has
 * no usable audio. Order of `messages` does not matter; an unparsable date is
 * skipped instead of failing the whole lookup.
 */
export function pickRecentAudio<T extends AudioCandidateLike>(
  messages: readonly T[],
  now: number,
  maxAgeMs: number,
): T | null {
  let best: T | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const candidate of messages) {
    if (!isAudioMedia(candidate.media)) continue;
    if (!isRecentDate(candidate.date, now, maxAgeMs)) continue;
    const at = new Date(candidate.date).getTime();
    if (at > bestAt) {
      best = candidate;
      bestAt = at;
    }
  }
  return best;
}

/** Whether an ISO date is no older than `maxAgeMs` relative to `now`. */
export function isRecentDate(
  date: string,
  now: number,
  maxAgeMs: number,
): boolean {
  const at = new Date(date).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at <= maxAgeMs;
}

/**
 * Message id a follow-up is replying to, newest burst item first. A reply is
 * the strongest pointer to the audio the peer means.
 */
export function replyTargetId(
  texts: readonly { replyToId?: number | null }[],
): number | null {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const id = texts[index]?.replyToId;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
      return id;
    }
  }
  return null;
}
