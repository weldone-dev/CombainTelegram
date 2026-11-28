"use client";

import { useMemo, useState } from "react";
import {
  Card,
  GhostButton,
  inputClass,
  Pill,
  Toggle,
} from "../../../components/dashboard/ai-ui";
import type {
  EveContextMessage,
  EveContextSnapshot,
} from "../../../lib/eve-context";
import {
  analyzeBlocks,
  type BlockIssue,
  effectiveKind,
  formatCount,
  formatSnapshotTime,
  instructionsWrapperIndex,
  MESSAGE_KIND_LABELS,
  type MessageFilter,
  matchesFilter,
  ROLE_LABELS,
  SNAPSHOT_KIND_LABELS,
  sizeLabel,
  snapshotKindTone,
  snapshotSize,
  splitHighlight,
  systemPromptText,
  systemSummary,
  tokenLabel,
} from "./context-utils";

/** Longer text is collapsed unless the user asks for the whole thing. */
const CLAMP = 900;

/** Renders `text` with every search match wrapped in `<mark>`. */
function highlighted(text: string, query: string) {
  let offset = 0;
  return splitHighlight(text, query).map((part) => {
    const start = offset;
    offset += part.text.length;
    return part.match ? (
      <mark
        key={`${start}-mark`}
        className="rounded-sm bg-amber-400/30 text-amber-100"
      >
        {part.text}
      </mark>
    ) : (
      <span key={`${start}-plain`}>{part.text}</span>
    );
  });
}

/** Clipboard API with a hidden-textarea fallback for older browsers. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

const FILTERS: Array<{ value: MessageFilter; label: string }> = [
  { value: "all", label: "все" },
  { value: "memory", label: "memory" },
  { value: "internal", label: "internal" },
  { value: "incoming", label: "incoming" },
];

function messageBox(kind: string): string {
  switch (kind) {
    case "memory":
      return "border-emerald-900/60 bg-emerald-950/10";
    case "internal":
      return "border-amber-800/60 border-dashed bg-amber-950/10";
    case "incoming":
      return "border-sky-900/60 bg-sky-950/10";
    case "tool":
      return "border-violet-900/60 bg-violet-950/10";
    default:
      return "border-zinc-800 bg-zinc-950/30";
  }
}

function roleTone(
  role: EveContextMessage["role"],
): "zinc" | "sky" | "green" | "amber" {
  switch (role) {
    case "user":
      return "sky";
    case "assistant":
      return "green";
    case "tool":
      return "amber";
    default:
      return "zinc";
  }
}

/**
 * Renders `text`, optionally clamped and with search matches highlighted.
 * `expanded` is owned by the viewer so the global compact switch also works.
 */
function ContextText({
  text,
  query,
  compact,
  expanded,
  label,
  onToggle,
}: {
  text: string;
  query: string;
  compact: boolean;
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  const limit = compact && !expanded ? CLAMP : Number.POSITIVE_INFINITY;
  const visible = text.length > limit ? text.slice(0, limit) : text;

  return (
    <div>
      <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-zinc-300">
        {highlighted(visible, query)}
        {text.length > visible.length && (
          <span className="text-zinc-600">…</span>
        )}
      </pre>
      {text.length > limit && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-1 text-[11px] text-sky-400 hover:text-sky-300"
        >
          {expanded
            ? `Свернуть ${label}`
            : `Показать полностью (+${formatCount(text.length - visible.length)} симв.)`}
        </button>
      )}
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-zinc-800/70 bg-zinc-950/30 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-mono text-[11px] text-zinc-300">
        {value || "—"}
      </dd>
    </div>
  );
}

