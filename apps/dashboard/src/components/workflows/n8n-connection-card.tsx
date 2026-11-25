"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_N8N_BASE_URL,
  type N8nConnectionSettings,
  type N8nTestResult,
  n8nBase,
  patchN8nSettings,
  testN8n,
  workflowErrorMessage,
} from "../../lib/workflows-api";
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

/**
 * n8n connectivity card: address + API key stored through `PATCH /ai/settings`.
 * The key is never returned by the API, so the field is write-only ("задан"
 * means it is stored; pasting a value replaces it).
 */
export function N8nConnectionCard({
  settings,
  onSaved,
  onTested,
}: {
  settings: N8nConnectionSettings;
  onSaved: (settings: N8nConnectionSettings) => void;
  /** Lets the page refresh the n8n workflow list after a successful probe. */
  onTested?: (result: N8nTestResult) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.n8nBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<N8nTestResult | null>(null);

  useEffect(() => {
    setBaseUrl(settings.n8nBaseUrl);
    setRemoveKey(false);
  }, [settings.n8nBaseUrl]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const trimmedKey = apiKey.trim();
      const next = await patchN8nSettings({
        n8nBaseUrl: baseUrl.trim(),
        ...(removeKey
          ? { n8nApiKey: null }
          : trimmedKey
            ? { n8nApiKey: trimmedKey }
            : {}),
      });
      setApiKey("");
      setRemoveKey(false);
      onSaved(next);
      setStatus("Подключение n8n сохранено");
    } catch (saveError) {
      setError(workflowErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTestBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await testN8n();
      setTestResult(result);
      onTested?.(result);
    } catch (testError) {
      setTestResult(null);
      setError(workflowErrorMessage(testError));
    } finally {
      setTestBusy(false);
    }
  };

  const openBase = n8nBase(baseUrl);

  return (
    <Card
      title="Подключение n8n"
      description="Адрес и API-ключ вашего n8n. Ключ хранится зашифрованным и никогда не возвращается в браузер."
      actions={
        <div className="flex flex-wrap gap-2">
          <a
            href={openBase}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Открыть n8n
          </a>
          <GhostButton
            onClick={() => void runTest()}
            disabled={busy || testBusy}
          >
            {testBusy ? "Проверка…" : "Проверить"}
          </GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={busy}>
            {busy ? "Сохранение…" : "Сохранить"}
          </PrimaryButton>
        </div>
      }
    >
      <ErrorBanner message={error} />
      <OkBanner message={status} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Base URL"
          hint={`По умолчанию ${DEFAULT_N8N_BASE_URL}. Пустое поле сбрасывает адрес.`}
        >
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            name="ct-n8n-base-url"
            className={inputClass}
            placeholder={DEFAULT_N8N_BASE_URL}
          />
        </Field>
        <Field
          label="API-ключ"
          hint={
            settings.hasN8nKey
              ? "Ключ задан. Вставьте новый, чтобы заменить; пустое поле его не трогает."
              : "Создайте ключ в n8n: Settings → API."
          }
        >
          <input
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              if (event.target.value) setRemoveKey(false);
            }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            name="ct-n8n-api-key"
            className={inputClass}
            placeholder={settings.hasN8nKey ? "ключ задан" : "вставьте ключ"}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Pill tone={settings.hasN8nKey ? "green" : "amber"}>
          {settings.hasN8nKey ? "ключ задан" : "ключ не задан"}
        </Pill>
        {settings.hasN8nKey && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={removeKey}
              onChange={(event) => setRemoveKey(event.target.checked)}
              autoComplete="off"
              className="h-3.5 w-3.5 accent-sky-500"
            />
            убрать сохранённый ключ при сохранении
          </label>
        )}
        <span className="text-[11px] text-zinc-500">
          «Проверить» использует уже сохранённые адрес и ключ.
        </span>
      </div>

      {testResult && (
        <p
          aria-live="polite"
          className={`mt-3 break-words rounded-md border px-2.5 py-1.5 text-[11px] ${
            testResult.ok
              ? "border-emerald-900/50 bg-emerald-950/20 text-emerald-300"
              : "border-amber-900/50 bg-amber-950/20 text-amber-300"
          }`}
        >
          {testResult.ok ? "n8n отвечает" : "n8n недоступен"}
          {testResult.status ? ` · HTTP ${testResult.status}` : ""}
          {` · ${testResult.latencyMs} мс`}
          {testResult.error ? ` · ${testResult.error}` : ""}
        </p>
      )}
    </Card>
  );
}
