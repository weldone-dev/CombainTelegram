import { API_URL } from "./api";

/** Account profile photo endpoint (JPEG, 404 when the account has none). */
export function accountAvatarUrl(accountId: string): string {
  return `${API_URL}/accounts/${encodeURIComponent(accountId)}/avatar`;
}

/** Chat/user/channel profile photo endpoint. */
export function chatAvatarUrl(accountId: string, chatId: number): string {
  return `${API_URL}/accounts/${encodeURIComponent(accountId)}/chats/${chatId}/avatar`;
}
