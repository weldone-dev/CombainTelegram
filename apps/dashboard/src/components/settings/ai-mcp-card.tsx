"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type AiCapability,
  type AiSettings,
  aiErrorMessage,
  mcpEndpoint,
  rotateMcpToken,
  type ToolInfo,
} from "../../lib/ai-api";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
} from "../dashboard/ai-ui";

const CAPABILITY_LABELS: Partial<Record<AiCapability, string>> = {
  read: "Чтение",
  send: "Отправка сообщений",
  sendUnknown: "Писать незнакомым",
  edit: "Редактирование",
  delete: "Удаление",
  react: "Реакции",
  admin: "Администрирование",
  souls: "Души и память",
  skills: "Скиллы",
  automations: "Автоматизации",
  bots: "Боты",
  policy: "Изменение разрешений",
  mcp: "MCP-доступ",
};

/**
 * MCP endpoint/token block. Moved out of `/ai` with the rest of the
 * configuration; the endpoint is derived from the API origin.
 */
export function AiMcpCard({
  settings,
  tools,
  onChange,
}: {
  settings: AiSettings;
  tools: ToolInfo[];
  onChange: (settings: AiSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(settings.mcp.token);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    setToken(settings.mcp.token);
  }, [settings.mcp.token]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ToolInfo[]>();
    for (const tool of tools) {
      const list = groups.get(tool.capability) ?? [];
      list.push(tool);
      groups.set(tool.capability, list);
    }
    return [...groups.entries()];
  }, [tools]);

  const rotate = async () => {
    if (
      !window.confirm(
        "Перевыпустить MCP-токен? Подключённые клиенты потеряют доступ, пока вы не вставите им новый токен.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await rotateMcpToken();
      setToken(next.token);
      // Keep the parent copy in sync so switching sections does not show the
      // old token again.
      onChange({ ...settings, mcp: { ...settings.mcp, token: next.token } });
      setTokenVisible(true);
      setStatus("MCP-токен обновлён. Старые клиенты потеряют доступ.");
    } catch (rotateError) {
      setError(aiErrorMessage(rotateError));
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setStatus("Токен скопирован");
    } catch {
      setError("Браузер не дал доступ к буферу обмена");
    }
  };

  const endpoint = mcpEndpoint();

  return (
    <Card
      title="MCP-сервер"
      description="Streamable HTTP, JSON-RPC 2.0. Подключите Claude Desktop, Codex, Orca или свой агент."
      actions={
        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={() => void copyToken()}>
            Скопировать токен
          </GhostButton>
          <GhostButton onClick={() => setTokenVisible((value) => !value)}>
            {tokenVisible ? "Скрыть токен" : "Показать токен"}
          </GhostButton>
          <GhostButton onClick={() => void rotate()} disabled={busy} danger>
            Перевыпустить
          </GhostButton>
        </div>
      }
    >
      <ErrorBanner message={error} />
      <OkBanner message={status} />
      <div className="space-y-2">
        <Field
          label="Endpoint"
          hint="Адрес API-сервера из NEXT_PUBLIC_API_URL; этот же origin использует дашборд."
        >
          <input
            readOnly
            value={endpoint}
            onFocus={(event) => event.currentTarget.select()}
            className={inputClass}
          />
        </Field>
        <Field
          label="Bearer token"
          hint="Передаётся в заголовке Authorization: Bearer …. Не публикуйте его."
        >
          <input
            readOnly
            type={tokenVisible ? "text" : "password"}
            value={token}
            onFocus={(event) => event.currentTarget.select()}
            autoComplete="off"
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
        <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-[11px] text-zinc-400">
          <p className="mb-1 font-medium text-zinc-300">Пример для клиента</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-zinc-400">{`{
  "mcpServers": {
    "combain-telegram": {
      "type": "http",
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer <токен из поля выше>" }
    }
  }
}`}</pre>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setToolsOpen((value) => !value)}
        className="mt-3 rounded text-xs text-sky-400 hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {toolsOpen
          ? "Скрыть инструменты"
          : `Показать инструменты (${tools.length})`}
      </button>
      {toolsOpen && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {grouped.map(([capability, list]) => (
            <div
              key={capability}
              className="rounded-md border border-zinc-800 p-2"
            >
              <p className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
                {CAPABILITY_LABELS[capability as AiCapability] ?? capability}
                <Pill>{list.length}</Pill>
              </p>
              <ul className="space-y-0.5">
                {list.map((tool) => (
                  <li
                    key={tool.name}
                    className="truncate font-mono text-[11px] text-zinc-400"
                    title={tool.description}
                  >
                    {tool.name}
                    {tool.write && (
                      <span className="ml-1 text-amber-400">✎</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
