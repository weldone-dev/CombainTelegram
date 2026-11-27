/**
 * Deleted-message awareness.
 *
 * The reference distinguishes three cases: she already read the text, she saw
 * that something arrived but did not read it, or she missed it entirely. Only
 * the first two deserve a short in-character comment; the third stays silent.
 * Classification is pure so the channel only has to supply timestamps.
 */

export type DeletionAwareness = 'saw-and-read' | 'saw-not-read' | 'missed';

export interface DeletionInput {
  /** Epoch ms when the deleted message arrived, if known. */
  receivedAt?: number;
  /** Epoch ms of her latest outgoing message. */
  lastHerMessageAt?: number;
  /** Epoch ms, defaults to `Date.now()`. */
  now?: number;
  /** She is in the middle of an exchange right now. */
  activeDialog?: boolean;
}

/** Missed > 30 minutes ago without a dialog is not worth a comment. */
export const DELETION_MISSED_AFTER_MS = 30 * 60_000;

export function classifyDeletion(input: DeletionInput): DeletionAwareness {
  const now = input.now ?? Date.now();
  const age =
    typeof input.receivedAt === 'number' && Number.isFinite(input.receivedAt)
      ? now - input.receivedAt
      : Number.POSITIVE_INFINITY;

  if (
    age > DELETION_MISSED_AFTER_MS &&
    input.activeDialog !== true
  ) {
    return 'missed';
  }
  if (
    typeof input.lastHerMessageAt === 'number' &&
    typeof input.receivedAt === 'number' &&
    input.lastHerMessageAt > input.receivedAt
  ) {
    return 'saw-and-read';
  }
  return 'saw-not-read';
}

/**
 * Turn prefix for a deletion event. The wording is the instruction, not a
 * canned reply: the model writes the comment in her own voice.
 */
export function deletionPromptFragment(
  awareness: DeletionAwareness,
  deletedText?: string,
): string {
  if (awareness === 'missed') return '';
  const quote = deletedText?.trim()
    ? ` Текст был: «${deletedText.trim().slice(0, 200)}».`
    : '';
  if (awareness === 'saw-and-read') {
    return `[internal: он удалил сообщение, которое ты уже успела прочитать.${quote} Можешь коротко и живо отреагировать («ты куда удалил», «поздно, я прочитала», «и что это было») или промолчать, если сейчас холодно. Без объяснений механики.]`;
  }
  return `[internal: он удалил сообщение почти сразу, ты видела, что что-то пришло, но не прочитала.${quote} Можно удивиться или подколоть («куда удалил», «покажи что писал»), но без театра. На холодной стадии лучше промолчать.]`;
}
