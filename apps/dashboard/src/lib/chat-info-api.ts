import { apiFetch } from "./api";
import type {
  ChatInfoMediaKind,
  ChatInfoMediaView,
  ChatInfoSimilarView,
  ChatInfoView,
} from "./types";

/** Shared prefix of the chat info endpoints. */
function infoPath(accountId: string, chatId: number): string {
  return `/accounts/${encodeURIComponent(accountId)}/chats/${chatId}/info`;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Profile card of one chat: about text, members, invite link, permissions. */
export function getChatInfo(
  accountId: string,
  chatId: number,
  sessionId?: string | null,
): Promise<ChatInfoView> {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  return apiFetch<ChatInfoView>(
    withQuery(infoPath(accountId, chatId), params),
    {
      method: "GET",
    },
  );
}

export interface ChatInfoMediaOptions {
  limit?: number;
  offsetId?: number | null;
  sessionId?: string | null;
}

/** One page of shared media, links or polls of a chat. */
export function getChatInfoMedia(
  accountId: string,
  chatId: number,
  kind: ChatInfoMediaKind,
  options: ChatInfoMediaOptions = {},
): Promise<ChatInfoMediaView> {
  const params = new URLSearchParams({ kind });
  params.set("limit", String(options.limit ?? 30));
  if (options.offsetId !== null && options.offsetId !== undefined) {
    params.set("offsetId", String(options.offsetId));
  }
  if (options.sessionId) params.set("sessionId", options.sessionId);
  return apiFetch<ChatInfoMediaView>(
    withQuery(`${infoPath(accountId, chatId)}/media`, params),
    { method: "GET" },
  );
}

/** Chats similar to this one, as suggested by Telegram. */
export function getChatInfoSimilar(
  accountId: string,
  chatId: number,
  sessionId?: string | null,
): Promise<ChatInfoSimilarView> {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  return apiFetch<ChatInfoSimilarView>(
    withQuery(`${infoPath(accountId, chatId)}/similar`, params),
    { method: "GET" },
  );
}
