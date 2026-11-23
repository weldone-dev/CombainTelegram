import type { Client } from 'tdlib-native';
import type { chat, chatFolderInfo, ChatList } from 'tdlib-native/types';
import { notFound } from '../common/api-error.js';
import {
  guessedChatIdsFromPeer,
  peerIdFromTdChatType,
  peerIdFromTdChatId,
} from './td-peer.js';

/** Chats loaded per list while seeding or retrying a lookup. */
const LIST_LIMIT = 200;

/** The ChatList values seeded on the first resolve. */
const SEED_LISTS: ChatList[] = [
  { _: 'chatListMain' },
  { _: 'chatListArchive' },
];

export type TdRegistryClient = Pick<Client, 'api' | 'updates'>;

/**
 * Per-session index of TDLib `chat_id` ↔ marked peer id.
 *
 * TDLib requires its own numeric `chat_id` for every call, while our REST API
 * speaks marked peer ids. The registry is seeded from `loadChats`/`getChats`
 * (main and archive), kept fresh by `updateNewChat`, and exposes `resolve()`
 * with a lazy retry for chats that arrived after the seed.
 *
 * The maps are intentionally bounded by Telegram's own chat list; a session
 * with tens of thousands of chats still keeps one small object per chat.
 */
export class TdChatRegistry {
  private readonly byChatId = new Map<number, chat>();
  private readonly byPeerId = new Map<number, number>();
  private readonly folderList: chatFolderInfo[] = [];
  private unsubscribe?: () => void;
  private seeded?: Promise<void>;

  constructor(private readonly client: TdRegistryClient) {}

  /** Subscribes to TDLib updates. Safe to call more than once. */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.client.updates.subscribe((update) => {
      switch (update._) {
        case 'updateNewChat':
          this.put(update.chat);
          break;
        case 'updateChatFolders':
          this.folderList.splice(
            0,
            this.folderList.length,
            ...update.chat_folders,
          );
          break;
        default:
          break;
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Folders received through `updateChatFolders`. */
  folders(): readonly chatFolderInfo[] {
    return this.folderList;
  }

  /** Number of indexed chats; used by tests and diagnostics. */
  get size(): number {
    return this.byChatId.size;
  }

  /** Stores (or refreshes) one chat and its peer-id index entry. */
  put(entry: chat): void {
    if (!entry || typeof entry.id !== 'number') return;
    this.byChatId.set(entry.id, entry);
    const peerId = peerIdFromTdChatType(entry.type);
    if (peerId !== null) this.byPeerId.set(peerId, entry.id);
  }

  /** Cached TDLib chat object by its own `chat_id`. */
  get(chatId: number): chat | undefined {
    return this.byChatId.get(chatId);
  }

  /** Cached TDLib `chat_id` for a marked peer id, without network access. */
  tryResolve(peerId: number): number | null {
    return this.byPeerId.get(peerId) ?? null;
  }

  /**
   * Resolves a marked peer id to a TDLib `chat_id`.
   *
   * A miss triggers one lazy retry (`loadChats` then `getChats` on main and
   * archive). If the chat is still absent, `getChat` is asked directly with the
   * ids the peer id can denote — the last resort for a chat opened from a link
   * before Telegram has delivered its `updateNewChat`.
   */
  async resolve(peerId: number): Promise<number> {
    const cached = this.byPeerId.get(peerId);
    if (cached !== undefined) return cached;

    await this.seed();
    const afterSeed = this.byPeerId.get(peerId);
    if (afterSeed !== undefined) return afterSeed;

    for (const chatId of guessedChatIdsFromPeer(peerId)) {
      try {
        const entry = await this.client.api.getChat({ chat_id: chatId });
        if (peerIdFromTdChatType(entry.type) !== peerId) continue;
        this.put(entry);
        return entry.id;
      } catch {
        // Try the next candidate id.
      }
    }

    throw notFound('TD_CHAT_NOT_FOUND', 'This chat is not known to TDLib');
  }

  /** Loads and indexes the main and archive chat lists once per session. */
  seed(): Promise<void> {
    this.seeded ??= this.refresh();
    return this.seeded;
  }

  /** Best-effort `loadChats` + `getChats` over the seed lists. */
  private async refresh(): Promise<void> {
    for (const list of SEED_LISTS) {
      await this.client.api
        .loadChats({ chat_list: list, limit: LIST_LIMIT })
        .catch(() => undefined);
      await this.loadList(list);
    }
  }

  /** Indexes one chat list; an empty list is a normal TDLib 404. */
  async loadList(list: ChatList, limit = LIST_LIMIT): Promise<void> {
    let ids: number[];
    try {
      const result = await this.client.api.getChats({
        chat_list: list,
        limit,
      });
      ids = result.chat_ids;
    } catch {
      return;
    }

    await Promise.all(
      ids.map(async (chatId) => {
        if (this.byChatId.has(chatId)) return;
        try {
          this.put(await this.client.api.getChat({ chat_id: chatId }));
        } catch {
          // A chat can disappear between getChats and getChat.
        }
      }),
    );
  }

  /** Peer id reconstructed from a chat id when the chat object is missing. */
  static peerIdOfChatId(chatId: number): number | null {
    return peerIdFromTdChatId(chatId);
  }
}
