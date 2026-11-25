"use client";

import { type ReactNode, useState } from "react";
import { errorMessage } from "../../lib/api";
import {
  clearChatMemory,
  getChatMemory,
  simulateIncoming,
} from "./chat-ai-api";
import {
  EmptyNote,
  formatStamp,
  PanelCard,
  RowsSkeleton,
  SMALL_BUTTON,
  TabError,
  TabHeader,
  useCachedResource,
} from "./chat-tab-ui";

const ROLE_LABELS: Record<string, { label: string; className: string }> = {
  assistant: { label: "душа", className: "bg-violet-500/15 text-violet-300" },
  user: { label: "я", className: "bg-sky-500/15 text-sky-300" },
  system: { label: "система", className: "bg-zinc-800 text-zinc-400" },
  tool: { label: "инструмент", className: "bg-zinc-800 text-zinc-400" },
};

const FACT_KINDS: Record<string, string> = {
  fact: "факт",
  preference: "предпочтение",
  event: "событие",
  profile: "профиль",
};

function Collapsible({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? `Свернуть «${title}»` : `Развернуть «${title}»`}
        className="flex w-full items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[11px] font-medium uppercase tracking-wide text-zinc-500 transition-colors hover:text-zinc-300"
      >
        <span aria-hidden="true" className="w-3 text-zinc-600">
          {open ? "▾" : "▸"}
        </span>
        {title}
        <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] normal-case text-zinc-400">
          {count}
        </span>
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

/**
 * «Память» tab: the recent dialogue turns and the long-term picture the soul
 * keeps about one chat. Read-mostly; the whole context can be cleared here,
 * while individual facts are added/removed by the soul itself.
 */
