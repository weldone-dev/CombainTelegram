import {
  type EveChatBindingView,
  type EvePersonaView,
  eveErrorMessage,
  listChats,
  listPersonas,
} from "./eve-api";

/** One persona that has an allowlist binding for this account + chat. */
export interface ChatPersonaMatch {
  persona: EvePersonaView;
  binding: EveChatBindingView;
}

/**
 * Finds every persona whose allowlist has this account + chat.
 *
 * `listPersonas()` already carries account bindings, so personas owned by other
 * accounts are skipped before the per-persona `listChats()` fan-out. A binding
 * without a thread (`threadId = 0`) covers the whole chat; a thread binding only
 * matches its own topic. When several personas allow the chat the caller shows
 * a selector.
 */
export async function resolveChatPersonas(
  accountId: string,
  chatId: string,
  threadId: number,
): Promise<ChatPersonaMatch[]> {
  const personas = await listPersonas();
  const candidates = personas.filter((persona) => {
    if (!persona.accounts) return true;
    return persona.accounts.some(
      (item) => item.accountId === accountId && item.enabled,
    );
  });
  if (candidates.length === 0) return [];

  const results = await Promise.allSettled(
    candidates.map((persona) => listChats(persona.id)),
  );

  const byPersona = new Map<string, ChatPersonaMatch>();
  let firstError: unknown = null;

  results.forEach((result, index) => {
    const persona = candidates[index];
    if (!persona) return;
    if (result.status === "rejected") {
      firstError ??= result.reason;
      return;
    }
    for (const binding of result.value) {
      if (binding.accountId !== accountId) continue;
      if (String(binding.chatId) !== chatId) continue;
      if (binding.threadId > 0 && binding.threadId !== threadId) continue;
      const previous = byPersona.get(persona.id);
      // Prefer the exact topic binding over the whole-chat one.
      if (!previous || binding.threadId > previous.binding.threadId) {
        byPersona.set(persona.id, { persona, binding });
      }
    }
  });

  const matches = [...byPersona.values()].sort(
    (left, right) => right.binding.threadId - left.binding.threadId,
  );
  // A failed allowlist read must not be reported as "not bound".
  if (matches.length === 0 && firstError) {
    throw new Error(eveErrorMessage(firstError));
  }
  return matches;
}
