"use client";

import { useRef, useState } from "react";
import {
  type AgentSettings,
  type AgentTraceEntry,
  chatWithAi,
} from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
import { useAppData } from "./app-data";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  trace?: AgentTraceEntry[];
}

export function AgentChatPanel({
  settings,
}: {
  settings: AgentSettings | null;
}) {
  const { accounts } = useAppData();
  const [accountId, setAccountId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

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
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    try {
      const reply = await chatWithAi({
        prompt,
        accountId: accountId || null,
        messages: nextMessages
          .filter(
            (message) =>
              message.role === "user" || message.role === "assistant",
          )
          .slice(-12)
          .map((message) => ({
            role: message.role,
            content: message.content,
          })),
      });
      setMessages((previous) => [
        ...previous,
        {
          id: reply.runId,
          role: "assistant",
          content: reply.text || "(пустой ответ)",
          trace: reply.trace,
        },
      ]);
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        endRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
  };

  return (
    <div className="flex h-[calc(100dvh-9.5rem)] min-h-[420px] flex-col rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <select
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-500"
        >
          <option value="">Все аккаунты</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {accountName(account)}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-zinc-500">
          {settings?.dryRun
            ? "dryRun: изменения не уходят в Telegram"
            : "dryRun выключен"}
        </span>
        <button
          type="button"
          onClick={() => {
            setMessages([]);
            setError(null);
          }}
          className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
        >
          Новый диалог
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-400">
            <p className="mb-2 font-medium text-zinc-200">
              Спросите агента или попросите настроить
            </p>
            <ul className="list-disc space-y-1 pl-4 text-xs">
              <li>«Создай душу для этого аккаунта: спокойный, ироничный»</li>
              <li>«Покажи последние 5 сообщений в чате …»</li>
              <li>«Сделай скилл для ответов клиентам и привяжи к душе»</li>
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
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                message.role === "user"
                  ? "bg-sky-600/90 text-white"
                  : "border border-zinc-800 bg-zinc-950/70 text-zinc-200"
              }`}
            >
              {message.content}
              {message.trace && message.trace.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 border-t border-zinc-800 pt-2">
                  {message.trace.map((entry, index) => (
                    <span
                      key={`${entry.tool}-${index}`}
                      title={
                        entry.error ?? (entry.dryRun ? "dry-run" : "выполнено")
                      }
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        entry.error
                          ? "bg-red-950/60 text-red-300"
                          : entry.dryRun
                            ? "bg-amber-950/50 text-amber-300"
                            : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {entry.tool}
                      {entry.error ? " ✕" : entry.dryRun ? " dry" : " ✓"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
            Агент думает…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
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
          placeholder="Напишите задачу агенту… Enter — отправить, Shift+Enter — новая строка"
          className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">
            {settings?.model
              ? `модель ${settings.model}`
              : "модель не настроена"}
          </span>
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}
