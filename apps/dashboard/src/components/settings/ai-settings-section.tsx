"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type AiProviderView,
  type AiSettings,
  aiErrorMessage,
  getAiSettings,
  getAiTools,
  listAiProviders,
  patchAiSettings,
  type SttEngine,
  type SttTestResult,
  type ToolInfo,
  testStt,
} from "../../lib/ai-api";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
  PrimaryButton,
} from "../dashboard/ai-ui";
import { AiMcpCard } from "./ai-mcp-card";
import { AiPermissionsCard } from "./ai-permissions-card";
import { AiProvidersCard } from "./ai-providers-card";

const DEFAULT_STT_MODEL = "parakeet-tdt-0.6b-v3";

const KEY_SOURCE_LABELS: Record<AiSettings["apiKeySource"], string> = {
  opencode: "OpenCode / Orca",
  env: "переменная AI_API_KEY в .env",
  db: "сохранён в базе (зашифрован)",
  none: "не задан",
};

const STT_ENGINES: Array<{ value: SttEngine; label: string }> = [
  { value: "remote", label: "Удалённый" },
  { value: "local", label: "Локальный" },
  { value: "disabled", label: "Выключено" },
];

const REASONING_LABELS: Record<AiSettings["reasoningEffort"], string> = {
  off: "off — без размышлений",
  low: "low",
  medium: "medium",
  high: "high",
};

