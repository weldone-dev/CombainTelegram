"use client";

import { useState } from "react";
import {
  type AiProviderTestResult,
  type AiProviderView,
  type AiReasoningEffort,
  aiErrorMessage,
  createAiProvider,
  deleteAiProvider,
  importAiSettings,
  setDefaultAiProvider,
  testAiProvider,
  updateAiProvider,
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
  Toggle,
} from "../dashboard/ai-ui";

type Pending =
  | { kind: "create" }
  | { kind: "import" }
  | { kind: "default" | "delete" | "toggle" | "test"; id: string }
  | null;

interface FormState {
  name: string;
  baseUrl: string;
  models: string;
  defaultModel: string;
  reasoningEffort: AiReasoningEffort;
  apiKey: string;
  isDefault: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  baseUrl: "",
  models: "",
  defaultModel: "",
  reasoningEffort: "low",
  apiKey: "",
  isDefault: false,
};

function parseModels(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * Real provider list backed by `/ai/providers`. The legacy single-provider
 * settings block stays read-only below this card while the list is empty.
 */
export function AiProvidersCard({
  providers,
  loading,
  error,
  onRefresh,
}: {
  providers: AiProviderView[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pending, setPending] = useState<Pending>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, AiProviderTestResult>>({});

  const busy = pending !== null;

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setActionError(null);
  };

  const openCreate = () => {
    setFormOpen(true);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setActionError(null);
    setStatus(null);
  };

  const openEdit = (provider: AiProviderView) => {
    setFormOpen(true);
    setEditingId(provider.id);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models.join(", "),
      defaultModel: provider.defaultModel ?? "",
      reasoningEffort: provider.reasoningEffort,
      apiKey: "",
      isDefault: provider.isDefault,
    });
    setActionError(null);
    setStatus(null);
  };

  const submit = async () => {
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const defaultModel = form.defaultModel.trim();
    const models = parseModels(form.models);
    if (!name) {
      setActionError("Укажите название провайдера");
      return;
    }
    if (!baseUrl || !isHttpUrl(baseUrl)) {
      setActionError(
        "Base URL обязателен и должен начинаться с http:// или https://",
      );
      return;
    }
    if (models.length === 0 && !defaultModel) {
      setActionError("Добавьте хотя бы одну модель или модель по умолчанию");
      return;
    }

    setPending({ kind: "create" });
    setActionError(null);
    setStatus(null);
    try {
      const body: Record<string, unknown> = {
        name,
        baseUrl,
        models,
        defaultModel: defaultModel || null,
        reasoningEffort: form.reasoningEffort,
        isDefault: form.isDefault,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };
      if (editingId) {
        await updateAiProvider(editingId, body);
        setStatus(`Провайдер «${name}» сохранён`);
      } else {
        await createAiProvider({ ...body, enabled: true });
        setStatus(`Провайдер «${name}» добавлен`);
      }
      closeForm();
      await onRefresh();
    } catch (submitError) {
      setActionError(aiErrorMessage(submitError));
    } finally {
      setPending(null);
    }
  };

  const setDefault = async (provider: AiProviderView) => {
    setPending({ kind: "default", id: provider.id });
    setActionError(null);
    setStatus(null);
    try {
      await setDefaultAiProvider(provider.id);
      await onRefresh();
      setStatus(`«${provider.name}» назначен провайдером по умолчанию`);
    } catch (defaultError) {
      setActionError(aiErrorMessage(defaultError));
    } finally {
      setPending(null);
    }
  };

  const toggleEnabled = async (provider: AiProviderView) => {
    setPending({ kind: "toggle", id: provider.id });
    setActionError(null);
    setStatus(null);
    try {
      await updateAiProvider(provider.id, { enabled: !provider.enabled });
      await onRefresh();
      setStatus(
        `«${provider.name}» ${provider.enabled ? "выключен" : "включён"}`,
      );
    } catch (toggleError) {
      setActionError(aiErrorMessage(toggleError));
    } finally {
      setPending(null);
    }
  };

  const runTest = async (provider: AiProviderView) => {
    setPending({ kind: "test", id: provider.id });
    setActionError(null);
    setStatus(null);
    try {
      const result = await testAiProvider(provider.id);
      setTests((previous) => ({ ...previous, [provider.id]: result }));
    } catch (testError) {
      setActionError(aiErrorMessage(testError));
    } finally {
      setPending(null);
    }
  };

  const remove = async (provider: AiProviderView) => {
    if (
      !window.confirm(
        `Удалить провайдера «${provider.name}»? Если он по умолчанию, API назначит другого.`,
      )
    ) {
      return;
    }
    setPending({ kind: "delete", id: provider.id });
    setActionError(null);
    setStatus(null);
    try {
      const result = await deleteAiProvider(provider.id);
      await onRefresh();
      const promotedName =
        result.promotedId === null
          ? null
          : (providers.find((item) => item.id === result.promotedId)?.name ??
            result.promotedId);
      setStatus(
        promotedName
          ? `Провайдер «${provider.name}» удалён. По умолчанию теперь «${promotedName}».`
          : `Провайдер «${provider.name}» удалён.`,
      );
    } catch (deleteError) {
      setActionError(aiErrorMessage(deleteError));
    } finally {
      setPending(null);
    }
  };

  const importCurrent = async () => {
    setPending({ kind: "import" });
    setActionError(null);
    setStatus(null);
    try {
      const result = await importAiSettings();
      await onRefresh();
      setStatus(
        result.created
          ? "Провайдер создан из текущих настроек"
          : "Импортировать нечего: текущие настройки пусты или провайдеры уже есть",
      );
    } catch (importError) {
      setActionError(aiErrorMessage(importError));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card
      title="Провайдеры"
      description="OpenAI-совместимые LLM. По умолчанию используется первый включённый провайдер с бейджем."
      actions={
        <PrimaryButton onClick={openCreate} disabled={busy || formOpen}>
          Добавить провайдера
        </PrimaryButton>
      }
    >
      <ErrorBanner message={error} />
      <ErrorBanner message={actionError} />
      <OkBanner message={status} />

      {formOpen && (
        <ProviderForm
          editing={editingId !== null}
          form={form}
          onChange={setForm}
          onSubmit={submit}
          onCancel={closeForm}
          busy={busy}
        />
      )}

      {loading && providers.length === 0 ? (
        <p className="text-sm text-zinc-500">Загрузка провайдеров…</p>
      ) : providers.length === 0 ? (
        !formOpen && (
          <div className="rounded-lg border border-dashed border-zinc-700 p-4">
            <p className="text-sm text-zinc-300">Провайдеров пока нет.</p>
            <p className="mt-1 text-xs text-zinc-500">
              Добавьте провайдера вручную или импортируйте текущие настройки
              модели. Пока список пуст, работает устаревший блок ниже.
            </p>
            <div className="mt-3">
              <GhostButton onClick={() => void importCurrent()} disabled={busy}>
                {pending?.kind === "import"
                  ? "Импорт…"
                  : "Импортировать текущие настройки"}
              </GhostButton>
            </div>
          </div>
        )
      ) : (
        <ul className="grid gap-2">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              pending={pending}
              test={tests[provider.id]}
              onDefault={() => void setDefault(provider)}
              onToggle={() => void toggleEnabled(provider)}
              onTest={() => void runTest(provider)}
              onEdit={() => openEdit(provider)}
              onDelete={() => void remove(provider)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProviderForm({
  editing,
  form,
  onChange,
  onSubmit,
  onCancel,
  busy,
}: {
  editing: boolean;
  form: FormState;
  onChange: (form: FormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const update = (patch: Partial<FormState>) => onChange({ ...form, ...patch });

  return (
    <div className="mb-3 rounded-lg border border-sky-900/50 bg-sky-950/10 p-3">
      <p className="mb-3 text-xs font-medium text-zinc-200">
        {editing ? "Изменить провайдера" : "Новый провайдер"}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Название">
          <input
            value={form.name}
            onChange={(event) => update({ name: event.target.value })}
            className={inputClass}
            placeholder="DeepSeek"
          />
        </Field>
        <Field label="Base URL" hint="Например https://api.deepseek.com/v1">
          <input
            value={form.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            className={inputClass}
            placeholder="https://api.deepseek.com/v1"
          />
        </Field>
        <Field
          label="Модели"
          hint="Через запятую или с новой строки"
          className="sm:col-span-2"
        >
          <textarea
            value={form.models}
            onChange={(event) => update({ models: event.target.value })}
            className={`${inputClass} min-h-16 resize-y font-mono text-xs`}
            placeholder="deepseek-chat, deepseek-reasoner"
          />
        </Field>
        <Field
          label="Модель по умолчанию"
          hint="Можно не указывать, если есть список моделей"
        >
          <input
            value={form.defaultModel}
            onChange={(event) => update({ defaultModel: event.target.value })}
            className={inputClass}
            placeholder="deepseek-chat"
          />
        </Field>
        <Field label="Размышления модели">
          <select
            value={form.reasoningEffort}
            onChange={(event) =>
              update({
                reasoningEffort: event.target.value as AiReasoningEffort,
              })
            }
            className={inputClass}
          >
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
        <Field
          label={editing ? "Заменить API-ключ" : "API-ключ (необязательно)"}
          hint={
            editing
              ? "Пустое поле оставляет сохранённый ключ."
              : "Можно добавить позже. Ключ не отображается."
          }
          className="sm:col-span-2"
        >
          <input
            type="password"
            value={form.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            autoComplete="off"
            className={inputClass}
            placeholder={editing ? "новый ключ (необязательно)" : "sk-…"}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Toggle
          checked={form.isDefault}
          onChange={(value) => update({ isDefault: value })}
          label="Сделать провайдером по умолчанию"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <PrimaryButton onClick={onSubmit} disabled={busy}>
          {busy ? "Сохранение…" : "Сохранить"}
        </PrimaryButton>
        <GhostButton onClick={onCancel} disabled={busy}>
          Отмена
        </GhostButton>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  pending,
  test,
  onDefault,
  onToggle,
  onTest,
  onEdit,
  onDelete,
}: {
  provider: AiProviderView;
  pending: Pending;
  test?: AiProviderTestResult;
  onDefault: () => void;
  onToggle: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const busy = pending !== null;
  const testing = pending?.kind === "test" && pending.id === provider.id;
  const modelList =
    provider.defaultModel && !provider.models.includes(provider.defaultModel)
      ? [provider.defaultModel, ...provider.models]
      : provider.models;

  return (
    <li
      className={`rounded-lg border p-3 ${
        provider.enabled
          ? "border-zinc-800 bg-zinc-950/40"
          : "border-zinc-800/60 bg-zinc-950/20 opacity-70"
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-zinc-200">
              {provider.name}
            </span>
            {provider.isDefault && <Pill tone="sky">по умолчанию</Pill>}
            <Pill tone={provider.hasKey ? "green" : "red"}>
              {provider.hasKey ? "ключ задан" : "ключ не задан"}
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
          {modelList.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {modelList.map((model) => (
                <Pill
                  key={model}
                  tone={model === provider.defaultModel ? "sky" : "zinc"}
                >
                  {model}
                </Pill>
              ))}
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
    </li>
  );
}
