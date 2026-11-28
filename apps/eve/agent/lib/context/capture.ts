import { stripInternalLines } from '../model/hygiene';

/**
 * Real model context capture.
 *
 * The dashboard must show what the model *actually* received, not a
 * reconstruction assembled from the same inputs. Eve publishes the final AI SDK
 * model input (`instructions` + `messages`) through an instrumentation
 * provider before every provider call; an `agent/instrumentation/context.ts`
 * handler stores the first call of a turn, and the `turn.settled` hook posts
 * it to Nest.
 *
 * Everything here is best-effort: a missing capture, a Nest restart or a slow
 * request must never fail a turn. The snapshot is a side channel.
 */

export type EveContextKind =
  | 'inbound'
  | 'proactive'
  | 'deletion'
  | 'reaction'
  | 'other';

export interface EveContextBlock {
  name: string;
  text: string;
}

export interface EveContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  kind?: 'memory' | 'internal' | 'incoming' | 'history' | 'tool';
  text: string;
}

export interface ModelUsage {
  input?: number;
  output?: number;
}

/** What the instrumentation provider saw for one model run of a turn. */
export interface TurnCapture {
  sessionId: string;
  turnId: string;
  model: string;
  provider?: string;
  instructions: unknown;
  messages: readonly unknown[];
  usage?: ModelUsage;
  finishReason?: string;
  statementId?: string;
  startedAt: number;
}

export interface SnapshotAddress {
  personaId: string;
  accountId: string;
  chatId: string;
  threadId: number;
}

export interface SnapshotPayload {
  personaId: string;
  accountId: string;
  chatId: string;
  threadId: number;
  kind: EveContextKind;
  model: string;
  turnId: string;
  tokens: {
    system?: number;
    messages?: number;
    total?: number;
    input?: number;
    output?: number;
  };
  system: EveContextBlock[];
  messages: EveContextMessage[];
  meta: Record<string, unknown>;
  /** This turn was a dry run: its outbound actions never reached Telegram. */
  dryRun?: boolean;
}

/** A turn that never settles must not leak memory in a long-lived process. */
const CAPTURE_TTL_MS = 10 * 60_000;
const MAX_CAPTURES = 200;

/**
 * Instrumentation and hooks are compiled into separate bundles, so a plain
 * module-level Map is two different Maps at runtime. `globalThis` with a
 * registered symbol is shared by both bundles and by every turn in the process.
 */
const STORE_KEY = Symbol.for('combain.eve.context.captures');

function captureStore(): Map<string, TurnCapture> {
  const global = globalThis as unknown as Record<symbol, unknown>;
  const existing = global[STORE_KEY];
  if (existing instanceof Map) return existing as Map<string, TurnCapture>;
  const created = new Map<string, TurnCapture>();
  global[STORE_KEY] = created;
  return created;
}

function captureKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function prune(now = Date.now()): void {
  const captures = captureStore();
  for (const [key, capture] of captures) {
    if (now - capture.startedAt > CAPTURE_TTL_MS) captures.delete(key);
  }
  while (captures.size > MAX_CAPTURES) {
    const oldest = captures.keys().next().value;
    if (!oldest) break;
    captures.delete(oldest);
  }
}

/** Test hook: the capture store is process-wide. */
export function resetContextCapture(): void {
  captureStore().clear();
}

export function captureCount(): number {
  return captureStore().size;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/** Shape of `eve/instrumentation`'s `model.call.started` we rely on. */
export interface ModelCallStartedEvent {
  model?: { modelId?: unknown; provider?: unknown };
  input?: {
    instructions?: unknown;
    messages?: unknown;
    tools?: unknown;
  };
  scope?: { sessionId?: unknown; turnId?: unknown; runId?: unknown };
  runtimeContext?: Record<string, unknown>;
}

export interface ModelCallSettledEvent {
  outcome?: unknown;
  finishReason?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown };
  scope?: { sessionId?: unknown; turnId?: unknown; runId?: unknown };
  runtimeContext?: Record<string, unknown>;
}

