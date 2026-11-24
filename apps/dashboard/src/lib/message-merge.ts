import type { MessageReasoningView, MessageView } from "./types";

/** Two copies of the same bubble may differ by a few seconds after a refetch. */
const SIGNATURE_TOLERANCE_MS = 5000;

export interface MergeResult {
  messages: MessageView[];
  /** Existing id -> canonical id, used to move reasoning to the surviving bubble. */
  remapped: Map<number, number>;
  /** Canonical id of the last incoming message, or null when the list was empty. */
  canonicalId: number | null;
}

function normalizedId(message: MessageView): number {
  const id = Number(message.id);
  return Number.isFinite(id) ? id : message.id;
}

function timestamp(message: MessageView): number {
  return Date.parse(message.date);
}

function isTemporary(message: MessageView): boolean {
  return (
    message.sendingState === "pending" || message.sendingState === "failed"
  );
}

function sameText(a: MessageView, b: MessageView): boolean {
  return a.text === b.text;
}

/**
 * Fallback identity for a bubble whose Telegram id changed (TDLib hands out a
 * temporary id when a send is not confirmed in time, then the real id arrives
 * via `message.new` or a history refetch). The signature deliberately includes
 * chat, direction, text, reply target, media kind and a ±5 s window, so two
 * genuinely different bubbles with the same short text are not collapsed
 * unless they are also adjacent in time and shape.
 */
export function isSameBubble(
  a: MessageView,
  b: MessageView,
  toleranceMs = SIGNATURE_TOLERANCE_MS,
): boolean {
  if (a.chatId !== b.chatId) return false;
  if (a.outgoing !== b.outgoing) return false;
  if (!sameText(a, b)) return false;
  if ((a.mediaType ?? null) !== (b.mediaType ?? null)) return false;
  if ((a.replyToId ?? null) !== (b.replyToId ?? null)) return false;
  const left = timestamp(a);
  const right = timestamp(b);
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= toleranceMs
  );
}

function newestFirst(a: MessageView, b: MessageView): number {
  const left = timestamp(a);
  const right = timestamp(b);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return right - left;
  }
  return normalizedId(b) - normalizedId(a);
}

/**
 * Pure merge of live bubbles and a fetched/history page.
 *
 * Rules:
 * 1. Numeric id wins. Ids are normalised with `Number`, so a string id from a
 *    serializer still matches the same number.
 * 2. Otherwise `isSameBubble` (outgoing + identical text + ±5 s + reply/media)
 *    recognises a temporary-id bubble and the real one that replaced it.
 * 3. When the ids differ, the non-temporary id survives. The existing bubble
 *    stays at its position (the list is re-sorted newest-first) and the caller
 *    moves local metadata (reasoning) from the old id to the canonical one.
 * 4. A message already carrying `reasoning` is never dropped: the merge result
 *    keeps one bubble per run, and `remapReasoning` moves its block.
 *
 * `preferIncoming` keeps the fetched copy's fields (for `message.new`), while
 * the default keeps the current live fields when both copies share an id.
 */
export function mergeMessages(
  current: MessageView[],
  incoming: MessageView | MessageView[],
  options: { preferIncoming?: boolean; toleranceMs?: number } = {},
): MergeResult {
  const tolerance = options.toleranceMs ?? SIGNATURE_TOLERANCE_MS;
  const next = [...current];
  const remapped = new Map<number, number>();
  let canonicalId: number | null = null;
  const incomingList = Array.isArray(incoming) ? incoming : [incoming];

  for (const item of incomingList) {
    const itemId = normalizedId(item);
    let index = next.findIndex((message) => normalizedId(message) === itemId);
    let bySignature = false;
    if (index < 0) {
      index = next.findIndex((message) =>
        isSameBubble(message, item, tolerance),
      );
      bySignature = index >= 0;
    }

    if (index < 0) {
      next.push(item);
      canonicalId = itemId;
      continue;
    }

    const existing = next[index];
    const existingId = normalizedId(existing);
    const existingTemporary = isTemporary(existing);
    const itemTemporary = isTemporary(item);

    // Keep the server id when only one side is still a temporary send.
    const canonical =
      existingTemporary && !itemTemporary
        ? item
        : !existingTemporary && itemTemporary
          ? existing
          : bySignature || options.preferIncoming || existingTemporary
            ? item
            : existing;

    // For a temp/real pair, take the non-temporary message's fields (the real
    // bubble has the final id, date and reply link); otherwise refreshing with
    // the live copy keeps reactions/edits that history may not have yet.
    const merged: MessageView =
      canonical === item
        ? { ...existing, ...item, id: canonical.id }
        : { ...item, ...existing, id: canonical.id };
    next[index] = merged;

    const canonicalNumeric = normalizedId(merged);
    if (existingId !== canonicalNumeric) {
      remapped.set(existingId, canonicalNumeric);
    }
    canonicalId = canonicalNumeric;
  }

  next.sort(newestFirst);
  return { messages: next, remapped, canonicalId };
}

/**
 * Moves reasoning entries from temporary ids to the canonical bubble id.
 * If both ids already have an entry, the canonical one wins and the stale
 * duplicate is removed, so one run never decorates two bubbles.
 */
export function remapReasoning(
  current: Map<number, MessageReasoningView>,
  remapped: Map<number, number>,
): Map<number, MessageReasoningView> {
  if (remapped.size === 0) return current;
  const next = new Map(current);
  for (const [from, rawTarget] of remapped) {
    const entry = next.get(from);
    if (!entry) continue;
    // A page may contain several id hops (temp -> temp -> real); follow them.
    let target = rawTarget;
    const seen = new Set<number>([from]);
    while (remapped.has(target) && !seen.has(target)) {
      seen.add(target);
      target = remapped.get(target) as number;
    }
    if (!next.has(target)) next.set(target, entry);
    next.delete(from);
  }
  return next;
}

/**
 * Adds reasoning while enforcing one bubble per run: a duplicate `ai.reply`
 * with another temporary id moves the block instead of copying it.
 */
export function putReasoning(
  current: Map<number, MessageReasoningView>,
  messageId: number,
  entry: MessageReasoningView,
): Map<number, MessageReasoningView> {
  const next = new Map(current);
  for (const [id, previous] of next) {
    if (id !== messageId && previous.runId === entry.runId) next.delete(id);
  }
  next.set(messageId, entry);
  return next;
}