export function ChatMemoryTab({
  accountId,
  chatId,
  threadId,
}: {
  accountId: string;
  chatId: number;
  threadId: number;
}) {
  const [shortOpen, setShortOpen] = useState(true);
  const [longOpen, setLongOpen] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const memory = useCachedResource(
    `chat-memory:${accountId}:${chatId}:${threadId}`,
    () => getChatMemory(accountId, chatId, 50),
  );

  const shortTerm = memory.data?.shortTerm ?? [];
  const facts = memory.data?.longTerm.facts ?? [];
  const summary = memory.data?.longTerm.summary?.trim() ?? "";

  const clearContext = async () => {
    if (
      !window.confirm(
        "Очистить контекст этого чата? Душа забудет все реплики, сводку и факты об этом чате. Сама переписка в Telegram останется.",
      )
    ) {
      return;
    }
    setClearing(true);
    setActionError(null);
    setNotice(null);
    try {
      await clearChatMemory(accountId, chatId);
      setNotice("Контекст очищен: следующий ответ начнётся с чистого листа.");
      memory.reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setClearing(false);
    }
  };

  const simulate = async () => {
    if (
      !window.confirm(
        "Отправить тестовое входящее? Душа ответит в этот чат реальным сообщением Telegram.",
      )
    ) {
      return;
    }
    setSimulating(true);
    setActionError(null);
    setNotice(null);
    try {
      await simulateIncoming(
        accountId,
        chatId,
        "Тестовое входящее сообщение. Ответь коротко.",
      );
      setNotice(
        "Тестовое входящее отправлено. Ответ души появится в чате через несколько секунд.",
      );
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setSimulating(false);
    }
  };

  return (
    <div className="space-y-4">
      <TabHeader
        threadId={threadId}
        onRefresh={memory.reload}
        refreshing={memory.loading}
      />

      {memory.loading && !memory.data && <RowsSkeleton rows={4} />}
      {memory.error && <TabError text={memory.error} onRetry={memory.reload} />}

      {memory.data && (
        <>
          <PanelCard
            title="Краткосрочная"
            hint="Последние реплики диалога, новые сверху"
          >
            <Collapsible
              title="Реплики"
              count={shortTerm.length}
              open={shortOpen}
              onToggle={() => setShortOpen((value) => !value)}
            >
              {shortTerm.length === 0 ? (
                <EmptyNote>
                  Душа ещё не вела этот диалог: краткосрочная память появится
                  после первого обмена сообщениями.
                </EmptyNote>
              ) : (
                <ul className="space-y-1.5">
                  {shortTerm.map((turn, index) => {
                    const role = ROLE_LABELS[turn.role] ?? {
                      label: turn.role,
                      className: "bg-zinc-800 text-zinc-400",
                    };
                    return (
                      <li
                        // Turns carry no id in the API; the newest-first index is stable per load.
                        key={`${turn.createdAt}:${index}`}
                        className="rounded-lg border border-zinc-800 bg-black/20 px-2 py-1.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${role.className}`}
                          >
                            {role.label}
                          </span>
                          <span className="ml-auto text-[10px] text-zinc-500">
                            {formatStamp(turn.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-zinc-300">
                          {turn.content}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Collapsible>
          </PanelCard>

          <PanelCard
            title="Долгосрочная"
            hint="Сводка и факты, которые душа помнит о чате"
          >
            <Collapsible
              title="Факты"
              count={facts.length}
              open={longOpen}
              onToggle={() => setLongOpen((value) => !value)}
            >
              <div className="space-y-2">
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                    Сводка
                  </p>
                  {summary ? (
                    <p className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-black/20 px-2 py-1.5 text-[11px] text-zinc-300">
                      {summary}
                    </p>
                  ) : (
                    <EmptyNote>
                      Сводка ещё не построена: она появляется после накопления
                      реплик.
                    </EmptyNote>
                  )}
                </div>

                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                    Факты
                  </p>
                  {facts.length === 0 ? (
                    <EmptyNote>
                      Душа пока не сохранила фактов об этом чате.
                    </EmptyNote>
                  ) : (
                    <ul className="space-y-1.5">
                      {facts.map((fact, index) => (
                        <li
                          // Facts carry no id in the API; order is stable per load.
                          key={`${fact.createdAt}:${index}`}
                          className="rounded-lg border border-zinc-800 bg-black/20 px-2 py-1.5"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                              {FACT_KINDS[fact.kind] ?? fact.kind}
                            </span>
                            <span
                              title={`Важность ${fact.importance} из 10`}
                              className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
                            >
                              важность {fact.importance}
                            </span>
                            <span className="ml-auto text-[10px] text-zinc-500">
                              {formatStamp(fact.createdAt)}
                            </span>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-zinc-300">
                            {fact.content}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Collapsible>
          </PanelCard>
        </>
      )}

      {actionError && <TabError text={actionError} />}
      {notice && (
        <output className="block rounded-lg border border-emerald-800/60 bg-emerald-950/20 px-2 py-1.5 text-[11px] text-emerald-300">
          {notice}
        </output>
      )}

      <div className="space-y-2">
        <p className="text-[10px] leading-relaxed text-zinc-600">
          «Тест входящего» симулирует сообщение от собеседника и запускает
          workflow: душа ответит в этот чат реальным сообщением. «Очистить
          контекст» удаляет краткосрочные реплики, сводку и факты, которые душа
          помнит об этом чате. Переписка в Telegram не удаляется.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => void simulate()}
            disabled={simulating || clearing || memory.loading}
            title="Симулировать входящее и проверить ответ души"
            className="rounded border border-sky-800/70 bg-sky-950/20 px-2 py-1 text-[11px] text-sky-300 transition-colors hover:border-sky-600 hover:text-sky-200 disabled:opacity-40"
          >
            {simulating ? "Запускаю…" : "Тест входящего"}
          </button>
          <button
            type="button"
            onClick={() => void clearContext()}
            disabled={clearing || simulating || memory.loading}
            title="Забыть весь контекст этого чата"
            className="rounded border border-red-900/70 bg-red-950/20 px-2 py-1 text-[11px] text-red-300 transition-colors hover:border-red-700 hover:text-red-200 disabled:opacity-40"
          >
            {clearing ? "Очищаю…" : "Очистить контекст"}
          </button>
          <button
            type="button"
            onClick={memory.reload}
            disabled={memory.loading || clearing || simulating}
            className={`ml-auto ${SMALL_BUTTON}`}
          >
            {memory.loading ? "Загрузка…" : "Обновить память"}
          </button>
        </div>
      </div>
    </div>
  );
}
