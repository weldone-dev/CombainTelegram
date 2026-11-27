import { ApiError } from "./api";
import { eveFetch } from "./eve-api";

/**
 * Client for the Eve context-snapshot contract (`/internal/eve/context/*`).
 *
 * A snapshot is exactly what the model saw on one turn: the system blocks
 * (instructions, persona, memory, …) and the ordered message list. Nest will
 * start filling these in phase 2; until then the dashboard treats a 404 as
 * "no snapshots yet" instead of an error.
 */

export type EveContextSnapshotKind =
  | "inbound"
  | "proactive"
  | "deletion"
  | "reaction"
  | "other";

export type EveContextRole = "system" | "user" | "assistant" | "tool";

export type EveContextMessageKind =
  | "memory"
  | "internal"
  | "incoming"
  | "history"
  | "tool";

export interface EveContextBlock {
  name: string;
  text: string;
  chars: number;
  tokens?: number;
}

export interface EveContextMessage {
  role: EveContextRole;
  kind?: EveContextMessageKind;
  text: string;
  chars: number;
  tokens?: number;
}

export interface EveContextTokens {
  system?: number;
  messages?: number;
  total?: number;
  input?: number;
  output?: number;
}

export interface EveContextSnapshot {
  id: string;
  personaId: string;
  accountId: string;
  /** Telegram ids exceed 2^53, so Nest should serialise this as a string. */
  chatId: string;
  threadId: number;
  /** ISO timestamp. */
  createdAt: string;
  model: string;
  kind: EveContextSnapshotKind;
  turnId?: string;
  tokens: EveContextTokens;
  system: EveContextBlock[];
  messages: EveContextMessage[];
  meta?: Record<string, unknown>;
  /** The turn ran in dry-run: nothing was sent to Telegram. */
  dryRun?: boolean;
}

export interface EveContextQuery {
  personaId?: string;
  accountId?: string;
  chatId?: string;
  limit?: number;
}

const SNAPSHOT_KINDS: readonly EveContextSnapshotKind[] = [
  "inbound",
  "proactive",
  "deletion",
  "reaction",
  "other",
];

const ROLES: readonly EveContextRole[] = [
  "system",
  "user",
  "assistant",
  "tool",
];

const MESSAGE_KINDS: readonly EveContextMessageKind[] = [
  "memory",
  "internal",
  "incoming",
  "history",
  "tool",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asTokenCount(value: unknown): number | undefined {
  const count = asFiniteNumber(value);
  return count !== undefined && count >= 0 ? count : undefined;
}

function normalizeChars(value: unknown, text: string): number {
  const chars = asFiniteNumber(value);
  return chars !== undefined && chars >= 0 ? chars : text.length;
}

function normalizeBlock(value: unknown, index: number): EveContextBlock | null {
  if (!isRecord(value)) return null;
  const text = asString(value.text);
  const name = asString(value.name).trim() || `block ${index + 1}`;
  return {
    name,
    text,
    chars: normalizeChars(value.chars, text),
    tokens: asTokenCount(value.tokens),
  };
}

function normalizeMessage(value: unknown): EveContextMessage | null {
  if (!isRecord(value)) return null;
  const role = asString(value.role);
  if (!ROLES.includes(role as EveContextRole)) return null;
  const kind = asString(value.kind);
  const text = asString(value.text);
  return {
    role: role as EveContextRole,
    kind: MESSAGE_KINDS.includes(kind as EveContextMessageKind)
      ? (kind as EveContextMessageKind)
      : undefined,
    text,
    chars: normalizeChars(value.chars, text),
    tokens: asTokenCount(value.tokens),
  };
}

function normalizeTokens(value: unknown): EveContextTokens {
  if (!isRecord(value)) return {};
  const tokens: EveContextTokens = {};
  for (const key of [
    "system",
    "messages",
    "total",
    "input",
    "output",
  ] as const) {
    const count = asTokenCount(value[key]);
    if (count !== undefined) tokens[key] = count;
  }
  return tokens;
}

/** Drops rows that cannot be rendered instead of failing the whole snapshot. */
export function normalizeContextSnapshot(
  value: unknown,
): EveContextSnapshot | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;

  const kind = asString(value.kind) as EveContextSnapshotKind;
  const system = Array.isArray(value.system)
    ? value.system
        .map((block, index) => normalizeBlock(block, index))
        .filter((block): block is EveContextBlock => block !== null)
    : [];
  const messages = Array.isArray(value.messages)
    ? value.messages
        .map((message) => normalizeMessage(message))
        .filter((message): message is EveContextMessage => message !== null)
    : [];

  const turnId = asString(value.turnId).trim();
  const threadId = asFiniteNumber(value.threadId);

  return {
    id,
    personaId: asString(value.personaId),
    accountId: asString(value.accountId),
    chatId:
      asString(value.chatId) || String(asFiniteNumber(value.chatId) ?? ""),
    threadId: threadId !== undefined ? Math.trunc(threadId) : 0,
    createdAt: asString(value.createdAt),
    model: asString(value.model),
    kind: SNAPSHOT_KINDS.includes(kind) ? kind : "other",
    turnId: turnId || undefined,
    tokens: normalizeTokens(value.tokens),
    system,
    messages,
    meta: isRecord(value.meta) ? value.meta : undefined,
    dryRun: value.dryRun === true,
  };
}

/** `GET /internal/eve/context/snapshots` — newest first, per the contract. */
export async function listContextSnapshots(
  query: EveContextQuery = {},
): Promise<EveContextSnapshot[]> {
  const params = new URLSearchParams();
  if (query.personaId) params.set("personaId", query.personaId);
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.chatId) params.set("chatId", query.chatId);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";

  const data = await eveFetch<unknown>(`context/snapshots${suffix}`);
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.items)
      ? data.items
      : [];

  return rows
    .map((row) => normalizeContextSnapshot(row))
    .filter((row): row is EveContextSnapshot => row !== null);
}

/** `GET /internal/eve/context/snapshots/:id` — one snapshot with full text. */
export async function getContextSnapshot(
  id: string,
): Promise<EveContextSnapshot> {
  const data = await eveFetch<unknown>(
    `context/snapshots/${encodeURIComponent(id)}`,
  );
  const snapshot = normalizeContextSnapshot(data);
  if (!snapshot) {
    throw new ApiError(502, {
      code: "EVE_CONTEXT_BAD_PAYLOAD",
      message: `Eve context snapshot ${id} has an unexpected shape`,
    });
  }
  return snapshot;
}
