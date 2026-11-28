"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatCount,
  formatSnapshotTime,
  previewText,
  SNAPSHOT_KIND_LABELS,
  snapshotKindTone,
  snapshotSize,
  tokenLabel,
} from "../../app/eve/context/context-utils";
import { ContextViewer } from "../../app/eve/context/context-viewer";
import { eveErrorMessage } from "../../lib/eve-api";
import {
  type ChatPersonaMatch,
  resolveChatPersonas,
} from "../../lib/eve-chat-personas";
import {
  type EveContextSnapshot,
  listContextSnapshots,
} from "../../lib/eve-context";
import { Pill } from "../dashboard/ai-ui";
import {
  EmptyNote,
  PanelCard,
  RowsSkeleton,
  SMALL_BUTTON,
  TabError,
  useCachedResource,
} from "./chat-tab-ui";

/** The panel only needs the last few turns; older ones live on /eve/context. */
const SNAPSHOT_LIMIT = 5;

/**
 * «Контекст» tab of the chat info panel: exactly what the model received on
 * the latest turns of this chat. Snapshots come from Nest through the
 * dashboard proxy; the viewer is the same component as `/eve/context`, so the
 * block accordions and the message filters behave identically.
 */
export function ChatContextTab({
  accountId,
  chatId,
  threadId,
}: {
  accountId: string;
  chatId: number;
  threadId: number;
}) {
  const chatIdText = String(chatId);
  const matches = useCachedResource<ChatPersonaMatch[]>(
    `eve-chat-matches:${accountId}:${chatIdText}:${threadId}`,
    () => resolveChatPersonas(accountId, chatIdText, threadId),
  );
  // The first match is the exact-topic binding when there is one, otherwise
  // the whole-chat binding — the same choice the other Eve tabs make.
  const active = matches.data?.[0] ?? null;
  const personaId = active?.persona.id ?? "";

  const [snapshots, setSnapshots] = useState<EveContextSnapshot[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!personaId) {
      setSnapshots([]);
      setSelectedId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await listContextSnapshots({
        personaId,
        accountId,
        chatId: chatIdText,
        limit: SNAPSHOT_LIMIT,
      });
      setSnapshots(list);
      // Default to the newest turn; keep a manual choice while it still exists.
      setSelectedId((current) =>
        current && list.some((snapshot) => snapshot.id === current)
          ? current
          : (list[0]?.id ?? null),
      );
      setError(null);
    } catch (caught) {
      setError(eveErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [personaId, accountId, chatIdText]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => snapshots?.find((snapshot) => snapshot.id === selectedId) ?? null,
    [snapshots, selectedId],
  );

  if (matches.loading && !matches.data) {
    return (
      <PanelCard title="Контекст">
        <RowsSkeleton rows={4} />
      </PanelCard>
    );
  }

  if (matches.error) {
    return (
      <PanelCard title="Контекст">
        <TabError
          text={matches.error}
          onRetry={() => {
            matches.reload();
            void load();
          }}
        />
      </PanelCard>
    );
  }

  if (!active) {
    return (
      <PanelCard title="Контекст">
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
      <PanelCard
        title="Контекст модели"
        hint={`${active.persona.name} · последние ${SNAPSHOT_LIMIT} turn'ов этого чата`}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            title="Обновить снапшоты"
            className={SMALL_BUTTON}
          >
            {loading ? "…" : "Обновить"}
          </button>
        }
      >
        {snapshots === null ? (
          <RowsSkeleton rows={2} />
        ) : snapshots.length === 0 ? (
          <EmptyNote>Для этого чата ещё нет снапшотов</EmptyNote>
        ) : (
          <div className="space-y-1">
            {snapshots.map((snapshot) => {
              const isActive = snapshot.id === selectedId;
              const size = snapshotSize(snapshot);
              return (
                <button
                  key={snapshot.id}
                  type="button"
                  onClick={() => setSelectedId(snapshot.id)}
                  aria-pressed={isActive}
                  title={previewText(snapshot, 140)}
                  className={`flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left transition-colors ${
                    isActive
                      ? "border-sky-800 bg-sky-500/10"
                      : "border-transparent hover:bg-zinc-800/70"
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] text-zinc-400">
                      {formatSnapshotTime(snapshot.createdAt)}
                    </span>
                    <Pill tone={snapshotKindTone(snapshot.kind)}>
                      {SNAPSHOT_KIND_LABELS[snapshot.kind]}
                    </Pill>
                    {snapshot.dryRun && <Pill tone="red">dry-run</Pill>}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                    <span className="max-w-[11rem] truncate font-mono">
                      {snapshot.model || "модель не указана"}
                    </span>
                    <span>·</span>
                    <span>{tokenLabel(snapshot.tokens.total, size.chars)}</span>
                    <span>·</span>
                    <span>
                      {formatCount(snapshot.system.length)} блоков /{" "}
                      {formatCount(snapshot.messages.length)} сообщ.
                    </span>
                  </span>
                  <span className="line-clamp-1 text-[11px] text-zinc-400">
                    {previewText(snapshot, 80) || "пустой turn"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div className="mt-2">
            <TabError text={error} onRetry={() => void load()} />
          </div>
        )}
      </PanelCard>

      {selected ? (
        // Full text on purpose: the chat panel is a debugging view, so the
        // compact 900-character clamp of the standalone page stays off.
        <ContextViewer
          key={selected.id}
          snapshot={selected}
          demo={false}
          defaultCompact={false}
        />
      ) : (
        snapshots !== null &&
        snapshots.length > 0 && (
          <PanelCard title="Детали turn'а">
            <p className="text-xs text-zinc-500">Выберите снапшот выше.</p>
          </PanelCard>
        )
      )}
    </div>
  );
}
