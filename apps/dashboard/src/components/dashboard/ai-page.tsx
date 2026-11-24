"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type AiSettings,
  aiErrorMessage,
  getAiSettings,
} from "../../lib/ai-api";
import { AgentChatPanel } from "./ai-agent-chat";
import { AutomationsPanel } from "./ai-automations";
import { BotsPanel } from "./ai-bots";
import { SkillsPanel } from "./ai-skills";
import { SoulsPanel } from "./ai-souls";
import { ErrorBanner } from "./ai-ui";

type Tab = "agent" | "souls" | "skills" | "automations" | "bots";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "agent", label: "Агент" },
  { id: "souls", label: "Души" },
  { id: "skills", label: "Скиллы" },
  { id: "automations", label: "Автоматизации" },
  { id: "bots", label: "Боты" },
];

/**
 * Agent-facing AI workspace. Provider, model, permissions and MCP live in
 * «Настройки → AI»; this page only needs the current settings to show a small
 * model status badge and to pass them to the agent chat.
 */
export function AiPage() {
  const [tab, setTab] = useState<Tab>("agent");
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setSettings(await getAiSettings());
    } catch (loadError) {
      setError(aiErrorMessage(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-800 px-4 py-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-pressed={tab === item.id}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              tab === item.id
                ? "bg-sky-500/15 font-medium text-sky-300"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
          {settings && (
            <>
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  settings.hasApiKey && settings.baseUrl
                    ? "bg-emerald-400"
                    : "bg-red-400"
                }`}
              />
              {settings.model || "модель не задана"}
            </>
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <ErrorBanner message={error} />}
        {loading && !settings ? (
          <p className="text-sm text-zinc-500">Загрузка…</p>
        ) : (
          <>
            {tab === "agent" && (
              <div className="flex h-full min-h-0 flex-col">
                <AgentChatPanel settings={settings} />
              </div>
            )}
            {tab === "souls" && <SoulsPanel />}
            {tab === "skills" && <SkillsPanel />}
            {tab === "automations" && <AutomationsPanel />}
            {tab === "bots" && <BotsPanel />}
          </>
        )}
      </div>
    </div>
  );
}