function scopeOf(event: {
  scope?: { sessionId?: unknown; turnId?: unknown };
}): { sessionId: string; turnId: string } | null {
  const sessionId = textOf(event.scope?.sessionId);
  const turnId = textOf(event.scope?.turnId);
  if (!sessionId || !turnId) return null;
  return { sessionId, turnId };
}

/**
 * Stores the first model call of a turn. A tool loop makes several calls; the
 * first one is the honest "context of the answer" (system, history, memory,
 * incoming), the later ones only add tool results.
 */
export function recordModelCallStarted(event: ModelCallStartedEvent): void {
  // Compaction runs its own model call inside a turn; it is not the persona
  // answer and must not replace it.
  if (event.runtimeContext?.['eve.compaction.request'] !== undefined) return;
  const scope = scopeOf(event);
  if (!scope) return;
  prune();
  const captures = captureStore();
  const key = captureKey(scope.sessionId, scope.turnId);
  if (captures.has(key)) return;
  const modelId = textOf(event.model?.modelId) || 'unknown';
  // AI SDK reports `combain.chat`; the configured provider is `combain`.
  const provider = textOf(event.model?.provider).replace(/\.chat$/, '');
  captures.set(key, {
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    model: provider ? `${provider}/${modelId}` : modelId,
    ...(provider ? { provider } : {}),
    instructions: event.input?.instructions,
    messages: Array.isArray(event.input?.messages)
      ? (event.input?.messages as readonly unknown[])
      : [],
    startedAt: Date.now(),
  });
}

/** Usage of the successful attempt of the turn's first model call. */
export function recordModelCallSettled(event: ModelCallSettledEvent): void {
  if (event.outcome !== 'completed') return;
  const scope = scopeOf(event);
  if (!scope) return;
  const capture = captureStore().get(
    captureKey(scope.sessionId, scope.turnId),
  );
  if (!capture) return;
  const input = numberOrUndefined(event.usage?.inputTokens);
  const output = numberOrUndefined(event.usage?.outputTokens);
  if (input !== undefined || output !== undefined) {
    capture.usage = {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }
  const finishReason = textOf(event.finishReason);
  if (finishReason) capture.finishReason = finishReason;
}

/** Reads and removes the capture for one settled turn. */
export function takeTurnCapture(
  sessionId: string,
  turnId: string,
): TurnCapture | null {
  const key = captureKey(sessionId, turnId);
  const captures = captureStore();
  const capture = captures.get(key);
  if (!capture) return null;
  captures.delete(key);
  return capture;
}

/* ------------------------------------------------------------------ */
/* Normalization: final model input → dashboard contract               */
/* ------------------------------------------------------------------ */

const CYRILLIC = /[\u0400-\u04FF]/g;

/**
 * Character-based token estimate.
 *
 * `chars / 4` is tuned for English and underestimates Russian by almost half:
 * Cyrillic usually takes ~2.2 characters per token. Classify by the actual
 * Cyrillic share of the text instead of guessing from the locale.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cyrillic = text.match(CYRILLIC)?.length ?? 0;
  const other = Math.max(0, text.length - cyrillic);
  return Math.ceil(cyrillic / 2.2 + other / 4);
}

/**
 * Splits the system prompt on markdown headings, preserving the exact text.
 * This is a partition, not a rewrite: concatenating the blocks (with the blank
 * lines between them) gives back what the model received.
 */
export function systemBlocksOf(instructions: unknown): EveContextBlock[] {
  const parts: string[] = [];
  const pushEntry = (entry: unknown): void => {
    if (typeof entry === 'string') {
      parts.push(entry);
      return;
    }
    const row = recordOf(entry);
    if (row.content !== undefined) {
      const text = contentTextOf(row.content);
      if (text) parts.push(text);
    }
  };
  if (Array.isArray(instructions)) {
    for (const entry of instructions) pushEntry(entry);
  } else {
    pushEntry(instructions);
  }
  const value = parts.join('\n\n').trim();
  if (!value) return [];
  const blocks: EveContextBlock[] = [];
  let name = 'system';
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text) blocks.push({ name, text });
    buffer = [];
  };
  for (const line of value.split('\n')) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      name = textOf(heading[1]).trim() || 'system';
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

