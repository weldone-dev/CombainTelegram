"use client";

import { useEffect, useMemo, useState } from "react";
import {
  aiErrorMessage,
  getAccountVariables,
  saveAccountVariables,
  VARIABLES_MAX_BYTES,
  VARIABLES_MAX_KEYS,
  VARIABLES_MAX_VALUE_CHARS,
} from "../../lib/ai-api";
import {
  Card,
  ErrorBanner,
  GhostButton,
  inputClass,
  OkBanner,
  PrimaryButton,
} from "./ai-ui";

interface VariableRow {
  id: number;
  key: string;
  value: string;
}

let nextRowId = 1;

function rowsOf(variables: Record<string, string>): VariableRow[] {
  return Object.entries(variables).map(([key, value]) => ({
    id: nextRowId++,
    key,
    value,
  }));
}

/** Only rows with a name become variables; an untouched empty row is ignored. */
function variablesOf(rows: VariableRow[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    variables[key] = row.value;
  }
  return variables;
}

/** Order-independent snapshot used for the dirty check. */
function snapshot(variables: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(variables)
      .sort()
      .map((key) => [key, variables[key]]),
  );
}

/**
 * «Переменные» tab of the account AI dialog: free-form strings that n8n reads
 * from the event payload as `account.variables`. The API replaces the whole
 * object, so the editor always sends what is on screen.
 */
