"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { accountName, activeSession, platformLabel } from "../../lib/format";
import {
  activateSession,
  deleteSession,
  fetchAccount,
  patchSession,
} from "../../lib/session-api";
import {
  ATTEMPT_STATUS_LABELS,
  attemptErrorText,
  cancelTdlibAuth,
  getTdlibAuth,
  startTdlibAuth,
  submitTdlibAuthCode,
  submitTdlibAuthPassword,
  TDLIB_POLL_INTERVAL_MS,
} from "../../lib/tdlib-api";
import type {
  AccountView,
  AttemptView,
  ProxyView,
  SessionView,
} from "../../lib/types";
import { EngineBadge } from "../engine-badge";

type AddMethod = "qr" | "phone";
type AddStep = "form" | "starting" | "qr" | "code" | "password" | "failed";

/** How a pending TDLib attempt is described in the wizard. */
function attemptHint(attempt: AttemptView | null): string {
  if (!attempt) return "";
  if (attempt.status === "awaiting_password" || attempt.needsPassword) {
    return "Нужен пароль двухэтапной проверки";
  }
  if (attempt.status === "awaiting_code") return "Ожидаем код из Telegram";
  return ATTEMPT_STATUS_LABELS[attempt.status];
}

/**
 * Per-session proxy assignment, transport selection, adding and deleting
 * sessions. An account may have several sessions, but exactly one of them is
 * the active transport used by chats, history and realtime.
 */
