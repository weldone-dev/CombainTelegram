"use client";

import { useEffect, useState } from "react";
import {
  type AiProviderPreset,
  type AiProviderTestResult,
  type AiProviderView,
  type AiReasoningEffort,
  aiErrorMessage,
  createAiProvider,
  deleteAiProvider,
  importAiSettings,
  listAiProviderPresets,
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
  PrimaryButton,
  Toggle,
} from "../dashboard/ai-ui";
import { AiProviderRow } from "./ai-provider-row";

type Pending =
  | { kind: "create" | "import" }
  | { kind: "default" | "delete" | "toggle" | "test"; id: string }
  | null;

interface FormState {
  preset: string;
  name: string;
  baseUrl: string;
  reasoningEffort: AiReasoningEffort;
  apiKey: string;
  isDefault: boolean;
}

/** Minimal fallback so the form still opens if `/presets` is unreachable. */
const FALLBACK_PRESETS: AiProviderPreset[] = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    kind: "openai-compatible",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    keySource: "opencode",
  },
  {
    id: "custom",
    name: "Свой провайдер",
    kind: "openai-compatible",
    baseUrl: "",
    keySource: "stored",
  },
];

const EMPTY_FORM: FormState = {
  preset: "custom",
  name: "",
  baseUrl: "",
  reasoningEffort: "low",
  apiKey: "",
  isDefault: false,
};

function formForPreset(
  presetId: string,
  presets: AiProviderPreset[],
): FormState {
  const preset = presets.find((item) => item.id === presetId);
  return {
    preset: presetId,
    name: preset?.name ?? "",
    baseUrl: preset?.baseUrl ?? "",
    reasoningEffort: "low",
    apiKey: "",
    isDefault: false,
  };
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
  const [presets, setPresets] = useState<AiProviderPreset[]>(FALLBACK_PRESETS);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AiProviderView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pending, setPending] = useState<Pending>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, AiProviderTestResult>>({});

  const busy = pending !== null;

  useEffect(() => {
    let cancelled = false;
    listAiProviderPresets()
      .then((list) => {
        if (!cancelled && list.length > 0) setPresets(list);
      })
      .catch(() => {
        // The fallback list keeps the form usable; creation still validates.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setActionError(null);
  };

  const openCreate = () => {
    setFormOpen(true);
    setEditing(null);
    setForm(formForPreset(presets[0]?.id ?? "opencode-go", presets));
    setActionError(null);
    setStatus(null);
  };

  const openEdit = (provider: AiProviderView) => {
    const presetId = provider.preset ?? "custom";
    setFormOpen(true);
    setEditing(provider);
    setForm({
      preset: presetId,
      name: provider.name,
      baseUrl: provider.baseUrl,
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
    const preset = presets.find((item) => item.id === form.preset);
    const opencode = preset?.keySource === "opencode";
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

    setPending({ kind: "create" });
    setActionError(null);
    setStatus(null);
    try {
      const body: Record<string, unknown> = {
        name,
        baseUrl,
        reasoningEffort: form.reasoningEffort,
        isDefault: form.isDefault,
        ...(opencode ? {} : { kind: preset?.kind ?? "openai-compatible" }),
        ...(!opencode && form.apiKey.trim()
          ? { apiKey: form.apiKey.trim() }
          : {}),
      };
      if (editing) {
        await updateAiProvider(editing.id, body);
        setStatus(`Провайдер «${name}» сохранён`);
      } else {
        await createAiProvider({
          ...body,
          preset: form.preset,
          enabled: true,
        });
        setStatus(
          `Провайдер «${name}» добавлен. Модель и лимиты — в карточке ниже.`,
        );
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
      description="OpenAI-совместимые LLM. Модель выбирается из списка провайдера, лимиты — у каждого провайдера свои."
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
          editing={editing}
          form={form}
          presets={presets}
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
              Добавьте OpenCode Go или своего провайдера. Пока список пуст,
              работает устаревший блок ниже.
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
            <AiProviderRow
              key={provider.id}
              provider={provider}
              busy={busy}
              testing={pending?.kind === "test" && pending.id === provider.id}
              test={tests[provider.id]}
              onDefault={() => void setDefault(provider)}
              onToggle={() => void toggleEnabled(provider)}
              onTest={() => void runTest(provider)}
              onEdit={() => openEdit(provider)}
              onDelete={() => void remove(provider)}
              onChanged={onRefresh}
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
  presets,
  onChange,
  onSubmit,
  onCancel,
  busy,
}: {
  editing: AiProviderView | null;
  form: FormState;
  presets: AiProviderPreset[];
  onChange: (form: FormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const update = (patch: Partial<FormState>) => onChange({ ...form, ...patch });
  const preset = presets.find((item) => item.id === form.preset);
  const opencode = preset?.keySource === "opencode";
  const editOpencode = editing?.keySource === "opencode";

  return (
    <div className="mb-3 rounded-lg border border-sky-900/50 bg-sky-950/10 p-3">
      <p className="mb-3 text-xs font-medium text-zinc-200">
        {editing ? "Изменить провайдера" : "Новый провайдер"}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {!editing && (
          <Field
            label="Тип провайдера"
            hint="OpenCode Go берёт токен из OpenCode, ключ не нужен."
            className="sm:col-span-2"
          >
            <select
              value={form.preset}
              onChange={(event) =>
                onChange(formForPreset(event.target.value, presets))
              }
              autoComplete="off"
              name="ct-provider-preset"
              className={inputClass}
            >
              {presets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id === "custom" ? "Свой провайдер" : item.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {editing && (
          <p className="text-[11px] text-zinc-400 sm:col-span-2">
            Тип: {editOpencode ? "OpenCode Go" : "Свой провайдер"}
          </p>
        )}

        <Field label="Название">
          <input
            value={form.name}
            onChange={(event) => update({ name: event.target.value })}
            autoComplete="off"
            name="ct-provider-name"
            className={inputClass}
            placeholder="Мой провайдер"
          />
        </Field>
        <Field
          label="Base URL"
          hint={
            opencode || editOpencode
              ? "Задан пресетом OpenCode Go"
              : "Например https://api.deepseek.com/v1"
          }
        >
          <input
            value={form.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            readOnly={opencode || editOpencode}
            autoComplete="off"
            spellCheck={false}
            name="ct-provider-base-url"
            className={inputClass}
            placeholder="https://api.deepseek.com/v1"
          />
        </Field>

        {!opencode && !editOpencode && (
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
              spellCheck={false}
              name="ct-provider-secret"
              className={inputClass}
              placeholder={editing ? "новый ключ (необязательно)" : "sk-…"}
            />
          </Field>
        )}

        {(opencode || editOpencode) && (
          <p className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5 text-[11px] text-zinc-400 sm:col-span-2">
            API-ключ не запрашивается: используется токен OpenCode/Orca на этом
            компьютере.
          </p>
        )}
      </div>

      <p className="mt-3 text-[11px] text-zinc-500">
        Модель выбирается в карточке провайдера после сохранения — отдельно для
        каждого провайдера.
      </p>

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
