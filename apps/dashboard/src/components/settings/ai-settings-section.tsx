"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type AiProviderView,
  type AiSettings,
  aiErrorMessage,
  getAiSettings,
  getAiTools,
  listAiProviders,
  patchAiSettings,
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
  PrimaryButton,
} from "../dashboard/ai-ui";
import { AiMcpCard } from "./ai-mcp-card";
import { AiPermissionsCard } from "./ai-permissions-card";
import { AiProvidersCard } from "./ai-providers-card";

type SttEngine = "auto" | "parakeet" | "whisper" | "remote";

const KEY_SOURCE_LABELS: Record<AiSettings["apiKeySource"], string> = {
  opencode: "OpenCode / Orca",
  env: "переменная AI_API_KEY в .env",
  db: "сохранён в базе (зашифрован)",
  none: "не задан",
};

const STT_ENGINES: Array<{ value: SttEngine; label: string }> = [
  { value: "auto", label: "auto — сервер решает" },
  { value: "parakeet", label: "parakeet — локально" },
  { value: "whisper", label: "whisper — локально" },
  { value: "remote", label: "remote — удалённый сервис" },
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
          Провайдеры, модель по умолчанию, лимиты и распознавание речи. Души,
          скиллы и автоматизации остаются на странице «AI».
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
          <LimitsCard />
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
            className={inputClass}
          />
        </Field>
        <Field label="Base URL">
          <input
            readOnly
            value={settings.baseUrl}
            onFocus={(event) => event.currentTarget.select()}
            className={inputClass}
          />
        </Field>
        <Field label="Модель">
          <input
            readOnly
            value={settings.model}
            onFocus={(event) => event.currentTarget.select()}
            className={inputClass}
          />
        </Field>
        <Field label="Быстрая модель">
          <input
            readOnly
            value={settings.fastModel}
            onFocus={(event) => event.currentTarget.select()}
            className={inputClass}
          />
        </Field>
        <Field label="Температура">
          <input
            readOnly
            value={String(settings.temperature)}
            className={inputClass}
          />
        </Field>
        <Field label="Максимум шагов агента">
          <input
            readOnly
            value={String(settings.maxSteps)}
            className={inputClass}
          />
        </Field>
        <Field label="Размышления модели">
          <input
            readOnly
            value={REASONING_LABELS[settings.reasoningEffort]}
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

function LimitsCard() {
  const [hourly, setHourly] = useState("0");
  const [daily, setDaily] = useState("0");

  return (
    <Card
      title="Лимиты"
      description="Сколько запросов к модели разрешено с одного аккаунта. Ноль — без лимита."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Запросов в час">
          <input
            value={hourly}
            onChange={(event) => setHourly(event.target.value)}
            inputMode="numeric"
            className={inputClass}
          />
        </Field>
        <Field label="Запросов в сутки">
          <input
            value={daily}
            onChange={(event) => setDaily(event.target.value)}
            inputMode="numeric"
            className={inputClass}
          />
        </Field>
      </div>
      <DraftNote>
        Черновик: эндпоинт <code>/ai/settings</code> пока не принимает лимиты,
        поэтому значения не сохраняются. Поля готовы к подключению, когда API их
        добавит.
      </DraftNote>
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
  const apiExposesStt = settings.sttEngine !== undefined;
  const [engine, setEngine] = useState(settings.sttEngine ?? "auto");
  const [baseUrl, setBaseUrl] = useState(settings.sttBaseUrl ?? "");
  const [model, setModel] = useState(settings.sttModel ?? "");
  const [language, setLanguage] = useState(settings.sttLanguage ?? "auto");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only overwrite the local form when the API actually returns STT fields;
    // otherwise typed values must survive a settings refresh.
    if (settings.sttEngine !== undefined) setEngine(settings.sttEngine);
    if (settings.sttBaseUrl !== undefined) setBaseUrl(settings.sttBaseUrl);
    if (settings.sttModel !== undefined) setModel(settings.sttModel ?? "");
    if (settings.sttLanguage !== undefined) {
      setLanguage(settings.sttLanguage);
    }
  }, [settings]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    const body = {
      sttEngine: engine,
      sttBaseUrl: baseUrl.trim(),
      sttModel: model.trim() || null,
      sttLanguage: language.trim() || "auto",
    };
    try {
      const next = await patchAiSettings(body);
      // Keep the local draft; the effect above only overwrites it when the
      // server actually returns STT columns.
      onChange(next);
      setStatus(
        apiExposesStt
          ? "Настройки распознавания речи сохранены"
          : "Поля отправлены, но сервер пока не возвращает STT — сохранение не подтверждено",
      );
    } catch (saveError) {
      setError(aiErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const engineOptions = STT_ENGINES.some((item) => item.value === engine)
    ? STT_ENGINES
    : [...STT_ENGINES, { value: engine, label: engine }];

  return (
    <Card
      title="Распознавание речи"
      description="Движок транскрибации голосовых сообщений и встреч."
      actions={
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? "Сохранение…" : "Сохранить"}
        </PrimaryButton>
      }
    >
      <ErrorBanner message={error} />
      <OkBanner message={status} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Движок">
          <select
            value={engine}
            onChange={(event) => setEngine(event.target.value)}
            className={inputClass}
          >
            {engineOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Язык"
          hint="Код языка, например ru или en; auto — определять на месте."
        >
          <input
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            className={inputClass}
            placeholder="auto"
          />
        </Field>
        <Field
          label="Base URL удалённого сервиса"
          hint="Используется только движком remote."
        >
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className={inputClass}
            placeholder="https://stt.example.com/v1"
          />
        </Field>
        <Field label="Модель">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className={inputClass}
            placeholder="whisper-large-v3"
          />
        </Field>
      </div>
      {!apiExposesStt && (
        <DraftNote>
          Черновик: сервер пока не возвращает поля STT. Значения отправляются на
          API и остаются на этой странице, но могут не сохраниться до обновления
          серверной части.
        </DraftNote>
      )}
    </Card>
  );
}

function DraftNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 rounded-md border border-amber-900/50 bg-amber-950/20 px-2.5 py-1.5 text-[11px] text-amber-300">
      {children}
    </p>
  );
}