function clipJson(value: unknown, max = 800): string {
  try {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    if (!json) return '';
    return json.length > max ? `${json.slice(0, max)}…` : json;
  } catch {
    return '';
  }
}

function outputText(value: unknown): string {
  const row = recordOf(value);
  if (typeof row.value === 'string') return row.value;
  if (typeof row.text === 'string') return row.text;
  return clipJson(value);
}

/** Flattens AI SDK message content parts to the text the model saw. */
export function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    const row = recordOf(part);
    const type = textOf(row.type);
    if (type === 'text' && typeof row.text === 'string') {
      parts.push(row.text);
    } else if (type === 'image') {
      parts.push('[image]');
    } else if (type === 'file') {
      parts.push(`[file: ${textOf(row.mediaType) || 'file'}]`);
    } else if (type === 'tool-call') {
      parts.push(
        `[tool-call ${textOf(row.toolName)} ${clipJson(row.input)}]`.trim(),
      );
    } else if (type === 'tool-result') {
      parts.push(
        `[tool-result ${textOf(row.toolName)} ${outputText(row.output)}]`.trim(),
      );
    } else if (type === 'reasoning') {
      // Reasoning is internal model output, never conversation. It must not
      // appear in the assistant history of the snapshot: the model should see
      // only the final bubbles it really sent.
      continue;
    }
  }
  return parts.join('\n');
}

const INTERNAL_LINE = /^\s*\[internal:/;

/**
 * Splits the last user message into `[internal: ...]` blocks (behavior frame,
 * media/quotation hints) and the actual incoming series. The text itself is
 * preserved; only the boundary between the two kinds is added.
 */
export function splitIncoming(
  text: string,
): Array<{ kind: 'internal' | 'incoming'; text: string }> {
  const chunks: Array<{ internal: boolean; lines: string[] }> = [];
  for (const line of text.split('\n')) {
    const internal = INTERNAL_LINE.test(line);
    const last = chunks[chunks.length - 1];
    if (last && last.internal === internal) last.lines.push(line);
    else chunks.push({ internal, lines: [line] });
  }
  return chunks
    .map((chunk) => ({
      kind: chunk.internal ? ('internal' as const) : ('incoming' as const),
      text: chunk.lines.join('\n').trim(),
    }))
    .filter((chunk) => chunk.text.length > 0);
}

const MEMORY_SNAPSHOT = /^stage=.*interest=.*trust=/;

function messageKindOf(
  row: Record<string, unknown>,
  text: string,
): 'memory' | 'internal' | 'history' | 'tool' | undefined {
  const kind = textOf(row.kind);
  if (kind === 'memory.load') return 'memory';
  if (MEMORY_SNAPSHOT.test(text)) return 'memory';
  if (
    kind === 'context.instruction' ||
    kind === 'execution.continuation' ||
    kind === 'execution.retry'
  ) {
    return 'internal';
  }
  if (kind === 'task.result') return 'tool';
  if (row.content && Array.isArray(row.content)) {
    const parts = row.content as Array<Record<string, unknown>>;
    if (parts.some((part) => textOf(part.type) === 'tool-result')) return 'tool';
  }
  return row.role === 'assistant' ? 'history' : undefined;
}

function isFrameworkUserMessage(row: Record<string, unknown>): boolean {
  const kind = textOf(row.kind);
  return Boolean(kind) && kind !== 'user';
}

/**
 * Last plain user message is this turn's incoming text; earlier user messages
 * are conversation history. `inbound` turns also split the internal frame out
 * of that message.
 */
function incomingIndex(
  messages: readonly unknown[],
  turnKind: EveContextKind,
): number {
  let index = -1;
  for (const [position, message] of messages.entries()) {
    const row = recordOf(message);
    if (row.role !== 'user') continue;
    if (isFrameworkUserMessage(row)) continue;
    index = position;
  }
  return index;
}

export function messageEntriesOf(
  messages: readonly unknown[],
  turnKind: EveContextKind,
): EveContextMessage[] {
  const incoming = incomingIndex(messages, turnKind);
  const entries: EveContextMessage[] = [];
  for (const [position, message] of messages.entries()) {
    const row = recordOf(message);
    const role = textOf(row.role);
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') {
      continue;
    }
    const rawText = contentTextOf(row.content).trim();
    if (!rawText) continue;
    // Old sessions still carry frames glued to his messages. They are not
    // history: the model gets them from the dynamic system block.
    const text = role === 'user' ? stripInternalLines(rawText) : rawText;
    if (!text) continue;
    if (role === 'system') {
      entries.push({ role: 'system', text });
      continue;
    }
    const kind = messageKindOf(row, text);
    if (role === 'tool') {
      entries.push({ role: 'tool', kind: 'tool', text });
      continue;
    }
    if (position === incoming && !kind) {
      if (turnKind === 'inbound') {
        for (const chunk of splitIncoming(rawText)) {
          entries.push({ role: 'user', kind: chunk.kind, text: chunk.text });
        }
      } else {
        // Proactive/reaction/deletion prompts are instructions to herself, not
        // a message from him; they belong to the internal frame.
        entries.push({ role: 'user', kind: 'internal', text });
      }
      continue;
    }
    if (position === incoming && kind === 'memory') {
      entries.push({ role: 'user', kind: 'memory', text });
      continue;
    }
    entries.push({
      role: role as 'user' | 'assistant',
      kind: kind ?? 'history',
      text,
    });
  }
  return entries;
}