export function ContextViewer({
  snapshot,
  demo,
  defaultCompact = true,
}: {
  snapshot: EveContextSnapshot;
  demo: boolean;
  /** The chat panel shows the full text; the inspector opens compact. */
  defaultCompact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MessageFilter>("all");
  const [compact, setCompact] = useState(defaultCompact);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [fullSystem, setFullSystem] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");

  // Eve's technical wrapper (`system` / "Instructions (instructions)") is not a
  // real prompt block: it folds into the section header instead of looking empty.
  const wrapperIndex = instructionsWrapperIndex(snapshot.system);
  const wrapper = wrapperIndex >= 0 ? snapshot.system[wrapperIndex] : undefined;
  const [openBlocks, setOpenBlocks] = useState<ReadonlySet<number>>(
    () => new Set([wrapperIndex === 0 && snapshot.system.length > 1 ? 1 : 0]),
  );

  const needle = query.trim().toLowerCase();
  const size = useMemo(() => snapshotSize(snapshot), [snapshot]);
  const systemText = useMemo(
    () => systemPromptText(snapshot.system),
    [snapshot.system],
  );
  const issues = useMemo(
    () => analyzeBlocks(snapshot.system),
    [snapshot.system],
  );
  const issueByIndex = useMemo(() => {
    const map = new Map<number, BlockIssue>();
    for (const issue of issues) map.set(issue.index, issue);
    return map;
  }, [issues]);

  const blockEntries = useMemo(() => {
    const seen = new Map<string, number>();
    return snapshot.system
      .map((block, index) => {
        const occurrence = (seen.get(block.name) ?? 0) + 1;
        seen.set(block.name, occurrence);
        return { block, index, key: `${block.name}#${occurrence}` };
      })
      .filter(({ index }) => index !== wrapperIndex);
  }, [snapshot.system, wrapperIndex]);

  const messageEntries = useMemo(() => {
    const seen = new Map<string, number>();
    return snapshot.messages.map((message, index) => {
      const signature = `${message.role}:${message.kind ?? "plain"}:${message.chars}`;
      const occurrence = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, occurrence);
      return {
        message,
        position: index + 1,
        key: `${signature}#${occurrence}`,
      };
    });
  }, [snapshot.messages]);

  const visibleBlocks = blockEntries.filter(({ block }) => {
    if (!needle) return true;
    return (
      block.name.toLowerCase().includes(needle) ||
      block.text.toLowerCase().includes(needle)
    );
  });
  const visibleMessages = messageEntries.filter(({ message }) => {
    if (!matchesFilter(message, filter)) return false;
    if (!needle) return true;
    return message.text.toLowerCase().includes(needle);
  });

  const toggleExpanded = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleBlock = (index: number) => {
    setOpenBlocks((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const openAllBlocks = () =>
    setOpenBlocks(new Set(blockEntries.map(({ index }) => index)));
  const closeAllBlocks = () => setOpenBlocks(new Set());

  const copySystemPrompt = async () => {
    const copied = await copyText(systemText);
    setCopyState(copied ? "done" : "error");
    window.setTimeout(() => setCopyState("idle"), 1600);
  };

  const tokens = snapshot.tokens;

  return (
    <div className="min-w-0 space-y-4">
      <Card
        title={`Turn · ${SNAPSHOT_KIND_LABELS[snapshot.kind]}`}
        description={`${formatSnapshotTime(snapshot.createdAt)} · ${formatCount(size.chars)} символов суммарно`}
        actions={
          <span className="flex flex-wrap items-center justify-end gap-1.5">
            <Pill tone={snapshotKindTone(snapshot.kind)}>
              {SNAPSHOT_KIND_LABELS[snapshot.kind]}
            </Pill>
            <Pill tone="zinc">{snapshot.model || "модель не указана"}</Pill>
            {snapshot.dryRun && <Pill tone="red">dry-run</Pill>}
            {demo && <Pill tone="amber">demo</Pill>}
          </span>
        }
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Pill tone="sky">system {formatCount(tokens.system)}</Pill>
          <Pill tone="sky">messages {formatCount(tokens.messages)}</Pill>
          <Pill tone="green">total {formatCount(tokens.total)}</Pill>
          <Pill tone="zinc">input {formatCount(tokens.input)}</Pill>
          <Pill tone="zinc">output {formatCount(tokens.output)}</Pill>
          <Pill tone="zinc">
            блоки {formatCount(snapshot.system.length)} / сообщения{" "}
            {formatCount(snapshot.messages.length)}
          </Pill>
        </div>

        <dl className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
          <MetaCell label="persona" value={snapshot.personaId} />
          <MetaCell label="account" value={snapshot.accountId} />
          <MetaCell
            label="chat / thread"
            value={`${snapshot.chatId}${snapshot.threadId ? ` / ${snapshot.threadId}` : ""}`}
          />
          <MetaCell label="turn" value={snapshot.turnId ?? "—"} />
        </dl>

        {snapshot.meta && Object.keys(snapshot.meta).length > 0 && (
          <details className="mt-2 rounded-md border border-zinc-800/70">
            <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-zinc-400">
              meta ({Object.keys(snapshot.meta).length} полей)
            </summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-800/70 p-2 font-mono text-[10px] text-zinc-400">
              {JSON.stringify(snapshot.meta, null, 2)}
            </pre>
          </details>
        )}
      </Card>

      <Card
        title="Что уходит в модель"
        description="Порядок сообщений совпадает с запросом; system prompt передаётся отдельным полем instructions и идёт до messages."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Поиск по тексту и блокам…"
              aria-label="Поиск по контексту"
              className={`${inputClass} mt-0 w-full min-w-0 py-1 sm:w-56`}
            />
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
            <legend className="sr-only">Фильтр сообщений по kind</legend>
            {FILTERS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-pressed={filter === entry.value}
                onClick={() => setFilter(entry.value)}
                className={`rounded-md border px-2 py-1 text-[11px] ${
                  filter === entry.value
                    ? "border-sky-700 bg-sky-500/15 text-sky-300"
                    : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </fieldset>
          <Toggle
            checked={compact}
            onChange={setCompact}
            label="Свернуть длинное"
            hint={`Обрезать тексты длиннее ${CLAMP} символов`}
          />
          {needle && (
            <span className="text-[11px] text-zinc-500">
              найдено: {visibleBlocks.length} блоков, {visibleMessages.length}{" "}
              сообщений
            </span>
          )}
        </div>

        <section aria-labelledby="context-blocks-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <h3
                id="context-blocks-title"
                className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-zinc-100"
              >
                System prompt
                <span className="font-mono text-xs font-normal text-zinc-300">
                  {systemSummary(snapshot.system, tokens.system)}
                </span>
              </h3>
              <p className="mt-1 max-w-3xl break-words text-[11px] text-zinc-500">
                Передаётся модели отдельным полем{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-300">
                  instructions
                </code>
                ; в{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-300">
                  messages
                </code>{" "}
                его нет by design.
                {wrapper && (
                  <>
                    {" "}
                    Первый технический блок — «{wrapper.name}: {wrapper.text}» (
                    {formatCount(wrapper.chars)} симв.) — включён в заголовок
                    промпта и не показан отдельным блоком.
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={visibleBlocks.length > 0 ? "sky" : "zinc"}>
                {visibleBlocks.length} / {snapshot.system.length}
              </Pill>
              <GhostButton onClick={() => setFullSystem((value) => !value)}>
                {fullSystem ? "Показать блоками" : "Показать целиком"}
              </GhostButton>
              <GhostButton onClick={openAllBlocks}>Развернуть</GhostButton>
              <GhostButton onClick={closeAllBlocks}>Свернуть</GhostButton>
            </div>
          </div>

          {issues.length > 0 && (
            <output className="mt-2 block break-words rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-300">
              Подозрительные блоки: {issues.length}.{" "}
              {issues
                .map(
                  (issue) =>
                    `${snapshot.system[issue.index]?.name ?? `#${issue.index}`} — ${issue.reasons.join(", ")}`,
                )
                .join("; ")}
            </output>
          )}

          {snapshot.system.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              System prompt не передан в снапшоте.
            </p>
          ) : fullSystem ? (
            <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/40">
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/70 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 text-[11px] text-zinc-400">
                  instructions целиком · {formatCount(size.systemChars)} симв. ·{" "}
                  {tokenLabel(tokens.system, size.systemChars)} ·{" "}
                  {formatCount(snapshot.system.length)} блоков текстом
                </span>
                <GhostButton onClick={() => void copySystemPrompt()}>
                  {copyState === "done"
                    ? "Скопировано"
                    : copyState === "error"
                      ? "Не удалось"
                      : "Копировать"}
                </GhostButton>
              </div>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-2.5 font-sans text-xs leading-relaxed text-zinc-300">
                {highlighted(systemText, query)}
              </pre>
            </div>
          ) : visibleBlocks.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              Ни один блок не совпал с поиском.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {visibleBlocks.map(({ block, index, key }) => {
                const issue = issueByIndex.get(index);
                const open = openBlocks.has(index);
                const empty = block.text.trim().length === 0;
                return (
                  <div
                    key={key}
                    className={`rounded-lg border ${
                      issue
                        ? "border-amber-800/60 bg-amber-950/10"
                        : "border-zinc-800 bg-zinc-950/30"
                    } ${empty ? "opacity-60" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggleBlock(index)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span
                          aria-hidden="true"
                          className="w-3 shrink-0 text-zinc-500"
                        >
                          {open ? "▾" : "▸"}
                        </span>
                        <span className="truncate font-mono text-xs text-zinc-200">
                          {block.name}
                        </span>
                      </button>
                      <span className="text-[10px] text-zinc-500">
                        {sizeLabel(block.chars, block.tokens)}
                      </span>
                      {issue?.reasons.map((reason) => (
                        <Pill key={reason} tone="amber">
                          {reason}
                        </Pill>
                      ))}
                    </div>
                    {open && (
                      <div className="border-t border-zinc-800/70 px-2.5 py-2">
                        {block.text.trim() ? (
                          <ContextText
                            text={block.text}
                            query={query}
                            compact={compact}
                            expanded={expanded.has(`block:${key}`)}
                            label="блок"
                            onToggle={() => toggleExpanded(`block:${key}`)}
                          />
                        ) : (
                          <p className="text-[11px] italic text-zinc-500">
                            Блок пустой — в промпт уходит имя без текста.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section aria-labelledby="context-messages-title" className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id="context-messages-title"
              className="min-w-0 flex-1 text-xs font-semibold text-zinc-200"
            >
              Сообщения по порядку
            </h3>
            <Pill tone={visibleMessages.length > 0 ? "sky" : "zinc"}>
              {visibleMessages.length} / {snapshot.messages.length}
            </Pill>
            <span className="text-[10px] text-zinc-500">
              {formatCount(size.messageChars)} симв
            </span>
          </div>

          {snapshot.messages.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              Сообщения не переданы в снапшоте.
            </p>
          ) : visibleMessages.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              Нет сообщений под выбранный фильтр и поиск.
            </p>
          ) : (
            <ol className="mt-2 space-y-2">
              {visibleMessages.map(({ message, position, key }) => {
                const kind = effectiveKind(message);
                const kindLabel =
                  message.kind !== undefined
                    ? MESSAGE_KIND_LABELS[message.kind]
                    : kind !== "plain"
                      ? `${kind}?`
                      : null;
                return (
                  <li
                    key={key}
                    className={`rounded-lg border px-2.5 py-2 ${messageBox(kind)}`}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] text-zinc-500">
                        #{position}
                      </span>
                      <Pill tone={roleTone(message.role)}>
                        {ROLE_LABELS[message.role]}
                      </Pill>
                      {kindLabel && (
                        <Pill
                          tone={
                            kind === "memory"
                              ? "green"
                              : kind === "internal"
                                ? "amber"
                                : "zinc"
                          }
                        >
                          {kindLabel}
                        </Pill>
                      )}
                      {message.kind === undefined && kind !== "plain" && (
                        <span
                          className="text-[10px] text-zinc-500"
                          title="kind не указан, определён по роли или тексту"
                        >
                          определён эвристикой
                        </span>
                      )}
                      <span className="ml-auto text-[10px] text-zinc-500">
                        {sizeLabel(message.chars, message.tokens)}
                      </span>
                    </div>
                    {message.text.trim() ? (
                      <ContextText
                        text={message.text}
                        query={query}
                        compact={compact}
                        expanded={expanded.has(`message:${key}`)}
                        label="сообщение"
                        onToggle={() => toggleExpanded(`message:${key}`)}
                      />
                    ) : (
                      <p className="text-[11px] italic text-zinc-500">
                        Пустой текст сообщения.
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <p className="mt-3 text-[10px] text-zinc-600">
          input/output/total — usage провайдера. system и messages — оценка по
          символам с поправкой на кириллицу (≈2.2 символа на токен против ≈4 для
          латиницы); «≈» у отдельного блока — грубая оценка по 4 символам.
          system {formatCount(tokens.system)} tok, всего{" "}
          {tokenLabel(tokens.total, size.chars)}.
        </p>
      </Card>
    </div>
  );
}