export function AccountAiVariables({
  accountId,
  active,
  onNotice,
}: {
  accountId: string;
  /** The dialog keeps tabs mounted; load only once the tab is opened. */
  active: boolean;
  onNotice?: (message: string) => void;
}) {
  const [rows, setRows] = useState<VariableRow[]>([]);
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey retries a failed load
  useEffect(() => {
    if (!active || loaded) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAccountVariables(accountId)
      .then((result) => {
        if (cancelled) return;
        setRows(rowsOf(result.variables));
        setInitial(result.variables);
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(aiErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, active, loaded, reloadKey]);

  const variables = useMemo(() => variablesOf(rows), [rows]);
  const changed = snapshot(variables) !== snapshot(initial);

  const rowErrors = useMemo(() => {
    const result: Record<number, string> = {};
    const duplicates = new Map<string, number[]>();
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) {
        if (row.value.trim()) result[row.id] = "Укажите имя переменной";
        continue;
      }
      duplicates.set(key, [...(duplicates.get(key) ?? []), row.id]);
      if ([...row.value].length > VARIABLES_MAX_VALUE_CHARS) {
        result[row.id] =
          `Значение длиннее ${VARIABLES_MAX_VALUE_CHARS} символов`;
      }
    }
    for (const [key, ids] of duplicates) {
      if (ids.length < 2) continue;
      for (const id of ids) result[id] = `Имя «${key}» повторяется`;
    }
    return result;
  }, [rows]);

  const globalError = useMemo(() => {
    if (Object.keys(variables).length > VARIABLES_MAX_KEYS) {
      return `Не больше ${VARIABLES_MAX_KEYS} переменных`;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(variables)).length;
    if (bytes > VARIABLES_MAX_BYTES) {
      return `Слишком большой объём: ${bytes} из ${VARIABLES_MAX_BYTES} байт`;
    }
    return null;
  }, [variables]);

  const hasErrors = Object.keys(rowErrors).length > 0 || globalError !== null;
  const visibleError = (row: VariableRow) =>
    showErrors || rowErrors[row.id] !== undefined
      ? rowErrors[row.id]
      : undefined;

  const update = (id: number, patch: Partial<Omit<VariableRow, "id">>) => {
    setRows((previous) =>
      previous.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
    setStatus(null);
  };

  const addRow = () => {
    setShowErrors(false);
    setRows((previous) => [
      ...previous,
      { id: nextRowId++, key: "", value: "" },
    ]);
    setStatus(null);
  };

  const removeRow = (id: number) => {
    setRows((previous) => previous.filter((row) => row.id !== id));
    setStatus(null);
  };

  const reset = () => {
    setRows(rowsOf(initial));
    setShowErrors(false);
    setError(null);
    setStatus("Изменения отменены");
  };

  const save = async () => {
    if (saving) return;
    setShowErrors(true);
    setError(null);
    setStatus(null);
    if (hasErrors) {
      setError("Проверьте переменные, отмеченные красным.");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveAccountVariables(accountId, variables);
      setRows(rowsOf(saved.variables));
      setInitial(saved.variables);
      setStatus("Переменные сохранены");
      onNotice?.("Переменные аккаунта сохранены");
    } catch (caught) {
      // Edits stay in the form so the user can fix and retry.
      setError(aiErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const saveButtons = (
    <>
      <GhostButton onClick={reset} disabled={saving || !changed}>
        Сбросить
      </GhostButton>
      <PrimaryButton onClick={() => void save()} disabled={saving || !loaded}>
        {saving ? "Сохранение…" : "Сохранить"}
      </PrimaryButton>
    </>
  );

  return (
    <Card
      title="Переменные"
      description="Свободные строки, которые workflow читает из события n8n как account.variables — удобно для таймзоны, подписи или стиля."
      actions={
        <div className="flex flex-wrap items-center gap-2">{saveButtons}</div>
      }
    >
      <div className="min-w-0 space-y-3">
        {error && <ErrorBanner message={error} />}
        {status && <OkBanner message={status} />}
        {changed && (
          <p
            aria-live="polite"
            className="break-words rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200"
          >
            <span className="font-medium">Есть несохранённые изменения.</span>{" "}
            Сохраните, чтобы n8n увидел новые значения.
          </p>
        )}

        <p className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 text-[11px] text-zinc-500">
          До {VARIABLES_MAX_KEYS} переменных, значения до{" "}
          {VARIABLES_MAX_VALUE_CHARS} символов. Не храните здесь пароли, токены
          и другие секреты: значения попадают в события n8n.
        </p>

        {loading && !loaded && (
          <p className="text-sm text-zinc-500" aria-live="polite">
            Загрузка переменных…
          </p>
        )}

        {!loading && !loaded && error && (
          <GhostButton onClick={() => setReloadKey((key) => key + 1)}>
            Повторить
          </GhostButton>
        )}

        {loaded && (
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="rounded-md border border-dashed border-zinc-800 px-3 py-3 text-center text-[11px] text-zinc-500">
                Переменных пока нет. Добавьте первую — например timezone со
                значением Europe/Moscow.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="hidden gap-2 px-0.5 text-[11px] text-zinc-500 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                  <span>Имя</span>
                  <span>Значение</span>
                  <span className="w-7" aria-hidden="true" />
                </div>
                {rows.map((row, index) => {
                  const rowError = visibleError(row);
                  return (
                    <div
                      key={row.id}
                      className="grid min-w-0 gap-2 rounded-md border border-zinc-800 px-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
                    >
                      <label className="block min-w-0 text-[11px] text-zinc-500">
                        <span className="block sm:hidden">Имя</span>
                        <input
                          autoComplete="off"
                          spellCheck={false}
                          value={row.key}
                          aria-label={`Имя переменной ${index + 1}`}
                          aria-invalid={Boolean(rowError)}
                          placeholder="timezone"
                          onChange={(event) =>
                            update(row.id, { key: event.target.value })
                          }
                          className={`${inputClass} ${
                            rowError
                              ? "border-red-700 focus:border-red-500"
                              : ""
                          }`}
                        />
                      </label>
                      <label className="block min-w-0 text-[11px] text-zinc-500">
                        <span className="block sm:hidden">Значение</span>
                        <textarea
                          autoComplete="off"
                          spellCheck={false}
                          value={row.value}
                          aria-label={`Значение переменной ${index + 1}`}
                          placeholder="Europe/Moscow"
                          onChange={(event) =>
                            update(row.id, { value: event.target.value })
                          }
                          className={`${inputClass} min-h-[2.25rem] resize-y ${
                            rowError
                              ? "border-red-700 focus:border-red-500"
                              : ""
                          }`}
                        />
                      </label>
                      <div className="flex items-start justify-end sm:justify-center">
                        <button
                          type="button"
                          onClick={() => removeRow(row.id)}
                          title="Удалить переменную"
                          aria-label={`Удалить переменную ${row.key || index + 1}`}
                          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-red-700 hover:text-red-300"
                        >
                          ×
                        </button>
                      </div>
                      {rowError && (
                        <p className="text-[11px] text-red-300 sm:col-span-3">
                          {rowError}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {globalError && (
              <p role="alert" className="text-[11px] text-red-300">
                {globalError}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <GhostButton
                onClick={addRow}
                disabled={rows.length >= VARIABLES_MAX_KEYS}
              >
                Добавить переменную
              </GhostButton>
              <span className="text-[11px] text-zinc-500">
                Уже добавлено: {Object.keys(variables).length} из{" "}
                {VARIABLES_MAX_KEYS}
              </span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 pt-3">
          {saveButtons}
        </div>
      </div>
    </Card>
  );
}
