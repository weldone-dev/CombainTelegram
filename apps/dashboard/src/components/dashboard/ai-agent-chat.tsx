"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentSettings,
  type AgentTraceEntry,
  aiErrorMessage,
  chatWithAi,
  getAiTools,
  type ToolInfo,
} from "../../lib/ai-api";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  trace?: AgentTraceEntry[];
}

function traceTitle(entry: AgentTraceEntry): string {
  const details = [
    `шаг ${entry.step}`,
    `${entry.durationMs} мс`,
    entry.error ? `ошибка: ${entry.error}` : "",
    entry.dryRun ? "dry-run: изменение не ушло в Telegram" : "",
  ].filter(Boolean);
  let args = "";
  try {
    args = JSON.stringify(entry.args ?? {});
  } catch {
    args = "";
  }
  return [entry.tool, ...details, args].filter(Boolean).join(" · ");
}

/**
 * Areas the global agent can work with. Labels are derived from the tools the
 * API actually exposes (`GET /ai/tools`), so the header never advertises a
 * capability the agent lacks.
 */
const CAPABILITY_GROUPS: Array<{ label: string; match: RegExp | null }> = [
  { label: "аккаунты", match: /^(accounts?|chats?|messages?|chat|ai_access)_/ },
  { label: "души", match: /^(souls?|memory)_/ },
  { label: "навыки", match: /^skills?_/ },
  { label: "MCP", match: null },
  { label: "логи", match: /^logs_/ },
  { label: "автоматизации", match: /^automations?_/ },
];

function capabilityLabels(
  tools: ToolInfo[] | null,
  mcpEnabled: boolean,
): string[] {
  if (!tools) return [];
  return CAPABILITY_GROUPS.filter((group) =>
    group.match
      ? tools.some((tool) => group.match?.test(tool.name))
      : mcpEnabled,
  ).map((group) => group.label);
}

export function AgentChatPanel({
  settings,
}: {
  settings: AgentSettings | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const capabilities = useMemo(
    () => capabilityLabels(tools, Boolean(settings?.mcp.endpoint)),
    [tools, settings?.mcp.endpoint],
  );

  useEffect(() => {
    let cancelled = false;
    getAiTools()
      .then((response) => {
        if (!cancelled) setTools(response.tools);
      })
      .catch(() => {
        // The capability line is informational: a failure here must not block
        // the chat itself.
        if (!cancelled) setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when transcript or busy state changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, busy]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setError(null);
    setBusy(true);
    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: prompt,
    };
    // The new prompt is sent once, in `prompt`; `messages` carries only the
    // history before it.
    const history = messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.content }));
    setMessages((previous) => [...previous, userMessage]);
    setInput("");
    try {
      const reply = await chatWithAi({ prompt, messages: history });
      setMessages((previous) => [
        ...previous,
        {
          id: reply.runId,
          role: "assistant",
          content: reply.text || "(пустой ответ)",
          reasoning: reply.reasoning,
          trace: reply.trace,
        },
      ]);
    } catch (sendError) {
      setError(aiErrorMessage(sendError));
    } finally {
      setBusy(false);
    }
  };

  const canSend = Boolean(input.trim()) && !busy;

  return (
    <div className="flex min-h-[420px] min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-3 py-2">
        <span className="text-[11px] font-medium text-zinc-300">
          Единый агент
        </span>
        <span
          className="min-w-0 text-[11px] text-zinc-500"
          title="Список собран из инструментов, которые реально отдаёт GET /ai/tools"
        >
          {tools === null
            ? "проверяю доступ…"
            : capabilities.length > 0
              ? `полный доступ: ${capabilities.join(", ")}`
              : "инструменты недоступны — проверьте настройки AI"}
        </span>
        <span className="text-[11px] text-zinc-500">
          {settings
            ? settings.dryRun
              ? "dryRun: изменения не уходят в Telegram"
              : "dryRun выключен"
            : "Настройки загружаются…"}
        </span>
        <button
          type="button"
          onClick={() => {
            setMessages([]);
            setError(null);
          }}
          disabled={busy}
          className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-40"
        >
          Новый диалог
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-400">
            <p className="mb-1 font-medium text-zinc-200">
              Один агент на всё приложение
            </p>
            <p className="mb-2 text-xs">
              У него полный доступ к приложению — без привязки к аккаунту или
              чату: аккаунты, души и память, навыки, автоматизации, MCP-серверы
              и логи. Он сам находит нужный аккаунт и чат по названию, юзернейму
              или id.
            </p>
            <ul className="list-disc space-y-1 pl-4 text-xs">
              <li>«Покажи все аккаунты и последние ошибки из логов»</li>
              <li>«Создай душу для аккаунта @…»: спокойный, ироничный</li>
              <li>«Покажи последние 5 сообщений в чате …»</li>
              <li>«Сделай навык для ответов клиентам и привяжи к душе»</li>
              <li>«Настрой автоматизацию: каждое утро сводка по чатам»</li>
            </ul>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] min-w-0 break-words rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                message.role === "user"
                  ? "bg-sky-600/90 text-white"
                  : "border border-zinc-800 bg-zinc-950/70 text-zinc-200"
              }`}
            >
              {message.reasoning && (
                <details className="mb-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                  <summary className="cursor-pointer list-none text-[10px] tracking-wide text-zinc-500 uppercase">
                    Размышления
                  </summary>
                  <div className="mt-1 max-h-48 overflow-y-auto text-[11px] whitespace-pre-wrap text-zinc-400">
                    {message.reasoning}
                  </div>
                </details>
              )}
              {message.content}
              {message.trace && message.trace.length > 0 && (
                <div className="mt-2 border-t border-zinc-800 pt-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                    Инструменты
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {message.trace.map((entry, index) => (
                      <span
                        key={`${entry.tool}-${index}`}
                        title={traceTitle(entry)}
                        className={`max-w-full break-all rounded px-1.5 py-0.5 font-mono text-[10px] ${
                          entry.error
                            ? "bg-red-950/60 text-red-300"
                            : entry.dryRun
                              ? "bg-amber-950/50 text-amber-300"
                              : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {entry.tool}
                        {entry.error
                          ? " · ошибка"
                          : entry.dryRun
                            ? " · dry-run"
                            : " · ок"}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div
            className="flex items-center gap-2 text-xs text-zinc-500"
            aria-live="polite"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
            Агент думает…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div
          role="alert"
          className="mx-3 mb-2 break-words rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300"
        >
          {error}
        </div>
      )}

      <div className="border-t border-zinc-800 p-3">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          aria-label="Сообщение агенту"
          placeholder="Напишите задачу агенту — он видит все аккаунты, души, навыки, автоматизации и логи. Enter — отправить, Shift+Enter — новая строка"
          className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
          autoComplete="off"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-500">
            {settings?.model
              ? `модель ${settings.model}`
              : "модель не настроена"}
          </span>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Отправка…" : "Отправить"}
          </button>
        </div>
      </div>
    </div>
  );
}