export function AiSettingsSection() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [providers, setProviders] = useState<AiProviderView[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextTools] = await Promise.all([
        getAiSettings(),
        getAiTools(),
      ]);
      setSettings(nextSettings);
      setTools(nextTools.tools);
    } catch (loadError) {
      setError(aiErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      setProviders(await listAiProviders());
      setProvidersError(null);
    } catch (loadError) {
      setProvidersError(aiErrorMessage(loadError));
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">AI</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Провайдеры, модели, лимиты и распознавание речи. Души, скиллы и
          автоматизации остаются на странице «AI».
        </p>
      </div>

      <ErrorBanner message={error} />

      {loading && !settings ? (
        <p className="text-sm text-zinc-500">Загрузка…</p>
      ) : settings ? (
        <>
          <AiProvidersCard
            providers={providers}
            loading={providersLoading}
            error={providersError}
            onRefresh={refreshProviders}
          />
          {providers.length === 0 && <LegacyProviderCard settings={settings} />}
          <SttCard settings={settings} onChange={setSettings} />
          <AiPermissionsCard settings={settings} onChange={setSettings} />
          <AiMcpCard settings={settings} tools={tools} onChange={setSettings} />
        </>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-sm text-zinc-400">
            Настройки AI недоступны. Проверьте, что API запущен и таблица
            настроек создана.
          </p>
          <div className="mt-3">
            <GhostButton onClick={() => void load()}>Повторить</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Read-only view of the legacy single-provider `AiSetting` fields. Those values
 * are still used while no provider row exists, so they stay visible as a
 * fallback — with the import action offered by the empty provider list above.
 */
function LegacyProviderCard({ settings }: { settings: AiSettings }) {
  return (
    <Card
      title="Устаревшие настройки"
      description="Единый провайдер из старой таблицы настроек. Он используется, только пока список провайдеров пуст. После импорта или добавления провайдера этот блок скрывается."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Провайдер">
          <input
            readOnly
            value={settings.provider}
            onFocus={(event) => event.currentTarget.select()}
            autoComplete="off"
            spellCheck={false}
            name="ct-legacy-provider-kind"
            className={inputClass}
          />
        </Field>
        <Field label="Base URL">
          <input
            readOnly
            value={settings.baseUrl}
            onFocus={(event) => event.currentTarget.select()}
            autoComplete="off"
            spellCheck={false}
            name="ct-legacy-provider-base-url"
            className={inputClass}
          />
        </Field>
        <Field label="Модель">
          <input
            readOnly
            value={settings.model}
            onFocus={(event) => event.currentTarget.select()}
            autoComplete="off"
            spellCheck={false}
            name="ct-legacy-provider-model"
            className={inputClass}
          />
        </Field>
        <Field label="Быстрая модель">
          <input
            readOnly
            value={settings.fastModel}
            onFocus={(event) => event.currentTarget.select()}
            autoComplete="off"
            spellCheck={false}
            name="ct-legacy-provider-fast-model"
            className={inputClass}
          />
        </Field>
        <Field label="Температура">
          <input
            readOnly
            value={String(settings.temperature)}
            autoComplete="off"
            name="ct-legacy-provider-temperature"
            className={inputClass}
          />
        </Field>
        <Field label="Максимум шагов агента">
          <input
            readOnly
            value={String(settings.maxSteps)}
            autoComplete="off"
            name="ct-legacy-provider-max-steps"
            className={inputClass}
          />
        </Field>
        <Field label="Размышления модели">
          <input
            readOnly
            value={REASONING_LABELS[settings.reasoningEffort]}
            autoComplete="off"
            name="ct-legacy-provider-reasoning"
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-zinc-200">API-ключ</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Источник: {KEY_SOURCE_LABELS[settings.apiKeySource]}. Значение не
            отображается.
          </p>
        </div>
        <Pill tone={settings.hasApiKey ? "green" : "red"}>
          {settings.hasApiKey ? "задан" : "не задан"}
        </Pill>
      </div>
    </Card>
  );
}

function SttCard({
  settings,
  onChange,
}: {
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
}) {
  const [engine, setEngine] = useState<SttEngine>(
    settings.sttEngine ?? "remote",
  );
  const [baseUrl, setBaseUrl] = useState(settings.sttBaseUrl ?? "");
  const [language, setLanguage] = useState(settings.sttLanguage ?? "auto");
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SttTestResult | null>(null);

  useEffect(() => {
    setEngine(settings.sttEngine ?? "remote");
    setBaseUrl(settings.sttBaseUrl ?? "");
    setLanguage(settings.sttLanguage ?? "auto");
  }, [settings.sttEngine, settings.sttBaseUrl, settings.sttLanguage]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await patchAiSettings({
        sttEngine: engine,
        sttModel: settings.sttModel ?? DEFAULT_STT_MODEL,
        sttLanguage: language.trim() || "auto",
        ...(engine === "remote" ? { sttBaseUrl: baseUrl.trim() } : {}),
      });
      onChange(next);
      setStatus("Настройки распознавания речи сохранены");
    } catch (saveError) {
      setError(aiErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTestBusy(true);
    setError(null);
    setStatus(null);
    try {
      setTestResult(await testStt());
    } catch (testError) {
      setError(aiErrorMessage(testError));
    } finally {
      setTestBusy(false);
    }
  };

  const model = settings.sttModel || DEFAULT_STT_MODEL;

  return (
    <Card
      title="Распознавание речи"
      description="Parakeet TDT 0.6B v3: удалённый сервис или локальная модель."
      actions={
        <div className="flex flex-wrap gap-2">
          <GhostButton
            onClick={() => void runTest()}
            disabled={busy || testBusy}
          >
            {testBusy ? "Проверка…" : "Проверить"}
          </GhostButton>
          <PrimaryButton onClick={save} disabled={busy}>
            {busy ? "Сохранение…" : "Сохранить"}
          </PrimaryButton>
        </div>
      }
    >
      <ErrorBanner message={error} />
      <OkBanner message={status} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Движок">
          <select
            value={engine}
            onChange={(event) => {
              setEngine(event.target.value as SttEngine);
              setTestResult(null);
            }}
            autoComplete="off"
            name="ct-stt-engine"
            className={inputClass}
          >
            {STT_ENGINES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Язык" hint="auto или код языка, например ru">
          <input
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            name="ct-stt-language"
            className={inputClass}
            placeholder="auto"
          />
        </Field>
        <Field label="Модель" hint="Фиксированная модель Parakeet">
          <input
            readOnly
            value={model}
            autoComplete="off"
            spellCheck={false}
            name="ct-stt-model"
            className={inputClass}
          />
        </Field>
        {engine === "remote" && (
          <Field
            label="Base URL удалённого сервиса"
            hint="Пусто — встроенный адрес из окружения."
          >
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              name="ct-stt-base-url"
              className={inputClass}
              placeholder="http://192.168.31.108:5092"
            />
          </Field>
        )}
      </div>

      {testResult && (
        <p
          className={`mt-3 break-words rounded-md border px-2.5 py-1.5 text-[11px] ${
            testResult.ok
              ? "border-emerald-900/50 bg-emerald-950/20 text-emerald-300"
              : "border-amber-900/50 bg-amber-950/20 text-amber-300"
          }`}
        >
          {testResult.ok ? "ok" : "Недоступно"}
          {" · "}
          {testResult.engine === "local" ? "локальный" : "удалённый"}
          {testResult.status ? ` · HTTP ${testResult.status}` : ""}
          {` · ${testResult.latencyMs} мс`}
          {testResult.detail ? ` · ${testResult.detail}` : ""}
        </p>
      )}
    </Card>
  );
}