export function normalizeKind(raw: unknown): EveContextKind {
  const value = textOf(raw);
  if (value === 'deferred') return 'inbound';
  if (
    value === 'inbound' ||
    value === 'proactive' ||
    value === 'deletion' ||
    value === 'reaction'
  ) {
    return value;
  }
  return 'other';
}

/** Builds the snapshot body the Nest endpoint expects. */
export function buildSnapshotPayload(
  capture: TurnCapture,
  address: SnapshotAddress,
  kind: EveContextKind,
  dryRun = false,
): SnapshotPayload {
  const system = systemBlocksOf(capture.instructions);
  const messages = messageEntriesOf(capture.messages, kind);
  // The provider's usage is the only honest `input`/`output`. The split into
  // `system` and `messages` is a character estimate (Cyrillic-aware), so it is
  // always marked as such in `meta` and never subtracts system from input.
  const systemTokens = estimateTokens(system.map((block) => block.text).join('\n\n'));
  const messagesTokens = estimateTokens(
    messages.map((message) => message.text).join('\n'),
  );
  const input = capture.usage?.input;
  const output = capture.usage?.output;
  const inputTokens = input ?? systemTokens + messagesTokens;
  const tokens = {
    system: systemTokens,
    messages: messagesTokens,
    // `total` is the real prompt, not prompt + answer: usage.input already
    // includes the whole context and is what the dashboard compares.
    total: inputTokens,
    input: inputTokens,
    ...(output !== undefined ? { output } : {}),
  };
  return {
    personaId: address.personaId,
    accountId: address.accountId,
    chatId: address.chatId,
    threadId: address.threadId,
    kind,
    model: capture.model,
    // Session id keeps a retried turn distinct after an Eve session reset, when
    // turn ids restart at `turn_0`.
    turnId: `${capture.sessionId}:${capture.turnId}`,
    tokens,
    system,
    messages,
    meta: {
      sessionId: capture.sessionId,
      eveTurnId: capture.turnId,
      ...(capture.provider ? { modelProvider: capture.provider } : {}),
      ...(capture.finishReason ? { finishReason: capture.finishReason } : {}),
      estimated: true,
      estimator: 'chars',
      messageCount: messages.length,
      systemBlockCount: system.length,
    },
    ...(dryRun ? { dryRun: true } : {}),
  };
}

function nestBase(): string {
  return (process.env.EVE_NEST_URL ?? 'http://127.0.0.1:4001').replace(
    /\/+$/,
    '',
  );
}

/** Best-effort POST; never throws, never logs the payload (it may be private). */
export async function postSnapshot(
  payload: SnapshotPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      `${nestBase()}/internal/eve/context/snapshot`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-token': process.env.EVE_TOKEN ?? '',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      console.warn(
        `[context] Nest snapshot failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[context] Nest snapshot failed: ${(error as Error).message}`);
    return false;
  }
}
