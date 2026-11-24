"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { createDeviceId, getDeviceId } from "../../lib/device";
import { accountName } from "../../lib/format";
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
  ProxyTestResult,
  ProxyView,
  TdataImportAccountView,
  TdataImportView,
  TdataUploadView,
} from "../../lib/types";
import { InfoHint } from "../info-hint";

type Tab = "phone" | "qr" | "tdata";
type PhoneStep = "input" | "starting" | "code" | "password" | "done";
type QrStep = "idle" | "starting" | "waiting" | "password" | "done" | "failed";
type TdataStep = "idle" | "choose" | "done";

const PROFILE_OPTIONS = [
  { key: "desktop", label: "Компьютер (по умолчанию)" },
  { key: "mobile", label: "Телефон" },
  { key: "android-x", label: "Android X" },
  { key: "ios", label: "iOS" },
  { key: "macos", label: "macOS" },
  { key: "web-a", label: "Web A" },
  { key: "web-k", label: "Web K" },
  { key: "webogram", label: "Webogram" },
];

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  phone:
    "Вход по номеру телефона через TDLib: код придёт в приложение Telegram или по SMS. Если включена двухэтапная проверка, Telegram дополнительно попросит пароль.",
  qr: "QR-код показывается на этом устройстве, а сканируется телефоном, где вы уже вошли: Настройки → Устройства → Подключить устройство. Если включена двухэтапная проверка, Telegram попросит пароль.",
  tdata:
    "Импорт готовой сессии из папки tdata Telegram Desktop. В режиме новой сессии профиль выбирается для новой сессии; в режиме общей сессии используется профиль Telegram Desktop из архива.",
};

const TDATA_DEVICE_HINT =
  "Для импорта tdata: с галочкой каждый выбранный аккаунт получает новую отдельную сессию, без галочки обновляется прежняя сессия с тем же идентификатором. В режиме общей сессии Desktop идентификатор относится к самому ключу Desktop.";

/** How a pending TDLib attempt is described in the dialog. */
function attemptHint(attempt: AttemptView | null): string {
  if (!attempt) return "";
  if (attempt.status === "awaiting_password" || attempt.needsPassword) {
    return "Включена двухэтапная проверка. Введите пароль Telegram.";
  }
  if (attempt.status === "awaiting_code") {
    return "Код отправлен. Введите его ниже.";
  }
  return ATTEMPT_STATUS_LABELS[attempt.status];
}

