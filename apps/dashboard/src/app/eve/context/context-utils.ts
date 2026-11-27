import type {
  EveContextBlock,
  EveContextMessage,
  EveContextMessageKind,
  EveContextSnapshot,
} from "../../../lib/eve-context";

export const SNAPSHOT_KIND_LABELS: Record<EveContextSnapshot["kind"], string> =
  {
    inbound: "входящее",
    proactive: "проактивное",
    deletion: "удаление",
    reaction: "реакция",
    other: "другое",
  };

export function snapshotKindTone(
  kind: EveContextSnapshot["kind"],
): "zinc" | "sky" | "green" | "amber" | "red" {
  switch (kind) {
    case "inbound":
      return "sky";
    case "proactive":
      return "amber";
    case "deletion":
      return "red";
    case "reaction":
      return "green";
    default:
      return "zinc";
  }
}

export const ROLE_LABELS: Record<EveContextMessage["role"], string> = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
};

export const MESSAGE_KIND_LABELS: Record<EveContextMessageKind, string> = {
  memory: "memory",
  internal: "internal",
  incoming: "incoming",
  history: "history",
  tool: "tool",
};

export type MessageFilter = "all" | "memory" | "internal" | "incoming";

export type EffectiveKind = EveContextMessageKind | "plain";

/** `[internal: …]` markers are rendered distinctly even without `kind`. */
export function isInternalText(text: string): boolean {
  return /^\s*\[internal[\s:]/i.test(text);
}

export function effectiveKind(message: EveContextMessage): EffectiveKind {
  if (message.kind) return message.kind;
  if (isInternalText(message.text)) return "internal";
  if (message.role === "tool") return "tool";
  if (message.role === "user") return "incoming";
  return "plain";
}

export function matchesFilter(
  message: EveContextMessage,
  filter: MessageFilter,
): boolean {
  if (filter === "all") return true;
  const kind = effectiveKind(message);
  if (filter === "incoming") return kind === "incoming";
  return kind === filter;
}

export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("ru-RU");
}

/** Backends that do not report tokens get a clearly marked 4-chars/token guess. */
export function tokenLabel(tokens: number | undefined, chars: number): string {
  if (tokens !== undefined && Number.isFinite(tokens)) {
    return `${formatCount(tokens)} tok`;
  }
  if (chars <= 0) return "0 tok";
  return `≈${formatCount(Math.ceil(chars / 4))} tok`;
}

export function sizeLabel(chars: number, tokens: number | undefined): string {
  return `${formatCount(chars)} сим · ${tokenLabel(tokens, chars)}`;
}

export function snapshotSize(snapshot: EveContextSnapshot): {
  chars: number;
  systemChars: number;
  messageChars: number;
} {
  const systemChars = snapshot.system.reduce(
    (total, block) => total + block.chars,
    0,
  );
  const messageChars = snapshot.messages.reduce(
    (total, message) => total + message.chars,
    0,
  );
  return { chars: systemChars + messageChars, systemChars, messageChars };
}

export function formatSnapshotTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "—";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function excerpt(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** First incoming message of the turn, for the list preview. */
export function incomingPreview(
  snapshot: EveContextSnapshot,
  max = 60,
): string {
  const incoming = snapshot.messages.find(
    (message) => effectiveKind(message) === "incoming",
  );
  return excerpt(incoming?.text ?? "", max);
}

export function previewText(snapshot: EveContextSnapshot, max = 60): string {
  const preview = incomingPreview(snapshot, max);
  if (preview) return preview;
  // Proactive/reaction turns have no incoming message: show the first item that
  // was actually sent, rather than a synthetic internal prompt at the end.
  const first = snapshot.messages[0];
  if (first) return excerpt(first.text, max);
  return excerpt(snapshot.system[0]?.text ?? "", max) || "пустой turn";
}

export interface BlockIssue {
  index: number;
  reasons: string[];
}

/**
 * Flags blocks that usually mean a prompt-assembly bug: empty text, the same
 * block name twice (instructions duplicated) or byte-identical content.
 */
export function analyzeBlocks(blocks: EveContextBlock[]): BlockIssue[] {
  const nameCounts = new Map<string, number>();
  const textCounts = new Map<string, number>();
  for (const block of blocks) {
    nameCounts.set(block.name, (nameCounts.get(block.name) ?? 0) + 1);
    const text = block.text.trim();
    if (text) textCounts.set(text, (textCounts.get(text) ?? 0) + 1);
  }

  const issues: BlockIssue[] = [];
  blocks.forEach((block, index) => {
    const reasons: string[] = [];
    if (!block.text.trim()) reasons.push("пустой блок");
    if ((nameCounts.get(block.name) ?? 0) > 1) reasons.push("дубль имени");
    const text = block.text.trim();
    if (text && (textCounts.get(text) ?? 0) > 1) reasons.push("дубль текста");
    if (reasons.length > 0) issues.push({ index, reasons });
  });
  return issues;
}

/** Highlights every case-insensitive occurrence of `query` in `text`. */
export function splitHighlight(
  text: string,
  query: string,
): Array<{ text: string; match: boolean }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (found > cursor) {
      parts.push({ text: text.slice(cursor, found), match: false });
    }
    parts.push({ text: text.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }
  return parts;
}
