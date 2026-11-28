import { ApiError, errorMessage } from "./api";
import type { ApiErrorBody } from "./types";

/**
 * Dashboard client for the internal Eve contract (`/internal/eve/*`).
 *
 * The browser never knows `EVE_TOKEN`: every request goes through the
 * same-origin Next.js route handler in `app/api/eve/[...path]/route.ts`, which
 * adds the header on the server.
 */

const EVE_PROXY = "/api/eve";

export interface EvePersonaAccountView {
  id: string;
  personaId: string;
  accountId: string;
  /** `shared` = one relationship per persona+peer, `isolated` = per chat. */
  relationshipMode: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EvePersonaDocView {
  id: string;
  personaId: string;
  kind: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Documents edited on the persona page (girl-agent file set). */
export type EvePersonaDocKind =
  | "persona"
  | "speech"
  | "boundaries"
  | "communication";

export interface EvePersonaDocMeta {
  kind: EvePersonaDocKind;
  label: string;
  hint: string;
}

export const EVE_PERSONA_DOC_KINDS: readonly EvePersonaDocMeta[] = [
  {
    kind: "persona",
    label: "persona",
    hint: "Кто она: бэкграунд, характер, триггеры, вкусы, комплексы.",
  },
  {
    kind: "speech",
    label: "speech",
    hint: "Как звучит: длина сообщений, пунктуация, сленг, запрещённые слова.",
  },
  {
    kind: "boundaries",
    label: "boundaries",
    hint: "Границы: закрытые темы, red flags, обиды и игнор.",
  },
  {
    kind: "communication",
    label: "communication",
    hint: "Предпочтения в переписке: когда пишет, ритм, темы, реакции.",
  },
];

export interface EvePersonaView {
  id: string;
  name: string;
  age: number;
  nationality: string;
  timezone: string;
  stage: string;
  mode: string;
  sleepFrom: number;
  sleepTo: number;
  nightWakeChance: number;
  ignoreTendency: number;
  /** JSON object serialised as a string by Nest. */
  communication: string;
  vibe: string | null;
  createdAt: string;
  updatedAt: string;
  accounts?: EvePersonaAccountView[];
  docs?: EvePersonaDocView[];
}

export interface EvePersonaInput {
  name: string;
  age: number;
  nationality: string;
  timezone: string;
  stage: string;
  mode: string;
  sleepFrom: number;
  sleepTo: number;
  nightWakeChance: number;
  ignoreTendency: number;
  communication: Record<string, unknown>;
  vibe: string;
}

export interface EveBindAccountInput {
  accountId: string;
  relationshipMode: "shared" | "isolated";
}

export interface EveChatBindingView {
  id: string;
  personaId: string;
  accountId: string;
  /** Prisma `BigInt` may arrive as a string or a number. */
  chatId: number | string;
  threadId: number;
  allowed: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EveChatBindingInput {
  accountId: string;
  chatId: number | string;
  threadId: number;
  allowed: boolean;
  note?: string;
}

export interface EveRelationshipView {
  id: string;
  personaId: string;
  scopeKey: string;
  stage: string;
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringe: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface EveConflictView {
  id: string;
  relationshipId: string;
  level: number;
  coldUntil: string | null;
  reason: string | null;
  /** JSON array stored as a string. */
  history: string;
  createdAt: string;
  updatedAt: string;
}

export type EveTimelineScoreKey =
  | "interest"
  | "trust"
  | "attraction"
  | "annoyance"
  | "cringe";

export type EveTimelineScores = Record<EveTimelineScoreKey, number>;

/** One row of the chat «Хроника»: a message, an ignore or a mood change. */
export type EveTimelineEntryView =
  | {
      id: string;
      at: string;
      kind: "incoming";
      text: string;
      messageId?: number;
    }
  | {
      id: string;
      at: string;
      kind: "reply";
      text: string;
      dryRun?: boolean;
    }
  | { id: string; at: string; kind: "ignored"; reason?: string }
  | {
      id: string;
      at: string;
      kind: "relationship";
      source: "inbound" | "proactive" | "reaction" | "ignore" | string;
      delta: Partial<EveTimelineScores>;
      before: EveTimelineScores;
      after: EveTimelineScores;
      stageFrom?: string;
      stageTo?: string;
      conflictFrom?: number;
      conflictTo?: number;
    };

export interface EveTimelineView {
  /** Newest first. */
  entries: EveTimelineEntryView[];
  /** Cursor for the next (older) page; `null` ends the feed. */
  nextBefore: string | null;
}

/** Read-only memory rows rendered on the persona page. */
export interface EveMemoryDailyView {
  id: string;
  personaId: string;
  date: string;
  markdown: string;
  json: string;
  complete: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EveMemoryFactView {
  id: string;
  personaId: string;
  relationshipId: string | null;
  kind: string;
  content: string;
  importance: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvePalaceDrawerView {
  id: string;
  personaId: string;
  drawerId: string;
  wing: string;
  hall: string;
  room: string;
  content: string;
  keywords: string;
  salience: number;
  source: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

export interface EveAgendaItemView {
  id: string;
  personaId: string;
  accountId: string;
  chatId: number | string;
  about: string;
  reason: string;
  kind: string;
  state: string;
  importance: number;
  pingAt: string;
  attempts: number;
  history: string;
  createdAt: string;
  updatedAt: string;
}

export interface EveSessionLogView {
  id: string;
  personaId: string;
  accountId: string;
  chatId: number | string;
  threadId: number;
  day: string;
  line: string;
  createdAt: string;
}

/** A list response that may be a bare array (legacy) or `{ total, items }`. */
export interface EveListPage<T> {
  total: number;
  items: T[];
}

const EVE_ERRORS: Record<string, string> = {
  NETWORK_ERROR: "Нет связи с Eve-прокси дашборда",
  EVE_PROXY_DISABLED: "EVE_TOKEN не задан на сервере дашборда",
  EVE_PROXY_NOT_FOUND: "Этот Eve-эндпоинт недоступен из дашборда",
  EVE_PROXY_UNREACHABLE: "Nest API недоступен с сервера дашборда",
  EVE_PERSONA_NOT_FOUND: "Персона не найдена",
  NAME_REQUIRED: "Укажите имя персоны",
  ACCOUNT_REQUIRED: "Выберите аккаунт",
  BAD_RELATIONSHIP_MODE: "Режим отношений: shared или isolated",
  BAD_CHAT_ID: "Chat ID должен быть целым ненулевым числом",
  EVE_DISABLED: "EVE_TOKEN не настроен на Nest API",
  EVE_UNAUTHORIZED:
    "Nest отклонил EVE_TOKEN — проверьте значения на обеих сторонах",
  EVE_DOC_KIND_INVALID:
    "Неизвестный документ персоны: допустимы persona, speech, boundaries, communication",
  EVE_DOC_CONTENT_REQUIRED: "Текст документа не может быть пустым",
  EVE_PERSONA_DOCS_UNAVAILABLE:
    "Nest ещё не отдаёт документы персоны — нужен роут /internal/eve/personas/:id/docs",
  EVE_CONTEXT_SNAPSHOT_NOT_FOUND: "Снапшот контекста не найден",
  EVE_CONTEXT_BAD_PAYLOAD:
    "Nest вернул снапшот контекста в неожиданном формате",
  HTTP_404:
    "Эндпоинт не найден на Nest API — возможно, он ещё не подключён к /internal/eve",
  HTTP_500: "Nest API вернул ошибку при чтении Eve-данных",
};

/** Russian message for an Eve call; keeps the upstream text when unknown. */
export function eveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const upstreamCode = (error.body as { error?: unknown }).error;
    if (typeof upstreamCode === "string" && EVE_ERRORS[upstreamCode]) {
      return EVE_ERRORS[upstreamCode];
    }
    const localised = EVE_ERRORS[error.code];
    if (localised) return localised;
    if (Array.isArray(error.body.message)) {
      return error.body.message.join("; ");
    }
    if (error.body.message) return error.body.message;
    return errorMessage(error);
  }
  return errorMessage(error);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

export async function eveFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers();
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${EVE_PROXY}/${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, {
      code: "NETWORK_ERROR",
      message: "Cannot reach the dashboard Eve proxy",
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    const body: ApiErrorBody =
      data !== null && typeof data === "object" && "message" in data
        ? (data as ApiErrorBody)
        : {
            code: `HTTP_${response.status}`,
            message: response.statusText || "Request failed",
          };
    throw new ApiError(response.status, body);
  }

  return data as T;
}

export function listPersonas(): Promise<EvePersonaView[]> {
  return eveFetch("personas");
}

export function getPersona(id: string): Promise<EvePersonaView> {
  return eveFetch(`personas/${encodeURIComponent(id)}`);
}

export function createPersona(body: EvePersonaInput): Promise<EvePersonaView> {
  return eveFetch("personas", { method: "POST", body });
}

export function updatePersona(
  id: string,
  body: EvePersonaInput,
): Promise<EvePersonaView> {
  return eveFetch(`personas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function bindAccount(
  personaId: string,
  body: EveBindAccountInput,
): Promise<EvePersonaAccountView> {
  return eveFetch(`personas/${encodeURIComponent(personaId)}/accounts`, {
    method: "POST",
    body,
  });
}

export function unbindAccount(
  personaId: string,
  accountId: string,
): Promise<{ ok: boolean }> {
  return eveFetch(
    `personas/${encodeURIComponent(personaId)}/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
}

export function listChats(personaId: string): Promise<EveChatBindingView[]> {
  return eveFetch(`personas/${encodeURIComponent(personaId)}/chats`);
}

export function allowChat(
  personaId: string,
  body: EveChatBindingInput,
): Promise<EveChatBindingView> {
  return eveFetch(`personas/${encodeURIComponent(personaId)}/chats`, {
    method: "POST",
    body,
  });
}

export function getRelationship(
  personaId: string,
  accountId: string,
  chatId: string,
): Promise<EveRelationshipView> {
  const params = new URLSearchParams({ personaId, accountId, chatId });
  return eveFetch(`state/relationship?${params.toString()}`);
}

export function getConflict(
  personaId: string,
  accountId: string,
  chatId: string,
): Promise<EveConflictView> {
  const params = new URLSearchParams({ personaId, accountId, chatId });
  return eveFetch(`state/conflict?${params.toString()}`);
}

/**
 * Chat «Хроника»: his messages, her replies/ignores and relationship deltas.
 * `before` is the `nextBefore` cursor of the previous page.
 */
export function getChatTimeline(
  personaId: string,
  accountId: string,
  chatId: string,
  options: {
    threadId?: number;
    limit?: number;
    before?: string | null;
  } = {},
): Promise<EveTimelineView> {
  const params = new URLSearchParams({ personaId, accountId, chatId });
  params.set("threadId", String(options.threadId ?? 0));
  params.set("limit", String(options.limit ?? 100));
  if (options.before) params.set("before", options.before);
  return eveFetch(`timeline?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Persona documents (persona / speech / boundaries / communication)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDocs(value: unknown): EvePersonaDocView[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.docs)
      ? value.docs
      : [];
  return raw.filter(
    (item): item is EvePersonaDocView =>
      isRecord(item) && typeof item.id === "string",
  );
}

/** Lists stored documents; Nest may fill missing ones from the template. */
export async function getPersonaDocs(
  personaId: string,
): Promise<EvePersonaDocView[]> {
  const data = await eveFetch<unknown>(
    `personas/${encodeURIComponent(personaId)}/docs`,
  );
  return normalizeDocs(data);
}

export async function savePersonaDoc(
  personaId: string,
  kind: EvePersonaDocKind,
  content: string,
): Promise<EvePersonaDocView> {
  const data = await eveFetch<unknown>(
    `personas/${encodeURIComponent(personaId)}/docs`,
    {
      method: "PUT",
      body: { kind, content },
    },
  );
  const docs = normalizeDocs(data);
  const saved = docs.find((doc) => doc.kind === kind);
  if (saved) return saved;
  if (isRecord(data) && typeof data.id === "string") {
    return data as unknown as EvePersonaDocView;
  }
  // Nest may return `{ ok: true }`; keep the editor state without inventing ids.
  return {
    id: `${personaId}:${kind}`,
    personaId,
    kind,
    content,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Regenerates all four documents on the server (overwrites manual edits). */
export async function generatePersonaDocs(
  personaId: string,
): Promise<EvePersonaDocView[]> {
  const data = await eveFetch<unknown>(
    `personas/${encodeURIComponent(personaId)}/generate`,
    { method: "POST", body: {} },
  );
  return normalizeDocs(data);
}

// ---------------------------------------------------------------------------
// Memory (read-only)
// ---------------------------------------------------------------------------

function asPage<T>(value: unknown): EveListPage<T> {
  if (Array.isArray(value)) {
    return { total: value.length, items: value as T[] };
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    const items = value.items as T[];
    return {
      total: typeof value.total === "number" ? value.total : items.length,
      items,
    };
  }
  return { total: 0, items: [] };
}

export async function listMemoryDaily(
  personaId: string,
): Promise<EveListPage<EveMemoryDailyView>> {
  const params = new URLSearchParams({ personaId });
  return asPage<EveMemoryDailyView>(
    await eveFetch<unknown>(`memory/daily?${params.toString()}`),
  );
}

export async function listMemoryFacts(
  personaId: string,
): Promise<EveListPage<EveMemoryFactView>> {
  const params = new URLSearchParams({ personaId });
  return asPage<EveMemoryFactView>(
    await eveFetch<unknown>(`memory/facts?${params.toString()}`),
  );
}

export async function listPalaceDrawers(
  personaId: string,
): Promise<EveListPage<EvePalaceDrawerView>> {
  const params = new URLSearchParams({ personaId });
  return asPage<EvePalaceDrawerView>(
    await eveFetch<unknown>(`memory/palace?${params.toString()}`),
  );
}

export async function listAgendaItems(
  personaId: string,
): Promise<EveListPage<EveAgendaItemView>> {
  const params = new URLSearchParams({ personaId });
  return asPage<EveAgendaItemView>(
    await eveFetch<unknown>(`agenda?${params.toString()}`),
  );
}

export async function listSessionLogs(
  personaId: string,
): Promise<EveListPage<EveSessionLogView>> {
  const params = new URLSearchParams({ personaId });
  return asPage<EveSessionLogView>(
    await eveFetch<unknown>(`memory/sessions?${params.toString()}`),
  );
}
