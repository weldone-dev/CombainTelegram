"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type AiProviderLimitsView,
  type AiProviderModelsView,
  type AiProviderTestResult,
  type AiProviderUsageMeter,
  type AiProviderView,
  aiErrorMessage,
  getAiProviderLimits,
  getAiProviderModels,
  updateAiProviderLimits,
  updateAiProviderModels,
} from "../../lib/ai-api";
import {
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
} from "../dashboard/ai-ui";

interface ProviderRowProps {
  provider: AiProviderView;
  busy: boolean;
  testing: boolean;
  test?: AiProviderTestResult;
  onDefault: () => void;
  onToggle: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => Promise<void>;
}

function parseModelList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function formatReset(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function meterTone(percent: number, status: string): string {
  if (status === "rate-limited" || percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-400";
  return "bg-sky-500";
}

export function AiProviderRow({
  provider,
  busy,
  testing,
  test,
  onDefault,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  onChanged,
}: ProviderRowProps) {
  const [modelsView, setModelsView] = useState<AiProviderModelsView | null>(
    null,
  );
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [chosenModel, setChosenModel] = useState(provider.defaultModel ?? "");
  const [manualModels, setManualModels] = useState(provider.models.join(", "));

  const [limitsView, setLimitsView] = useState<AiProviderLimitsView | null>(
    null,
  );
  const [limitsBusy, setLimitsBusy] = useState(false);
  const [limitsSaving, setLimitsSaving] = useState(false);
  const [limitsStatus, setLimitsStatus] = useState<string | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [maxPerHour, setMaxPerHour] = useState(
    String(provider.limits?.maxPerHour ?? 0),
  );
  const [maxPerDay, setMaxPerDay] = useState(
    String(provider.limits?.maxPerDay ?? 0),
  );

  const loadModels = useCallback(async () => {
    setModelsBusy(true);
    setModelError(null);
    try {
      const view = await getAiProviderModels(provider.id);
      setModelsView(view);
      setManualModels(view.models.map((model) => model.id).join(", "));
    } catch (loadError) {
      setModelError(aiErrorMessage(loadError));
    } finally {
      setModelsBusy(false);
    }
  }, [provider.id]);

  const loadLimits = useCallback(async () => {
    setLimitsBusy(true);
    setLimitsError(null);
    try {
      const view = await getAiProviderLimits(provider.id);
      setLimitsView(view);
      setMaxPerHour(String(view.limits?.maxPerHour ?? 0));
      setMaxPerDay(String(view.limits?.maxPerDay ?? 0));
    } catch (loadError) {
      setLimitsError(aiErrorMessage(loadError));
    } finally {
      setLimitsBusy(false);
    }
  }, [provider.id]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    void loadLimits();
  }, [loadLimits]);

  useEffect(() => {
    setChosenModel(provider.defaultModel ?? "");
  }, [provider.defaultModel]);

  useEffect(() => {
    setMaxPerHour(String(provider.limits?.maxPerHour ?? 0));
    setMaxPerDay(String(provider.limits?.maxPerDay ?? 0));
  }, [provider.limits?.maxPerHour, provider.limits?.maxPerDay]);

  const chatModels = (modelsView?.models ?? []).filter(
    (model) => !model.type || model.type === "chat",
  );
  const chatModelIds = chatModels.map((model) => model.id);
  const allModelIds =
    modelsView?.models.map((model) => model.id) ?? provider.models;
  const selectIds =
    chosenModel && !chatModelIds.includes(chosenModel)
      ? [chosenModel, ...chatModelIds]
      : chatModelIds;

  const saveDefaultModel = async (value: string) => {
    if (!value) return;
    setChosenModel(value);
    setModelSaving(true);
    setModelError(null);
    setModelStatus(null);
    try {
      const models = allModelIds.length > 0 ? allModelIds : [value];
      await updateAiProviderModels(provider.id, {
        models,
        defaultModel: value,
      });
      await onChanged();
      setModelStatus("Модель по умолчанию сохранена");
    } catch (saveError) {
      setModelError(aiErrorMessage(saveError));
      setChosenModel(provider.defaultModel ?? "");
    } finally {
      setModelSaving(false);
    }
  };

  const saveManualModels = async () => {
    const models = parseModelList(manualModels);
    if (models.length === 0) {
      setModelError("Укажите хотя бы одну модель через запятую");
      return;
    }
    setModelSaving(true);
    setModelError(null);
    setModelStatus(null);
    try {
      const nextDefault = models.includes(chosenModel)
        ? chosenModel
        : models[0];
      await updateAiProviderModels(provider.id, {
        models,
        defaultModel: nextDefault,
      });
      setChosenModel(nextDefault);
      setModelsView({ models: models.map((id) => ({ id })), source: "stored" });
      await onChanged();
      setModelStatus("Ручной список моделей сохранён");
    } catch (saveError) {
      setModelError(aiErrorMessage(saveError));
    } finally {
      setModelSaving(false);
    }
  };

  const saveLimits = async () => {
    const hour = Number(maxPerHour);
    const day = Number(maxPerDay);
    if (
      !Number.isSafeInteger(hour) ||
      hour < 0 ||
      !Number.isSafeInteger(day) ||
      day < 0
    ) {
      setLimitsError("Лимиты — целые числа от 0 (0 = без лимита)");
      return;
    }
    setLimitsSaving(true);
    setLimitsError(null);
    setLimitsStatus(null);
    try {
      const result = await updateAiProviderLimits(provider.id, {
        maxPerHour: hour,
        maxPerDay: day,
      });
      setLimitsView((previous) =>
        previous ? { ...previous, limits: result.limits } : previous,
      );
      await onChanged();
      setLimitsStatus("Лимиты сохранены");
    } catch (saveError) {
      setLimitsError(aiErrorMessage(saveError));
    } finally {
      setLimitsSaving(false);
    }
  };

  const isOpencode = provider.preset === "opencode-go";
  const usage = limitsView?.usage;
  const meterRows: Array<{ label: string; meter: AiProviderUsageMeter }> = [];
  if (usage?.rolling)
    meterRows.push({ label: "5 часов", meter: usage.rolling });
  if (usage?.weekly) meterRows.push({ label: "Неделя", meter: usage.weekly });
  if (usage?.monthly) meterRows.push({ label: "Месяц", meter: usage.monthly });

  return (
    <li
      className={`rounded-lg border p-3 ${
        provider.enabled
          ? "border-zinc-800 bg-zinc-950/40"
          : "border-zinc-800/60 bg-zinc-950/20 opacity-80"
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-zinc-200">
              {provider.name}
            </span>
            {provider.isDefault && <Pill tone="sky">по умолчанию</Pill>}
            {isOpencode && <Pill tone="green">OpenCode Go</Pill>}
            <Pill
              tone={
                provider.keySource === "opencode" || provider.hasKey
                  ? "green"
                  : "red"
              }
            >
              {provider.keySource === "opencode"
                ? "токен OpenCode"
                : provider.hasKey
                  ? "ключ задан"
                  : "ключ не задан"}
            </Pill>
            <Pill>{provider.kind}</Pill>
            {!provider.enabled && <Pill tone="amber">выключен</Pill>}
          </div>
          <p
            className="mt-1 truncate font-mono text-[11px] text-zinc-500"
            title={provider.baseUrl}
          >
            {provider.baseUrl}
          </p>
          {provider.models.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {provider.models.slice(0, 6).map((model) => (
                <Pill
                  key={model}
                  tone={model === provider.defaultModel ? "sky" : "zinc"}
                >
                  {model}
                </Pill>
              ))}
              {provider.models.length > 6 && (
                <Pill>+{provider.models.length - 6}</Pill>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400"
            title="Выключенный провайдер не используется для запросов"
          >
            <input
              type="checkbox"
              checked={provider.enabled}
              disabled={busy}
              onChange={onToggle}
              aria-label={`Провайдер ${provider.name} включён`}
              autoComplete="off"
              className="h-3.5 w-3.5 accent-sky-500"
            />
            включён
          </label>
          {!provider.isDefault && (
            <GhostButton onClick={onDefault} disabled={busy}>
              По умолчанию
            </GhostButton>
          )}
          <GhostButton onClick={onTest} disabled={busy}>
            {testing ? "Проверка…" : "Проверить"}
          </GhostButton>
          <GhostButton onClick={onEdit} disabled={busy}>
            Изменить
          </GhostButton>
          <GhostButton onClick={onDelete} disabled={busy} danger>
            Удалить
          </GhostButton>
        </div>
      </div>

      {testing && (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent"
          />
          Проверяем соединение…
        </p>
      )}
      {!testing && test && (
        <p
          className={`mt-2 break-words text-[11px] ${
            test.ok ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {test.ok
            ? `ok · HTTP ${test.status ?? "—"} · ${test.latencyMs} мс`
            : `Ошибка${test.status ? ` (HTTP ${test.status})` : ""}: ${
                test.error ?? "провайдер не ответил"
              }`}
        </p>
      )}

      <div className="mt-3 border-t border-zinc-800 pt-3">
        <ErrorBanner message={modelError} />
        <OkBanner message={modelStatus} />
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Модель по умолчанию"
            hint={
              modelsView
                ? `${
                    modelsView.source === "provider"
                      ? "Список с провайдера"
                      : "Сохранённый список"
                  }${modelsView.cached ? " · кэш" : ""}`
                : "Загрузка списка…"
            }
            className="min-w-56 flex-1"
          >
            <select
              value={chosenModel}
              onChange={(event) => void saveDefaultModel(event.target.value)}
              disabled={modelSaving || selectIds.length === 0}
              autoComplete="off"
              name={`ct-provider-model-${provider.id}`}
              className={inputClass}
            >
              {selectIds.length === 0 && <option value="">Нет моделей</option>}
              {selectIds.map((id) => {
                const info = chatModels.find((model) => model.id === id);
                return (
                  <option key={id} value={id}>
                    {info?.label ?? id}
                  </option>
                );
              })}
            </select>
          </Field>
          <GhostButton
            onClick={() => void loadModels()}
            disabled={modelsBusy || modelSaving}
          >
            {modelsBusy ? "Загрузка…" : "Обновить список"}
          </GhostButton>
        </div>

        {modelsView?.error && (
          <p className="mt-2 break-words text-[11px] text-amber-300">
            {modelsView.source === "stored"
              ? "Провайдер недоступен, показан сохранённый список: "
              : ""}
            {modelsView.error}
          </p>
        )}

        {modelsView !== null &&
          (modelsView.source === "stored" || chatModels.length === 0) && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field
                label="Ручной список моделей"
                hint="Через запятую — для провайдеров без /models"
                className="min-w-56 flex-1"
              >
                <input
                  value={manualModels}
                  onChange={(event) => setManualModels(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  name={`ct-provider-models-${provider.id}`}
                  className={`${inputClass} font-mono text-xs`}
                  placeholder="model-one, model-two"
                />
              </Field>
              <GhostButton
                onClick={() => void saveManualModels()}
                disabled={modelSaving}
              >
                Сохранить список
              </GhostButton>
            </div>
          )}
      </div>

      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
            Лимиты
            {limitsView && (
              <Pill>
                {limitsView.source === "provider" ? "по провайдеру" : "вручную"}
              </Pill>
            )}
            {limitsView?.observed && (
              <span className="text-zinc-500">
                · за час {limitsView.observed.lastHour} · за сутки{" "}
                {limitsView.observed.lastDay}
              </span>
            )}
          </p>
          <GhostButton
            onClick={() => void loadLimits()}
            disabled={limitsBusy || limitsSaving}
          >
            {limitsBusy ? "Обновление…" : "Обновить лимиты"}
          </GhostButton>
        </div>

        {meterRows.length > 0 && (
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {meterRows.map(({ label, meter }) => {
              const reset = formatReset(meter.resetsAt);
              return (
                <div key={label} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-zinc-400">{label}</span>
                    <span className="text-zinc-300">{meter.percent}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full rounded-full ${meterTone(
                        meter.percent,
                        meter.status,
                      )}`}
                      style={{ width: `${meter.percent}%` }}
                    />
                  </div>
                  <p className="mt-1 truncate text-[10px] text-zinc-500">
                    {reset ? `сброс ${reset}` : "срок сброса неизвестен"}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {limitsView?.error && (
          <p className="mt-2 break-words text-[11px] text-amber-300">
            {limitsView.error}
          </p>
        )}

        <ErrorBanner message={limitsError} />
        <OkBanner message={limitsStatus} />

        {!isOpencode && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Запросов в час" className="w-36">
              <input
                value={maxPerHour}
                onChange={(event) => setMaxPerHour(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                name={`ct-provider-max-hour-${provider.id}`}
                className={inputClass}
              />
            </Field>
            <Field label="Запросов в сутки" className="w-36">
              <input
                value={maxPerDay}
                onChange={(event) => setMaxPerDay(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                name={`ct-provider-max-day-${provider.id}`}
                className={inputClass}
              />
            </Field>
            <GhostButton
              onClick={() => void saveLimits()}
              disabled={limitsSaving}
            >
              {limitsSaving ? "Сохранение…" : "Сохранить лимиты"}
            </GhostButton>
          </div>
        )}
      </div>
    </li>
  );
}
