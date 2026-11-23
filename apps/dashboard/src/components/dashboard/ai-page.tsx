"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AiCapabilities,
  type AiCapability,
  type AiSettings,
  getAiSettings,
  getAiTools,
  mcpEndpoint,
  rotateMcpToken,
  type ToolInfo,
  testAi,
  updateAiPolicy,
  updateAiSettings,
} from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
import { AgentChatPanel } from "./ai-agent-chat";
import { AutomationsPanel } from "./ai-automations";
import { BotsPanel } from "./ai-bots";
import { SkillsPanel } from "./ai-skills";
import { SoulsPanel } from "./ai-souls";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
  PrimaryButton,
  Toggle,
} from "./ai-ui";
import { useAppData } from "./app-data";

type Tab = "agent" | "souls" | "skills" | "automations" | "bots" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "agent", label: "Агент" },
  { id: "souls", label: "Души" },
  { id: "skills", label: "Скиллы" },
  { id: "automations", label: "Автоматизации" },
  { id: "bots", label: "Боты" },
  { id: "settings", label: "Настройки" },
];

const CAPABILITY_LABELS: Record<AiCapability, string> = {
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

const CAPABILITY_HINTS: Partial<Record<AiCapability, string>> = {
  send: "Без этого ИИ и MCP не могут отправлять сообщения от имени аккаунта.",
  sendUnknown:
    "По умолчанию выключено: писать можно только в чаты, где уже есть диалог.",
  delete: "Удаление сообщений у всех. Включайте осознанно.",
  admin: "Участники, баны, ссылки-приглашения. Очень опасное право.",
  policy: "Позволяет ИИ менять собственные разрешения.",
  mcp: "Полный выключатель внешнего доступа по HTTP.",
};

export function AiPage() {
  const [tab, setTab] = useState<Tab>("agent");
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextTools] = await Promise.all([
        getAiSettings(),
        getAiTools(),
      ]);
      setSettings(nextSettings);
      setTools(nextTools.tools);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-800 px-4 py-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
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
            {tab === "agent" && <AgentChatPanel settings={settings} />}
            {tab === "souls" && <SoulsPanel />}
            {tab === "skills" && <SkillsPanel />}
            {tab === "automations" && <AutomationsPanel />}
            {tab === "bots" && <BotsPanel />}
            {tab === "settings" && settings && (
              <SettingsPanel
                settings={settings}
                tools={tools}
                onChange={setSettings}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function parseNumberList(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item !== 0);
}

function SettingsPanel({
  settings,
  tools,
  onChange,
}: {
  settings: AiSettings;
  tools: ToolInfo[];
  onChange: (settings: AiSettings) => void;
}) {
  const { accounts } = useAppData();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [fastModel, setFastModel] = useState(settings.fastModel);
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState(String(settings.temperature));
  const [maxSteps, setMaxSteps] = useState(String(settings.maxSteps));
  const [capabilities, setCapabilities] = useState<AiCapabilities>(
    settings.capabilities,
  );
  const [dryRun, setDryRun] = useState(settings.dryRun);
  const [allowAccountIds, setAllowAccountIds] = useState<string[]>(
    settings.allowAccountIds,
  );
  const [allowChats, setAllowChats] = useState(
    settings.allowChatIds.join(", "),
  );
  const [blockChats, setBlockChats] = useState(
    settings.blockChatIds.join(", "),
  );
  const [ownerIds, setOwnerIds] = useState(settings.ownerTgUserIds.join(", "));
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(settings.mcp.token);
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
    setFastModel(settings.fastModel);
    setTemperature(String(settings.temperature));
    setMaxSteps(String(settings.maxSteps));
    setCapabilities(settings.capabilities);
    setDryRun(settings.dryRun);
    setAllowAccountIds(settings.allowAccountIds);
    setAllowChats(settings.allowChatIds.join(", "));
    setBlockChats(settings.blockChatIds.join(", "));
    setOwnerIds(settings.ownerTgUserIds.join(", "));
    setToken(settings.mcp.token);
  }, [settings]);

  const saveProvider = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await updateAiSettings({
        baseUrl,
        model,
        fastModel,
        temperature: Number(temperature),
        maxSteps: Number(maxSteps),
        dryRun,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      onChange(next);
      setApiKey("");
      setStatus("Настройки модели сохранены");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await updateAiPolicy({
        capabilities,
        dryRun,
        allowAccountIds,
        allowChatIds: parseNumberList(allowChats),
        blockChatIds: parseNumberList(blockChats),
        ownerTgUserIds: parseNumberList(ownerIds),
      });
      const next = await getAiSettings();
      onChange(next);
      setStatus("Разрешения сохранены");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTestBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await testAi();
      setStatus(`Модель ответила: ${result.text.slice(0, 200)}`);
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTestBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await rotateMcpToken();
      setToken(next.token);
      setStatus("MCP-токен обновлён. Старые клиенты потеряют доступ.");
    } catch (rotateError) {
      setError(errorMessage(rotateError));
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

  const grouped = useMemo(() => {
    const groups = new Map<string, ToolInfo[]>();
    for (const tool of tools) {
      const list = groups.get(tool.capability) ?? [];
      list.push(tool);
      groups.set(tool.capability, list);
    }
    return [...groups.entries()];
  }, [tools]);

  return (
    <div className="grid max-w-5xl gap-4">
      <Card
        title="Модель"
        description="OpenAI-совместимый провайдер. Ключ хранится в .env или зашифрован в базе; в интерфейсе показывается только хвост."
        actions={
          <div className="flex gap-2">
            <GhostButton onClick={runTest} disabled={testBusy || busy}>
              {testBusy ? "Проверка…" : "Проверить"}
            </GhostButton>
            <PrimaryButton onClick={saveProvider} disabled={busy}>
              Сохранить
            </PrimaryButton>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Base URL" hint="Например https://api.deepseek.com/v1">
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className={inputClass}
              placeholder="https://api.deepseek.com/v1"
            />
          </Field>
          <Field label="Модель">
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className={inputClass}
              placeholder="deepseek-chat"
            />
          </Field>
          <Field label="Быстрая модель" hint="Для памяти и сводок">
            <input
              value={fastModel}
              onChange={(event) => setFastModel(event.target.value)}
              className={inputClass}
              placeholder="deepseek-chat"
            />
          </Field>
          <Field
            label="API-ключ"
            hint={
              settings.hasApiKey
                ? `Сейчас: ${settings.apiKeyHint ?? "сохранён"} (${settings.apiKeySource === "env" ? "из .env" : "из базы"})`
                : "Ключ ещё не задан"
            }
          >
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className={inputClass}
              placeholder="оставьте пустым, чтобы не менять"
            />
          </Field>
          <Field label="Температура">
            <input
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
              inputMode="decimal"
              className={inputClass}
            />
          </Field>
          <Field label="Максимум шагов агента">
            <input
              value={maxSteps}
              onChange={(event) => setMaxSteps(event.target.value)}
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Toggle
            checked={dryRun}
            onChange={setDryRun}
            label="dryRun — не отправлять в Telegram"
            hint="Инструменты отправки/редактирования/удаления только симулируются. Автоответ души работает отдельно и не зависит от этого флага."
          />
        </div>
        <div className="mt-3 space-y-2">
          {status && <OkBanner message={status} />}
          {error && <ErrorBanner message={error} />}
        </div>
      </Card>

      <Card
        title="Разрешения"
        description="Что ИИ и MCP-клиенты могут делать с аккаунтами. Пустые списки значат «без ограничений по этому измерению»."
        actions={
          <PrimaryButton onClick={savePolicy} disabled={busy}>
            Сохранить разрешения
          </PrimaryButton>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(CAPABILITY_LABELS) as AiCapability[]).map((key) => (
            <Toggle
              key={key}
              checked={capabilities[key]}
              onChange={(value) =>
                setCapabilities((previous) => ({
                  ...previous,
                  [key]: value,
                }))
              }
              label={CAPABILITY_LABELS[key]}
              hint={CAPABILITY_HINTS[key]}
            />
          ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-zinc-400">Аккаунты</p>
            <div className="space-y-1.5 rounded-md border border-zinc-800 p-2">
              {accounts.length === 0 && (
                <p className="text-xs text-zinc-500">Нет аккаунтов</p>
              )}
              {accounts.map((account) => {
                const checked =
                  allowAccountIds.length === 0 ||
                  allowAccountIds.includes(account.id);
                return (
                  <label
                    key={account.id}
                    className="flex items-center gap-2 text-xs text-zinc-300"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        const others = allowAccountIds.filter(
                          (id) => id !== account.id,
                        );
                        setAllowAccountIds(
                          event.target.checked
                            ? [...others, account.id]
                            : others.length > 0
                              ? others
                              : [],
                        );
                      }}
                      className="h-3.5 w-3.5 accent-sky-500"
                    />
                    {accountName(account)}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Пусто = все аккаунты.
            </p>
          </div>
          <div className="space-y-2">
            <Field label="Разрешённые чаты (id через запятую)">
              <input
                value={allowChats}
                onChange={(event) => setAllowChats(event.target.value)}
                className={inputClass}
                placeholder="пусто = разрешённые по умолчанию"
              />
            </Field>
            <Field label="Запрещённые чаты">
              <input
                value={blockChats}
                onChange={(event) => setBlockChats(event.target.value)}
                className={inputClass}
                placeholder="например 123456789"
              />
            </Field>
            <Field
              label="Owner Telegram id (для ботов)"
              hint="Пусто = владельцы всех аккаунтов"
            >
              <input
                value={ownerIds}
                onChange={(event) => setOwnerIds(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card
        title="MCP-сервер"
        description="Streamable HTTP, JSON-RPC 2.0. Подключите Claude Desktop, Codex, Orca или свой агент."
        actions={
          <div className="flex gap-2">
            <GhostButton onClick={copyToken}>Скопировать токен</GhostButton>
            <GhostButton onClick={() => void rotate()} disabled={busy} danger>
              Перевыпустить
            </GhostButton>
          </div>
        }
      >
        <div className="space-y-2">
          <Field label="Endpoint">
            <input readOnly value={endpoint} className={inputClass} />
          </Field>
          <Field label="Bearer token">
            <input
              readOnly
              value={token}
              onFocus={(event) => event.currentTarget.select()}
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
      "headers": { "Authorization": "Bearer ${token.slice(0, 8)}…" }
    }
  }
}`}</pre>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setToolsOpen((value) => !value)}
          className="mt-3 text-xs text-sky-400 hover:text-sky-300"
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
    </div>
  );
}