export function AddAccountModal({
  onClose,
  onAccountsAdded,
}: {
  onClose: () => void;
  onAccountsAdded: (accounts: AccountView[]) => void;
}) {
  const [tab, setTab] = useState<Tab>("phone");
  const [profile, setProfile] = useState("desktop");
  const [proxyId, setProxyId] = useState("");
  const [proxies, setProxies] = useState<ProxyView[]>([]);
  const [proxyTestBusy, setProxyTestBusy] = useState(false);
  const [proxyTest, setProxyTest] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [newDevice, setNewDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const originalDeviceIdRef = useRef("");

  const [phoneStep, setPhoneStep] = useState<PhoneStep>("input");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [phonePassword, setPhonePassword] = useState("");
  const [phoneAttempt, setPhoneAttempt] = useState<AttemptView | null>(null);
  const [phoneAccount, setPhoneAccount] = useState<AccountView | null>(null);

  const [qrStep, setQrStep] = useState<QrStep>("idle");
  const [qrAttempt, setQrAttempt] = useState<AttemptView | null>(null);
  const [qrPassword, setQrPassword] = useState("");
  const [qrAccount, setQrAccount] = useState<AccountView | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const [tdataStep, setTdataStep] = useState<TdataStep>("idle");
  const [tdataFile, setTdataFile] = useState<File | null>(null);
  const [tdataPasscode, setTdataPasscode] = useState("");
  const [tdataPassword, setTdataPassword] = useState("");
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [tdataAccounts, setTdataAccounts] = useState<
    Array<{ index: number; userId: string }>
  >([]);
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [reuseMode, setReuseMode] = useState(false);
  const [tdataResults, setTdataResults] = useState<TdataImportAccountView[]>(
    [],
  );

  const phoneAttemptId = phoneAttempt?.attemptId ?? null;
  const qrAttemptId = qrAttempt?.attemptId ?? null;
  const qrStatus = qrAttempt?.status ?? null;

  useEffect(() => {
    const current = getDeviceId();
    originalDeviceIdRef.current = current;
    setDeviceId(current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProxyView[]>("/proxies", {})
      .then((list) => {
        if (!cancelled) setProxies(list.filter((proxy) => proxy.enabled));
      })
      .catch(() => {
        // A missing proxy list must not block direct logins.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyPhoneAttempt = useCallback(
    (attempt: AttemptView) => {
      setPhoneAttempt(attempt);
      if (attempt.status === "ready") {
        if (attempt.account) {
          setPhoneAccount(attempt.account);
          onAccountsAdded([attempt.account]);
        }
        setPhoneStep("done");
        return;
      }
      if (attempt.status === "awaiting_password" || attempt.needsPassword) {
        setPhoneStep("password");
        return;
      }
      if (attempt.status === "awaiting_code") {
        setPhoneStep("code");
        return;
      }
      if (attempt.status === "failed" || attempt.status === "expired") {
        setPhoneStep("input");
        return;
      }
      setPhoneStep("starting");
    },
    [onAccountsAdded],
  );

  const applyQrAttempt = useCallback(
    (attempt: AttemptView) => {
      setQrAttempt(attempt);
      if (attempt.status === "ready") {
        if (attempt.account) {
          setQrAccount(attempt.account);
          onAccountsAdded([attempt.account]);
        }
        setQrStep("done");
        return;
      }
      if (attempt.status === "awaiting_password" || attempt.needsPassword) {
        setQrStep("password");
        return;
      }
      if (attempt.status === "failed" || attempt.status === "expired") {
        setQrStep("failed");
        return;
      }
      if (attempt.status === "qr_pending") {
        setQrStep("waiting");
        return;
      }
      setQrStep("starting");
    },
    [onAccountsAdded],
  );

  // TDLib may still be starting when `start` returns; the phone flow settles
  // on `awaiting_code` within a poll or two.
  useEffect(() => {
    if (!phoneAttemptId || phoneAttempt?.status !== "starting") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void getTdlibAuth(phoneAttemptId)
        .then((attempt) => {
          if (!cancelled) applyPhoneAttempt(attempt);
        })
        .catch((pollError: unknown) => {
          if (!cancelled) setError(errorMessage(pollError));
        });
    }, TDLIB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phoneAttemptId, phoneAttempt?.status, applyPhoneAttempt]);

  // QR login polls its attempt every two seconds until it settles.
  useEffect(() => {
    if (!qrAttemptId || !qrStatus) return;
    if (qrStatus !== "qr_pending" && qrStatus !== "starting") {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      void getTdlibAuth(qrAttemptId)
        .then((attempt) => {
          if (!cancelled) applyQrAttempt(attempt);
        })
        .catch((pollError: unknown) => {
          if (!cancelled) setError(errorMessage(pollError));
        });
    }, TDLIB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [qrAttemptId, qrStatus, applyQrAttempt]);

  const profileOptions = PROFILE_OPTIONS;
  const tdataReuse = tab === "tdata" && reuseMode;

  const resetErrorFor = (nextTab: Tab) => {
    setTab(nextTab);
    setError(null);
  };

  const testSelectedProxy = async () => {
    if (!proxyId) return;
    setProxyTestBusy(true);
    setProxyTest(null);
    try {
      const result = await apiFetch<ProxyTestResult>(
        `/proxies/${proxyId}/test`,
        { method: "POST" },
      );
      setProxyTest(
        result.ok
          ? { ok: true, text: `Прокси отвечает · ${result.latencyMs} мс` }
          : { ok: false, text: "Прокси не ответил на TCP-проверку" },
      );
    } catch (testError) {
      setProxyTest({ ok: false, text: errorMessage(testError) });
    } finally {
      setProxyTestBusy(false);
    }
  };

  const effectiveDeviceId = () => deviceId || getDeviceId();

  const handleNewDeviceChange = (checked: boolean) => {
    setNewDevice(checked);
    if (checked) {
      setDeviceId(createDeviceId());
    } else {
      setDeviceId(originalDeviceIdRef.current || getDeviceId());
    }
  };

  const startPhone = async () => {
    setBusy(true);
    setError(null);
    try {
      const attempt = await startTdlibAuth({
        method: "phone",
        phone: phone.trim(),
        ...(proxyId ? { proxyId } : {}),
      });
      applyPhoneAttempt(attempt);
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      setBusy(false);
    }
  };

  const verifyPhone = async () => {
    if (!phoneAttemptId) return;
    setBusy(true);
    setError(null);
    try {
      applyPhoneAttempt(await submitTdlibAuthCode(phoneAttemptId, code.trim()));
    } catch (verifyError) {
      setError(errorMessage(verifyError));
    } finally {
      setBusy(false);
    }
  };

  const submitPhonePassword = async () => {
    if (!phoneAttemptId) return;
    setBusy(true);
    setError(null);
    try {
      applyPhoneAttempt(
        await submitTdlibAuthPassword(phoneAttemptId, phonePassword),
      );
    } catch (passwordError) {
      setError(errorMessage(passwordError));
    } finally {
      setBusy(false);
    }
  };

  const cancelPhone = useCallback(async () => {
    if (phoneAttemptId) {
      try {
        await cancelTdlibAuth(phoneAttemptId);
      } catch {
        // Abandoning an attempt must not surface a second error.
      }
    }
    setPhoneAttempt(null);
    setPhoneStep("input");
    setCode("");
    setPhonePassword("");
  }, [phoneAttemptId]);

  const startQr = async () => {
    setBusy(true);
    setError(null);
    try {
      const attempt = await startTdlibAuth({
        method: "qr",
        ...(proxyId ? { proxyId } : {}),
      });
      setQrPassword("");
      setLinkCopied(false);
      applyQrAttempt(attempt);
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      setBusy(false);
    }
  };

  const submitQrPassword = async () => {
    if (!qrAttemptId) return;
    setBusy(true);
    setError(null);
    try {
      applyQrAttempt(await submitTdlibAuthPassword(qrAttemptId, qrPassword));
    } catch (passwordError) {
      setError(errorMessage(passwordError));
    } finally {
      setBusy(false);
    }
  };

  const cancelQr = useCallback(async () => {
    if (qrAttemptId) {
      try {
        await cancelTdlibAuth(qrAttemptId);
      } catch {
        // Ignore cancel failures.
      }
    }
    setQrAttempt(null);
    setQrPassword("");
    setQrStep("idle");
  }, [qrAttemptId]);

  const copyQrLink = async () => {
    const link = qrAttempt?.qrLink;
    if (!link) return;
    const copied = await copyToClipboard(link);
    if (!copied) return;
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1500);
  };

  const uploadTdata = async () => {
    if (!tdataFile) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", tdataFile);
      if (tdataPasscode.trim()) formData.append("passcode", tdataPasscode);
      const result = await apiFetch<TdataUploadView>("/auth/tdata", {
        method: "POST",
        formData,
      });
      setUploadId(result.uploadId);
      setTdataAccounts(result.accounts);
      setSelectedIndexes(result.accounts.map((entry) => entry.index));
      setTdataStep("choose");
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelectedIndex = (index: number) => {
    setSelectedIndexes((current) =>
      current.includes(index)
        ? current.filter((value) => value !== index)
        : [...current, index],
    );
  };

  const importTdata = async () => {
    if (!uploadId || selectedIndexes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<TdataImportView>(
        `/auth/tdata/${uploadId}/import`,
        {
          method: "POST",
          body: {
            indexes: selectedIndexes,
            mode: reuseMode ? "reuse" : "new_session",
            deviceId: effectiveDeviceId(),
            profile,
            ...(tdataPassword ? { password: tdataPassword } : {}),
            ...(proxyId ? { proxyId } : {}),
          },
        },
      );
      setTdataResults(result.accounts);
      setTdataStep("done");
      onAccountsAdded(result.accounts.map((entry) => entry.account));
    } catch (importError) {
      setError(errorMessage(importError));
    } finally {
      setBusy(false);
    }
  };

  const cancelTdata = useCallback(async () => {
    if (!uploadId) return;
    try {
      await apiFetch(`/auth/tdata/${uploadId}`, {
        method: "DELETE",
      });
    } catch {
      // Ignore cancel failures.
    }
    setUploadId(null);
    setTdataAccounts([]);
    setSelectedIndexes([]);
    setTdataPassword("");
    setTdataStep("idle");
  }, [uploadId]);

  const handleClose = () => {
    void cancelPhone();
    void cancelQr();
    void cancelTdata();
    onClose();
  };

  const qrLink = qrAttempt?.qrLink ?? "";
  const phoneAttemptError = attemptErrorText(phoneAttempt?.error);
  const qrAttemptError = attemptErrorText(qrAttempt?.error);
  const phonePending =
    phoneStep === "starting" ||
    (phoneStep === "code" && phoneAttempt?.status === "starting");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-100">
            Добавить аккаунт Telegram
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md px-2 py-1 text-xl leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ×
          </button>
        </div>

        <div className="flex gap-1 border-b border-zinc-800 px-5 pt-2">
          {(
            [
              { key: "phone", label: "Телефон" },
              { key: "qr", label: "QR" },
              { key: "tdata", label: "tdata" },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => resetErrorFor(item.key)}
              className={`rounded-t-md px-3 py-2 text-sm font-medium transition-colors ${
                tab === item.key
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="border-b border-zinc-800 px-5 py-2 text-[11px] leading-relaxed text-zinc-500">
          {TAB_DESCRIPTIONS[tab]}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            {tab === "tdata" &&
              (tdataReuse ? (
                <div className="block text-xs font-medium text-zinc-400">
                  Профиль устройства
                  <div className="mt-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-300">
                    Telegram Desktop (из tdata)
                  </div>
                  <span className="mt-1 block text-[11px] font-normal text-zinc-500">
                    В режиме общей сессии профиль берётся из самого архива.
                  </span>
                </div>
              ) : (
                <label className="block text-xs font-medium text-zinc-400">
                  <span className="flex items-center gap-1.5">
                    Профиль устройства
                    <InfoHint placement="top">
                      Профиль новой сессии, которую создаём из tdata. В режиме
                      «использовать сессию Telegram Desktop» поле не
                      применяется.
                    </InfoHint>
                  </span>
                  <select
                    value={profile}
                    onChange={(event) => setProfile(event.target.value)}
                    className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
                  >
                    {profileOptions.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

            {tab === "tdata" && (
              <div className="text-xs font-medium text-zinc-400">
                <span className="flex items-center gap-1.5">
                  Идентификатор устройства
                  <InfoHint placement="top">
                    Внутренний идентификатор этого клиента. Уникальный id =
                    новая отдельная сессия в Telegram. Если войти снова с тем же
                    id, обновится уже существующая сессия (полезно после
                    истечения ключа), а не добавится ещё одна.
                  </InfoHint>
                </span>
                <div className="mt-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-300">
                  <span className="block truncate font-mono text-xs">
                    {deviceId || "…"}
                  </span>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={newDevice}
                        onChange={(event) =>
                          handleNewDeviceChange(event.target.checked)
                        }
                        autoComplete="off"
                      />
                      Новое устройство (добавить сессию)
                    </label>
                    <InfoHint>{TDATA_DEVICE_HINT}</InfoHint>
                  </div>
                </div>
              </div>
            )}

            <div className="block text-xs font-medium text-zinc-400 sm:col-span-2">
              <span className="flex items-center gap-1.5">
                Прокси для входа
                <InfoHint>
                  Через этот прокси выполняется сам вход (запрос кода, QR или
                  импорт tdata). После успешного входа он сохраняется на
                  созданную сессию. Выбрать можно только включённые прокси; если
                  нужного нет — добавьте его в разделе «Прокси».
                </InfoHint>
              </span>
              <div className="mt-1 flex gap-2">
                <select
                  value={proxyId}
                  onChange={(event) => {
                    setProxyId(event.target.value);
                    setProxyTest(null);
                  }}
                  className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
                >
                  <option value="">Напрямую (без прокси)</option>
                  {proxies.map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      {proxy.name} · {proxy.kind}://{proxy.host}:{proxy.port}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void testSelectedProxy()}
                  disabled={!proxyId || proxyTestBusy}
                  className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
                >
                  {proxyTestBusy ? "Проверка…" : "Проверить"}
                </button>
              </div>
              {proxyTest && (
                <span
                  className={`mt-1 block text-[11px] ${
                    proxyTest.ok ? "text-emerald-400" : "text-red-300"
                  }`}
                >
                  {proxyTest.text}
                </span>
              )}
              {proxies.length === 0 && (
                <span className="mt-1 block text-[11px] text-zinc-500">
                  Список пуст. Прокси добавляются в разделе «Прокси» на панели
                  аккаунтов.
                </span>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {tab === "phone" && (
            <div className="space-y-3">
              {phoneStep === "input" && (
                <>
                  <p className="text-sm text-zinc-400">
                    Введите номер телефона Telegram. Код придёт в приложение
                    Telegram или по SMS.
                  </p>
                  {phoneAttemptError && !error && (
                    <p className="text-sm text-red-300">{phoneAttemptError}</p>
                  )}
                  <input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="+1 555 000 1234"
                    inputMode="tel"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    name="ct-login-phone"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => void startPhone()}
                    disabled={busy || !phone.trim()}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    {busy ? "Отправка…" : "Отправить код"}
                  </button>
                </>
              )}

              {phoneStep === "starting" && (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-400">
                    {ATTEMPT_STATUS_LABELS[phoneAttempt?.status ?? "starting"]}
                  </p>
                  <button
                    type="button"
                    onClick={() => void cancelPhone()}
                    className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                  >
                    Отмена
                  </button>
                </div>
              )}

              {phoneStep === "code" && (
                <>
                  <p className="text-sm text-zinc-400">
                    {phonePending
                      ? ATTEMPT_STATUS_LABELS.starting
                      : attemptHint(phoneAttempt)}
                  </p>
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="12345"
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    name="ct-login-code"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void verifyPhone()}
                      disabled={busy || phonePending || !code.trim()}
                      className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                    >
                      Подтвердить код
                    </button>
                    <button
                      type="button"
                      onClick={() => void cancelPhone()}
                      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      Отмена
                    </button>
                  </div>
                  {phoneAttemptError && !error && (
                    <p className="text-sm text-red-300">{phoneAttemptError}</p>
                  )}
                </>
              )}

              {phoneStep === "password" && (
                <>
                  <p className="text-sm text-zinc-400">
                    Включена двухэтапная проверка. Введите пароль Telegram.
                  </p>
                  <input
                    type="password"
                    value={phonePassword}
                    onChange={(event) => setPhonePassword(event.target.value)}
                    placeholder="Пароль"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    name="ct-login-phone-password"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void submitPhonePassword()}
                      disabled={busy || !phonePassword}
                      className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                    >
                      Подтвердить пароль
                    </button>
                    <button
                      type="button"
                      onClick={() => void cancelPhone()}
                      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      Отмена
                    </button>
                  </div>
                  {phoneAttemptError && !error && (
                    <p className="text-sm text-red-300">{phoneAttemptError}</p>
                  )}
                </>
              )}

              {phoneStep === "done" && (
                <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
                  {phoneAccount ? (
                    <>
                      Аккаунт <strong>{accountName(phoneAccount)}</strong>{" "}
                      добавлен и работает на TDLib.
                    </>
                  ) : (
                    "Аккаунт добавлен и работает на TDLib."
                  )}
                </div>
              )}
            </div>
          )}

          {tab === "qr" && (
            <div className="space-y-3">
              {qrStep === "idle" && (
                <>
                  <p className="text-sm text-zinc-400">
                    Откройте Telegram → Настройки → Устройства → Подключить
                    устройство, затем отсканируйте QR-код.
                  </p>
                  <button
                    type="button"
                    onClick={() => void startQr()}
                    disabled={busy}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    {busy ? "Запуск…" : "Войти по QR"}
                  </button>
                </>
              )}

              {(qrStep === "starting" ||
                qrStep === "waiting" ||
                qrStep === "password") && (
                <>
                  <div className="flex flex-col items-center gap-3">
                    {qrLink ? (
                      <div className="rounded-lg bg-white p-3">
                        <QRCodeSVG value={qrLink} size={220} />
                      </div>
                    ) : (
                      <div className="flex h-56 w-56 items-center justify-center rounded-lg bg-zinc-800 text-center text-sm text-zinc-500">
                        {qrStep === "starting"
                          ? "Запускаем TDLib…"
                          : "Получаем QR-код…"}
                      </div>
                    )}

                    {qrLink && (
                      <div className="w-full rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-2">
                        <p className="text-[11px] text-zinc-500">
                          Ссылка для ручного открытия
                        </p>
                        <div className="mt-1 flex items-start gap-2">
                          <code className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-zinc-300">
                            {qrLink}
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

                    <p className="text-sm text-zinc-300">
                      Статус:{" "}
                      <span className="font-medium text-sky-400">
                        {attemptHint(qrAttempt)}
                      </span>
                    </p>
                    {qrAttemptError && !error && (
                      <p className="text-center text-xs text-red-300">
                        {qrAttemptError}
                      </p>
                    )}
                  </div>

                  {qrStep === "password" && (
                    <div className="space-y-2">
                      <p className="text-sm text-zinc-400">
                        Включена двухэтапная проверка. Введите пароль Telegram.
                      </p>
                      <input
                        type="password"
                        value={qrPassword}
                        onChange={(event) => setQrPassword(event.target.value)}
                        placeholder="Пароль двухэтапной проверки"
                        autoComplete="off"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        name="ct-login-qr-password"
                        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={() => void submitQrPassword()}
                        disabled={busy || !qrPassword}
                        className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                      >
                        Подтвердить пароль
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void cancelQr()}
                    className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                  >
                    Отмена
                  </button>
                </>
              )}

              {qrStep === "done" && (
                <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
                  {qrAccount ? (
                    <>
                      Аккаунт <strong>{accountName(qrAccount)}</strong> добавлен
                      и работает на TDLib.
                    </>
                  ) : (
                    "Аккаунт добавлен."
                  )}
                </div>
              )}

              {qrStep === "failed" && (
                <div className="space-y-3">
                  <p className="text-sm text-red-300">
                    {qrAttemptError
                      ? `Ошибка входа по QR: ${qrAttemptError}`
                      : "QR-вход истёк или завершился ошибкой."}
                  </p>
                  <button
                    type="button"
                    onClick={() => void startQr()}
                    disabled={busy}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    Начать заново
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === "tdata" && (
            <div className="space-y-3">
              {tdataStep === "idle" && (
                <>
                  <p className="text-sm text-zinc-400">
                    Загрузите архив <code>tdata</code> от Telegram Desktop
                    (.zip, .tar.gz или .tgz). Если папка защищена, укажите
                    пароль.
                  </p>
                  <input
                    type="file"
                    accept=".zip,.tar.gz,.tgz"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      setTdataFile(file ?? null);
                      setError(null);
                    }}
                    className="block w-full text-sm text-zinc-400 file:mr-3 file:rounded-md file:border file:border-zinc-700 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:text-zinc-200"
                    autoComplete="off"
                  />
                  <input
                    type="password"
                    value={tdataPasscode}
                    onChange={(event) => setTdataPasscode(event.target.value)}
                    placeholder="Пароль папки (необязательно)"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    name="ct-tdata-passcode"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={uploadTdata}
                    disabled={busy || !tdataFile}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    Загрузить и прочитать аккаунты
                  </button>
                </>
              )}

              {tdataStep === "choose" && (
                <>
                  <p className="flex items-center gap-1.5 text-sm text-zinc-400">
                    Найдено аккаунтов: {tdataAccounts.length}. Отметьте нужные
                    для импорта.
                    <InfoHint placement="top">
                      Импортируются только отмеченные аккаунты. Остальные
                      останутся в архиве и не будут добавлены в приложение.
                    </InfoHint>
                  </p>
                  <div className="space-y-2">
                    {tdataAccounts.map((entry) => (
                      <label
                        key={entry.index}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                          selectedIndexes.includes(entry.index)
                            ? "border-sky-500 bg-sky-500/10 text-zinc-100"
                            : "border-zinc-700 text-zinc-300"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIndexes.includes(entry.index)}
                          onChange={() => toggleSelectedIndex(entry.index)}
                          autoComplete="off"
                        />
                        <span>
                          Аккаунт #{entry.index} · id {entry.userId}
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-start gap-2 text-xs text-zinc-400">
                    <label className="flex flex-1 items-start gap-2">
                      <input
                        type="checkbox"
                        checked={reuseMode}
                        onChange={(event) => setReuseMode(event.target.checked)}
                        autoComplete="off"
                      />
                      <span>
                        Использовать сессию Telegram Desktop (дополнительно). По
                        умолчанию создаётся новая сессия.
                      </span>
                    </label>
                    <InfoHint placement="top">
                      Берёт готовый ключ сессии из архива Telegram Desktop
                      вместо входа заново. Не нужен пароль 2FA и импорт быстрее,
                      но это та же сессия, что и на компьютере: состояние
                      прочтения и уведомления могут конфликтовать. Без галочки
                      для аккаунта создаётся отдельная новая сессия.
                    </InfoHint>
                  </div>
                  {reuseMode && (
                    <p className="rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
                      SHARED_DESKTOP_SESSION: сессия использует ключ Telegram
                      Desktop, поэтому состояние прочтения и обновления могут
                      конфликтовать с десктопом.
                    </p>
                  )}

                  {!reuseMode && (
                    <label className="block text-xs text-zinc-400">
                      Пароль двухэтапной проверки (если включён)
                      <input
                        type="password"
                        value={tdataPassword}
                        onChange={(event) =>
                          setTdataPassword(event.target.value)
                        }
                        placeholder="Пароль Telegram (2FA)"
                        autoComplete="off"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        name="ct-tdata-password"
                        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                      />
                      <span className="mt-1 block text-[11px] text-zinc-500">
                        Нужен только для создания новой сессии, если на аккаунте
                        включена двухэтапная проверка.
                      </span>
                    </label>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={importTdata}
                      disabled={busy || selectedIndexes.length === 0}
                      className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                    >
                      Импортировать выбранные
                    </button>
                    <button
                      type="button"
                      onClick={() => void cancelTdata()}
                      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      Отмена
                    </button>
                  </div>
                </>
              )}

              {tdataStep === "done" && (
                <div className="space-y-2">
                  {tdataResults.map((entry) => (
                    <div
                      key={entry.account.id}
                      className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300"
                    >
                      <p>
                        Аккаунт <strong>{accountName(entry.account)}</strong>{" "}
                        импортирован (
                        {entry.mode === "reuse"
                          ? "общая сессия"
                          : "новая сессия"}
                        ).
                      </p>
                      {entry.warning && (
                        <p className="mt-1 text-xs text-amber-300">
                          {entry.warning.code}: {entry.warning.message}
                        </p>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setTdataStep("idle");
                      setTdataFile(null);
                      setTdataResults([]);
                      setReuseMode(false);
                      setTdataPassword("");
                    }}
                    className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                  >
                    Загрузить другой архив
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
