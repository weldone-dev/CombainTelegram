"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
import {
  ATTEMPT_STATUS_LABELS,
  attemptErrorText,
  cancelTdlibMigration,
  deleteCloudPassword,
  fetchCloudPassword,
  getTdlibMigration,
  isAttemptSettled,
  saveCloudPassword,
  startTdlibMigration,
  submitTdlibMigrationPassword,
  TDLIB_POLL_INTERVAL_MS,
} from "../../lib/tdlib-api";
import type { AccountView, AttemptView } from "../../lib/types";
import { EngineBadge } from "../engine-badge";

/**
 * Account settings for the native engine: migrate an existing mtcute session
 * to TDLib and manage the encrypted 2FA password used by migrations.
 */
export function TdlibAccountPanel({
  account,
  onClose,
  onMigrated,
  onNotice,
}: {
  account: AccountView;
  onClose: () => void;
  onMigrated: () => void;
  onNotice: (message: string) => void;
}) {
  const tdlibSessions = account.sessions.filter(
    (session) => !session.revokedAt && session.engine === "tdlib",
  );
  const hasTdlib = tdlibSessions.length > 0;

  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationPassword, setMigrationPassword] = useState("");
  const completionNotified = useRef<string | null>(null);

  const [cloudStored, setCloudStored] = useState<boolean | null>(null);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudEditing, setCloudEditing] = useState(false);
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);

  const loadCloud = useCallback(async () => {
    setCloudLoading(true);
    setCloudError(null);
    try {
      const view = await fetchCloudPassword(account.id);
      setCloudStored(view.stored);
    } catch (loadError) {
      setCloudError(errorMessage(loadError));
    } finally {
      setCloudLoading(false);
    }
  }, [account.id]);

  useEffect(() => {
    void loadCloud();
  }, [loadCloud]);

  const applyMigration = useCallback(
    (view: AttemptView) => {
      setAttempt(view);
      if (view.status !== "ready") return;
      setMigrationPassword("");
      if (completionNotified.current === view.attemptId) return;
      completionNotified.current = view.attemptId;
      onNotice(`Аккаунт ${accountName(account)} переведён на TDLib`);
      onMigrated();
    },
    [account, onMigrated, onNotice],
  );

  const attemptId = attempt?.attemptId ?? null;
  const attemptStatus = attempt?.status ?? null;
  const polling =
    attemptStatus === "starting" || attemptStatus === "qr_pending";

  useEffect(() => {
    if (!attemptId || !polling) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void getTdlibMigration(account.id, attemptId)
        .then((view) => {
          if (!cancelled) applyMigration(view);
        })
        .catch((pollError: unknown) => {
          if (!cancelled) setMigrationError(errorMessage(pollError));
        });
    }, TDLIB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [account.id, attemptId, polling, applyMigration]);

  const startMigration = async () => {
    setMigrationBusy(true);
    setMigrationError(null);
    setMigrationPassword("");
    try {
      applyMigration(await startTdlibMigration(account.id));
    } catch (startError) {
      setMigrationError(errorMessage(startError));
    } finally {
      setMigrationBusy(false);
    }
  };

  const submitMigrationPassword = async () => {
    if (!attemptId) return;
    setMigrationBusy(true);
    setMigrationError(null);
    try {
      applyMigration(
        await submitTdlibMigrationPassword(
          account.id,
          attemptId,
          migrationPassword,
        ),
      );
    } catch (passwordError) {
      setMigrationError(errorMessage(passwordError));
    } finally {
      setMigrationBusy(false);
    }
  };

  const cancelMigration = async () => {
    if (attemptId) {
      try {
        await cancelTdlibMigration(account.id, attemptId);
      } catch {
        // Cancelling is best effort; the attempt expires on the server.
      }
    }
    setAttempt(null);
    setMigrationPassword("");
    setMigrationError(null);
  };

  const saveCloud = async () => {
    if (!cloudPassword) return;
    setCloudBusy(true);
    setCloudError(null);
    try {
      const view = await saveCloudPassword(account.id, cloudPassword);
      setCloudStored(view.stored);
      setCloudPassword("");
      setCloudEditing(false);
      onNotice("Пароль 2FA сохранён в зашифрованном виде");
    } catch (saveError) {
      setCloudError(errorMessage(saveError));
    } finally {
      setCloudBusy(false);
    }
  };

  const removeCloud = async () => {
    const confirmed = window.confirm(
      "Удалить сохранённый пароль двухэтапной проверки?\n\nОн будет стёрт из зашифрованного хранилища на сервере. Пароль в самом Telegram останется прежним.",
    );
    if (!confirmed) return;
    setCloudBusy(true);
    setCloudError(null);
    try {
      const view = await deleteCloudPassword(account.id);
      setCloudStored(view.stored);
      setCloudEditing(false);
      setCloudPassword("");
      onNotice("Сохранённый пароль 2FA удалён");
    } catch (deleteError) {
      setCloudError(errorMessage(deleteError));
    } finally {
      setCloudBusy(false);
    }
  };

  const awaitingPassword =
    attempt?.status === "awaiting_password" || attempt?.needsPassword === true;
  const attemptError = attemptErrorText(attempt?.error);
  const inProgress = attempt !== null && !isAttemptSettled(attempt.status);
  const finished = attempt?.status === "ready";

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 truncate text-sm font-semibold text-zinc-100">
            TDLib · {accountName(account)}
            {hasTdlib && <EngineBadge engine="tdlib" active />}
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Настройки нативного движка TDLib для этого аккаунта.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть настройки TDLib"
          className="shrink-0 rounded-md px-2 py-0.5 text-lg leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          ×
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
          <h4 className="text-sm font-medium text-zinc-100">
            Перевод на TDLib
          </h4>

          {hasTdlib ? (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-emerald-300">
                Аккаунт уже работает на TDLib. Эта сессия используется как
                основной транспорт.
              </p>
              <p className="text-xs text-zinc-500">
                Переводить больше ничего не нужно. Остальные сессии остаются
                доступными без повторного входа.
              </p>
            </div>
          ) : finished ? (
            <p className="mt-2 text-sm text-emerald-300">
              Аккаунт переведён на TDLib. Список аккаунтов обновляется.
            </p>
          ) : inProgress || attempt ? (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-zinc-300">
                {awaitingPassword
                  ? "Telegram запрашивает пароль двухэтапной проверки."
                  : ATTEMPT_STATUS_LABELS[attempt?.status ?? "starting"]}
              </p>
              <p className="text-xs text-zinc-500">
                QR-код подтверждается автоматически: сканировать ничего не
                нужно. Текущая сессия продолжает работать, пока переход не
                завершится.
              </p>

              {awaitingPassword && (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={migrationPassword}
                    onChange={(event) =>
                      setMigrationPassword(event.target.value)
                    }
                    placeholder="Пароль двухэтапной проверки"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    name="ct-tdlib-migration-password"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => void submitMigrationPassword()}
                    disabled={migrationBusy || !migrationPassword}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    {migrationBusy ? "Проверка…" : "Подтвердить пароль"}
                  </button>
                </div>
              )}

              {(attemptError || migrationError) && (
                <p className="text-sm text-red-300">
                  {migrationError ?? attemptError}
                </p>
              )}

              {attempt?.status === "failed" || attempt?.status === "expired" ? (
                <button
                  type="button"
                  onClick={() => void startMigration()}
                  disabled={migrationBusy}
                  className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                >
                  {migrationBusy ? "Запуск…" : "Повторить переход"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void cancelMigration()}
                  className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                >
                  Отменить переход
                </button>
              )}
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-zinc-400">
                Переведите текущую сессию на нативный движок TDLib. Пока идёт
                переход, существующая сессия продолжает работать — ничего не
                отключается.
              </p>
              <p className="text-xs text-zinc-500">
                Telegram подтвердит вход автоматически. Данные аккаунта и
                история сохранятся.
              </p>
              {migrationError && (
                <p className="text-sm text-red-300">{migrationError}</p>
              )}
              <button
                type="button"
                onClick={() => void startMigration()}
                disabled={migrationBusy}
                className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
              >
                {migrationBusy ? "Запуск…" : "Перевести на TDLib"}
              </button>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium text-zinc-100">
              Пароль двухэтапной проверки
            </h4>
            {cloudStored !== null && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  cloudStored
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-zinc-700/60 text-zinc-300"
                }`}
              >
                {cloudStored ? "сохранён" : "не сохранён"}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Пароль хранится в зашифрованном виде и никогда не записывается в
            логи. Он нужен только для перевода сессии на TDLib.
          </p>

          {cloudLoading ? (
            <p className="mt-2 text-sm text-zinc-500">Проверяем…</p>
          ) : (
            <div className="mt-2 space-y-2">
              {cloudError && (
                <p className="text-sm text-red-300">{cloudError}</p>
              )}

              {cloudEditing ? (
                <>
                  <input
                    type="password"
                    value={cloudPassword}
                    onChange={(event) => setCloudPassword(event.target.value)}
                    placeholder="Пароль Telegram (2FA)"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    name="ct-tdlib-cloud-password"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void saveCloud()}
                      disabled={cloudBusy || !cloudPassword}
                      className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                    >
                      {cloudBusy ? "Сохранение…" : "Сохранить"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCloudEditing(false);
                        setCloudPassword("");
                      }}
                      disabled={cloudBusy}
                      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
                    >
                      Отмена
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCloudEditing(true);
                      setCloudError(null);
                    }}
                    className="rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
                  >
                    {cloudStored ? "Заменить пароль" : "Сохранить пароль"}
                  </button>
                  {cloudStored && (
                    <button
                      type="button"
                      onClick={() => void removeCloud()}
                      disabled={cloudBusy}
                      className="rounded-md border border-red-900/60 px-3 py-2 text-sm text-red-300 hover:border-red-600 disabled:opacity-40"
                    >
                      Удалить
                    </button>
                  )}
                </div>
              )}

              {cloudError && cloudStored === null && (
                <button
                  type="button"
                  onClick={() => void loadCloud()}
                  className="text-xs text-sky-400 hover:text-sky-300"
                >
                  Повторить запрос
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
