"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PersonaMemoryCard } from "../../app/eve/persona-memory-card";
import {
  type ChatPersonaMatch,
  resolveChatPersonas,
} from "../../lib/eve-chat-personas";
import {
  EmptyNote,
  PanelCard,
  RowsSkeleton,
  TabError,
  useCachedResource,
} from "./chat-tab-ui";

/**
 * «Память» tab of the chat info drawer: read-only Eve memory of the persona
 * bound to this account + chat. Shares the persona lookup cache with the
 * relationship card, so opening both tabs costs one allowlist read.
 */
export function ChatEveMemoryTab({
  accountId,
  chatId,
  threadId = 0,
  focusDate = null,
}: {
  accountId: string;
  chatId: number;
  threadId?: number;
  /** `YYYY-MM-DD` clicked in a relationship note; filters memory previews. */
  focusDate?: string | null;
}) {
  const chatIdText = String(chatId);
  const [preferredPersonaId, setPreferredPersonaId] = useState<string | null>(
    null,
  );
  // The card can drop the filter without telling the drawer; keep it local so
  // «Сбросить» works while the panel still remembers the clicked day.
  const [focus, setFocus] = useState<string | null>(focusDate ?? null);
  useEffect(() => {
    setFocus(focusDate ?? null);
  }, [focusDate]);

  const matches = useCachedResource<ChatPersonaMatch[]>(
    `eve-chat-matches:${accountId}:${chatIdText}:${threadId}`,
    () => resolveChatPersonas(accountId, chatIdText, threadId),
  );
  const list = matches.data ?? [];
  const active = useMemo(
    () =>
      list.find((item) => item.persona.id === preferredPersonaId) ??
      list[0] ??
      null,
    [list, preferredPersonaId],
  );

  if (matches.loading && !matches.data) {
    return (
      <PanelCard title="Память Eve">
        <RowsSkeleton rows={3} />
      </PanelCard>
    );
  }

  if (matches.error) {
    return (
      <PanelCard title="Память Eve">
        <TabError text={matches.error} onRetry={matches.reload} />
      </PanelCard>
    );
  }

  if (!active) {
    return (
      <PanelCard title="Память Eve">
        <EmptyNote>Чат не привязан к персоне Eve</EmptyNote>
        <Link
          href="/eve"
          className="mt-2 inline-block text-[11px] text-sky-400 hover:text-sky-300"
        >
          Настроить персону в Eve →
        </Link>
      </PanelCard>
    );
  }

  return (
    <div className="space-y-3">
      {list.length > 1 && (
        <label className="block text-[10px] text-zinc-500">
          Персона
          <select
            value={active.persona.id}
            onChange={(event) => setPreferredPersonaId(event.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
          >
            {list.map((item) => (
              <option key={item.persona.id} value={item.persona.id}>
                {item.persona.name}
                {item.binding.threadId > 0
                  ? ` · тред #${item.binding.threadId}`
                  : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <PersonaMemoryCard
        personaId={active.persona.id}
        focusDate={focus}
        onClearFocus={() => setFocus(null)}
      />
    </div>
  );
}