export function SessionsModal({
  account,
  proxies,
  onClose,
  onUpdated,
  onNotice,
  onAccountRemoved,
}: {
  account: AccountView;
  proxies: ProxyView[];
  onClose: () => void;
  onUpdated: (account: AccountView) => void;
  onNotice?: (message: string) => void;
  onAccountRemoved?: (accountId: string) => void;
}) {
  const [current, setCurrent] = useState(account);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const liveSessions = current.sessions.filter((session) => !session.revokedAt);
  const active = activeSession(current);
  const activeId = active?.id ?? null;
  const lastLiveSession = liveSessions.length <= 1;

  const [deleteTarget, setDeleteTarget] = useState<SessionView | null>(null);
  const [deleteRevoke, setDeleteRevoke] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addMethod, setAddMethod] = useState<AddMethod>("qr");
  const [addLabel, setAddLabel] = useState("");
  const [addProxyId, setAddProxyId] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addCode, setAddCode] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addAttempt, setAddAttempt] = useState<AttemptView | null>(null);
  const [addStep, setAddStep] = useState<AddStep>("form");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const addCompletingRef = useRef(false);

  const applyAccount = (updated: AccountView) => {
    setCurrent(updated);
    onUpdated(updated);
  };

  const assign = async (sessionId: string, proxyId: string) => {
    setBusySessionId(sessionId);
    setError(null);
    setNotice(null);
    try {
      applyAccount(
        await patchSession(current.id, sessionId, {
          proxyId: proxyId || null,
        }),
      );
    } catch (assignError) {
      setError(errorMessage(assignError));
    } finally {
      setBusySessionId(null);
    }
  };

  const makeActive = async (sessionId: string) => {
    setActivatingId(sessionId);
    setError(null);
    setNotice(null);
    try {
      applyAccount(await activateSession(current.id, sessionId));
      setNotice("Активная сессия переключена");
    } catch (activateError) {
      setError(errorMessage(activateError));
    } finally {
      setActivatingId(null);
    }
  };

  const openDelete = (session: SessionView) => {
    setDeleteTarget(session);
    setDeleteRevoke(false);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await deleteSession(
        current.id,
        deleteTarget.id,
        deleteRevoke,
      );
      if (result.accountRemoved) {
        onAccountRemoved?.(current.id);
        onNotice?.(
          `Аккаунт ${accountName(current)} удалён: не осталось сессий`,
        );
        onClose();
        return;
      }
      const fresh = await fetchAccount(current.id).catch(() => null);
      const updated: AccountView = fresh ?? {
        ...current,
        activeSessionId:
          current.activeSessionId === deleteTarget.id
            ? null
            : current.activeSessionId,
        sessions: current.sessions.filter(
          (session) => session.id !== deleteTarget.id,
        ),
      };
      applyAccount(updated);
      setNotice(
        deleteRevoke
          ? "Сессия удалена и завершена на сервере"
          : "Сессия удалена локально",
      );
      setDeleteTarget(null);
    } catch (removalError) {
      setDeleteError(errorMessage(removalError));
    } finally {
      setDeleteBusy(false);
    }
  };

  const finishAdd = useCallback(
    async (attempt: AttemptView) => {
      if (addCompletingRef.current) return;
      addCompletingRef.current = true;
      let updated = attempt.account ?? null;
      try {
        updated = (await fetchAccount(account.id)) ?? updated;
      } catch {
        // The attempt's account view is a usable fallback.
      }
      if (updated) {
        setCurrent(updated);
        onUpdated(updated);
      }
      onNotice?.("Сессия добавлена");
      setNotice("Сессия добавлена");
      setAddOpen(false);
      setAddStep("form");
      setAddAttempt(null);
      setAddPhone("");
      setAddCode("");
      setAddPassword("");
      setAddError(null);
      addCompletingRef.current = false;
    },
    [account.id, onNotice, onUpdated],
  );

  const handleAddAttempt = useCallback(
    (attempt: AttemptView) => {
      if (attempt.status === "ready") {
        void finishAdd(attempt);
        return;
      }
      setAddAttempt(attempt);
      if (attempt.status === "failed" || attempt.status === "expired") {
        setAddStep("failed");
        return;
      }
      if (attempt.status === "awaiting_password" || attempt.needsPassword) {
        setAddStep("password");
        return;
      }
      if (attempt.status === "awaiting_code") {
        setAddStep("code");
        return;
      }
      if (attempt.status === "qr_pending") {
        setAddStep("qr");
        return;
      }
      setAddStep("starting");
    },
    [finishAdd],
  );

  const addAttemptId = addAttempt?.attemptId ?? null;
  const addStatus = addAttempt?.status ?? null;

  // QR and phone attempts both settle asynchronously inside TDLib.
  useEffect(() => {
    if (!addAttemptId || !addStatus) return;
    if (addStatus !== "starting" && addStatus !== "qr_pending") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void getTdlibAuth(addAttemptId)
        .then((attempt) => {
          if (!cancelled) handleAddAttempt(attempt);
        })
        .catch((pollError: unknown) => {
          if (!cancelled) setAddError(errorMessage(pollError));
        });
    }, TDLIB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [addAttemptId, addStatus, handleAddAttempt]);

  const openAdd = () => {
    addCompletingRef.current = false;
    setAddOpen(true);
    setAddStep("form");
    setAddAttempt(null);
    setAddPhone("");
    setAddCode("");
    setAddPassword("");
    setAddError(null);
    setLinkCopied(false);
  };

  const cancelAdd = useCallback(async () => {
    if (addAttempt?.attemptId) {
      try {
        await cancelTdlibAuth(addAttempt.attemptId);
      } catch {
        // Abandoning an attempt must not surface a second error.
      }
    }
    setAddAttempt(null);
    setAddStep("form");
    setAddOpen(false);
    setAddCode("");
    setAddPassword("");
    setAddError(null);
  }, [addAttempt]);

  const restartAdd = () => {
    setAddAttempt(null);
    setAddStep("form");
    setAddCode("");
    setAddPassword("");
    setAddError(null);
    setLinkCopied(false);
  };

  const startAdd = async () => {
    setAddBusy(true);
    setAddError(null);
    setNotice(null);
    try {
      const attempt = await startTdlibAuth({
        method: addMethod,
        ...(addMethod === "phone" ? { phone: addPhone.trim() } : {}),
        ...(addLabel.trim() ? { label: addLabel.trim() } : {}),
        ...(addProxyId ? { proxyId: addProxyId } : {}),
        accountId: current.id,
      });
      setAddCode("");
      setAddPassword("");
      setLinkCopied(false);
      handleAddAttempt(attempt);
    } catch (startError) {
      setAddError(errorMessage(startError));
    } finally {
      setAddBusy(false);
    }
  };

  const submitCode = async () => {
    if (!addAttemptId) return;
    setAddBusy(true);
    setAddError(null);
    try {
      handleAddAttempt(await submitTdlibAuthCode(addAttemptId, addCode.trim()));
    } catch (codeError) {
      setAddError(errorMessage(codeError));
    } finally {
      setAddBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!addAttemptId) return;
    setAddBusy(true);
    setAddError(null);
    try {
      handleAddAttempt(
        await submitTdlibAuthPassword(addAttemptId, addPassword),
      );
    } catch (passwordError) {
      setAddError(errorMessage(passwordError));
    } finally {
      setAddBusy(false);
    }
  };

  const copyQrLink = async () => {
    const link = addAttempt?.qrLink;
    if (!link) return;
    const copied = await copyToClipboard(link);
    if (!copied) return;
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1500);
  };

  const addQrLink = addAttempt?.qrLink ?? "";
  const addAttemptError = attemptErrorText(addAttempt?.error);
  const enabledProxies = proxies.filter((proxy) => proxy.enabled);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-5 py-3">
          <h2 className="min-w-0 truncate text-base font-semibold text-zinc-100">
            Сессии и прокси · {accountName(current)}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => (addOpen ? void cancelAdd() : openAdd())}
              className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
            >
              {addOpen ? "Свернуть" : "+ Добавить сессию"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="rounded-md px-2 py-1 text-xl leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {notice && (
            <div className="mb-4 flex items-start justify-between gap-2 rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Скрыть сообщение"
                className="shrink-0 text-emerald-400 hover:text-emerald-200"
              >
                ×
              </button>
            </div>
          )}

          {addOpen ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-zinc-200">
                  Новая сессия для аккаунта {accountName(current)}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  Сессия добавится в этот аккаунт. Активной останется текущая —
                  переключить можно кнопкой «Сделать активной».
                </p>
              </div>

              {addStep === "form" && (
                <div className="space-y-3">
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-zinc-400">
                      Способ входа
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setAddMethod("qr");
                          setAddError(null);
                        }}
                        className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                          addMethod === "qr"
                            ? "border-sky-500 bg-sky-500/10 text-sky-200"
                            : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                        }`}
                      >
                        QR · рекомендуем
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAddMethod("phone");
                          setAddError(null);
                        }}
                        className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                          addMethod === "phone"
                            ? "border-sky-500 bg-sky-500/10 text-sky-200"
                            : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                        }`}
                      >
                        Телефон
                      </button>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                      {addMethod === "qr"
                        ? "QR быстрее и не требует кода: подтвердите вход в Telegram → Настройки → Устройства → Подключить устройство."
                        : "Telegram пришлёт код в приложение или по SMS. Если включена двухэтапная проверка, понадобится пароль."}
                    </p>
                  </div>

                  {addMethod === "phone" && (
                    <label className="block text-xs font-medium text-zinc-400">
                      Номер телефона этого аккаунта
                      <input
                        value={addPhone}
                        onChange={(event) => setAddPhone(event.target.value)}
                        placeholder="+1 555 000 1234"
                        inputMode="tel"
                        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                      />
                    </label>
                  )}

                  <label className="block text-xs font-medium text-zinc-400">
                    Название сессии (необязательно)
                    <input
                      value={addLabel}
                      onChange={(event) => setAddLabel(event.target.value)}
                      placeholder="Например, рабочий ноутбук"
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                    />
                  </label>

                  <label className="block text-xs font-medium text-zinc-400">
                    Прокси для новой сессии
                    <select
                      value={addProxyId}
                      onChange={(event) => setAddProxyId(event.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
                    >
                      <option value="">Напрямую (без прокси)</option>
                      {enabledProxies.map((proxy) => (
                        <option key={proxy.id} value={proxy.id}>
                          {proxy.name} · {proxy.kind}://{proxy.host}:
                          {proxy.port}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[11px] font-normal text-zinc-500">
                      Прокси применяется только к этой сессии.
                    </span>
                  </label>

                  {addError && (
                    <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                      {addError}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void startAdd()}
                      disabled={
                        addBusy || (addMethod === "phone" && !addPhone.trim())
                      }
                      className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                    >
                      {addBusy
                        ? "Запуск…"
                        : addMethod === "qr"
                          ? "Показать QR-код"
                          : "Отправить код"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void cancelAdd()}
                      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}

              {addStep !== "form" && (
                <div className="space-y-3">
                  {addMethod === "qr" &&
                    (addStep === "starting" ||
                      addStep === "qr" ||
                      addStep === "password") && (
                      <div className="flex flex-col items-center gap-3">
                        {addQrLink ? (
                          <div className="rounded-lg bg-white p-3">
                            <QRCodeSVG value={addQrLink} size={200} />
                          </div>
                        ) : (
                          <div className="flex h-52 w-52 items-center justify-center rounded-lg bg-zinc-800 text-center text-sm text-zinc-500">
                            {addStep === "starting"
                              ? "Запускаем TDLib…"
                              : "Получаем QR-код…"}
                          </div>
                        )}

                        {addQrLink && (
                          <div className="w-full rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-2">
                            <p className="text-[11px] text-zinc-500">
                              Ссылка для ручного открытия
                            </p>
                            <div className="mt-1 flex items-start gap-2">
                              <code className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-zinc-300">
                                {addQrLink}
                              </code>
                              <button
                                type="button"
                                onClick={() => void copyQrLink()}
                                className="shrink-0 rounded-md border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-zinc-400 hover:text-zinc-100"
                              >
                                {linkCopied ? "Скопировано" : "Копировать"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                  {(addStep === "starting" || addStep === "qr") && (
                    <p className="text-center text-sm text-zinc-300">
                      Статус:{" "}
                      <span className="font-medium text-sky-400">
                        {attemptHint(addAttempt)}
                      </span>
                    </p>
                  )}

                  {addStep === "code" && (
                    <>
                      <p className="text-sm text-zinc-400">
                        Введите код, который Telegram отправил на номер
                        аккаунта.
                      </p>
                      <input
                        value={addCode}
                        onChange={(event) => setAddCode(event.target.value)}
                        placeholder="12345"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={() => void submitCode()}
                        disabled={addBusy || !addCode.trim()}
                        className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                      >
                        {addBusy ? "Проверка…" : "Подтвердить код"}
                      </button>
                    </>
                  )}

                  {addStep === "password" && (
                    <>
                      <p className="text-sm text-zinc-400">
                        Telegram запросил пароль двухэтапной проверки.
                        Сохранённый пароль облака подставляется автоматически —
                        введите его, только если Telegram спросил снова.
                      </p>
                      <input
                        type="password"
                        value={addPassword}
                        onChange={(event) => setAddPassword(event.target.value)}
                        placeholder="Пароль двухэтапной проверки"
                        autoComplete="current-password"
                        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={() => void submitPassword()}
                        disabled={addBusy || !addPassword}
                        className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                      >
                        {addBusy ? "Проверка…" : "Подтвердить пароль"}
                      </button>
                    </>
                  )}

                  {addStep === "failed" && (
                    <div className="space-y-3">
                      <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                        {addAttemptError
                          ? `Не удалось добавить сессию: ${addAttemptError}`
                          : "Вход не завершён: попытка истекла или завершилась ошибкой."}
                      </p>
                      <button
                        type="button"
                        onClick={restartAdd}
                        className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
                      >
                        Начать заново
                      </button>
                    </div>
                  )}

                  {addError && (
                    <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                      {addError}
                    </p>
                  )}

                  {addAttemptError && addStep !== "failed" && !addError && (
                    <p className="text-center text-xs text-red-300">
                      {addAttemptError}
                    </p>
                  )}

                  {addStep !== "failed" && (
                    <button
                      type="button"
                      onClick={() => void cancelAdd()}
                      className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      Отменить добавление
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
                Активная сессия обслуживает чаты, историю и обновления в
                реальном времени. Плашка{" "}
                <span className="font-medium text-zinc-300">TDLib</span> или{" "}
                <span className="font-medium text-zinc-300">mtcute</span>{" "}
                показывает движок, который обслуживает сессию.
              </p>

              {proxies.length === 0 && (
                <p className="mb-4 rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
                  Прокси пока нет — сессии работают напрямую. Добавьте прокси в
                  разделе «Прокси».
                </p>
              )}

              <div className="space-y-3">
                {current.sessions.map((session) => {
                  const isActive =
                    !session.revokedAt && session.id === activeId;
                  return (
                    <div
                      key={session.id}
                      className={`rounded-md border px-3 py-3 ${
                        isActive
                          ? "border-emerald-500/60 bg-emerald-500/5"
                          : "border-zinc-800 bg-zinc-800/40"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="truncate text-sm font-medium text-zinc-100">
                              {session.label ?? session.deviceId}
                            </p>
                            <EngineBadge
                              engine={session.engine}
                              active={isActive}
                            />
                            {isActive && (
                              <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                                активная сессия
                              </span>
                            )}
                            {session.revokedAt && (
                              <span className="shrink-0 rounded-full bg-zinc-700/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
                                отозвана
                              </span>
                            )}
                          </div>
                          <p className="truncate text-xs text-zinc-500">
                            {session.profile} ·{" "}
                            {platformLabel(session.platform)}
                            {session.proxyId ? " · через прокси" : ""}
                          </p>
                        </div>
                      </div>

                      {session.revokedAt ? (
                        <p className="mt-2 text-[11px] text-zinc-500">
                          Сессия отозвана и не используется аккаунтом.
                        </p>
                      ) : (
                        <>
                          {isActive && (
                            <p className="mt-2 text-[11px] text-emerald-300/90">
                              Через эту сессию идут чаты, история и realtime.
                            </p>
                          )}

                          <label className="mt-2 block text-xs text-zinc-400">
                            Прокси
                            <select
                              value={session.proxyId ?? ""}
                              disabled={
                                busySessionId === session.id ||
                                activatingId === session.id
                              }
                              onChange={(event) =>
                                void assign(session.id, event.target.value)
                              }
                              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500 disabled:opacity-50"
                            >
                              <option value="">Напрямую (без прокси)</option>
                              {proxies
                                .filter(
                                  (proxy) =>
                                    proxy.enabled ||
                                    proxy.id === session.proxyId,
                                )
                                .map((proxy) => (
                                  <option key={proxy.id} value={proxy.id}>
                                    {proxy.name} · {proxy.kind}://{proxy.host}:
                                    {proxy.port}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <p className="mt-1 text-[11px] text-zinc-500">
                            {busySessionId === session.id
                              ? "Переподключаю эту сессию…"
                              : "Смена прокси переподключает только эту сессию."}
                          </p>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {!isActive && (
                              <button
                                type="button"
                                onClick={() => void makeActive(session.id)}
                                disabled={
                                  activatingId === session.id ||
                                  busySessionId === session.id
                                }
                                className="rounded-md border border-emerald-700/70 px-2.5 py-1.5 text-xs text-emerald-300 transition-colors hover:border-emerald-500 hover:text-emerald-200 disabled:opacity-40"
                              >
                                {activatingId === session.id
                                  ? "Переключаю…"
                                  : "Сделать активной"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openDelete(session)}
                              disabled={
                                lastLiveSession ||
                                activatingId === session.id ||
                                busySessionId === session.id
                              }
                              title={
                                lastLiveSession
                                  ? "Нельзя удалить последнюю сессию: вместе с ней будет удалён аккаунт."
                                  : undefined
                              }
                              className="rounded-md border border-red-900/60 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:border-red-600 disabled:opacity-40"
                            >
                              Удалить
                            </button>
                            {lastLiveSession && (
                              <span className="text-[11px] text-zinc-500">
                                Последнюю сессию удалить нельзя: аккаунт будет
                                удалён.
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {deleteTarget && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-zinc-100">
              Удалить сессию?
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Сессия{" "}
              <span className="font-medium text-zinc-200">
                {deleteTarget.label ?? deleteTarget.deviceId}
              </span>{" "}
              будет удалена из этого приложения вместе с локальными ключами и
              кешем.
            </p>

            <label className="mt-3 flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={deleteRevoke}
                onChange={(event) => setDeleteRevoke(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Также завершить сессию на сервере
                <span className="mt-1 block text-[11px] text-zinc-500">
                  {deleteRevoke
                    ? "Telegram завершит авторизацию: устройство исчезнет из списка сессий."
                    : "Без этой галочки сессия останется активной в Telegram — её видно в Настройках → Устройства."}
                </span>
              </span>
            </label>

            {deleteError && (
              <p className="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                {deleteError}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteBusy}
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleteBusy}
                className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40"
              >
                {deleteBusy ? "Удаление…" : "Удалить сессию"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
