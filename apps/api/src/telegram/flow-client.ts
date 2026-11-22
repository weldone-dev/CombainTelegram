import type { TelegramClient } from '@mtcute/node';
import type { FlowClient } from 'opentele2/mtcute';

/**
 * opentele2's flow helpers only need a `call()`-shaped client, but mtcute's
 * `call` is generic over the TL method, which is incompatible with their
 * structural `{ _: string }` signature. The objects are the same at runtime.
 */
export function asFlowClient(client: TelegramClient): FlowClient {
  return client as unknown as FlowClient;
}
