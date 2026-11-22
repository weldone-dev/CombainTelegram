"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import { createDeviceId, getDeviceId } from "../../lib/device";
import { accountName, formatTime } from "../../lib/format";
import { subscribeRealtime } from "../../lib/realtime-bus";
import type {
  AccountView,
  PhoneCompletedView,
  PhoneStartView,
  PhoneVerifyView,
  ProxyTestResult,
  ProxyView,
  QrStartView,
  QrStatusView,
  RealtimeAuthDoneEvent,
  RealtimeAuthFailedEvent,
  RealtimeQrUpdatedEvent,
  TdataImportAccountView,
  TdataImportView,
  TdataUploadView,
} from "../../lib/types";
import { InfoHint } from "../info-hint";

type Tab = "phone" | "qr" | "tdata";
type PhoneStep = "input" | "code" | "password" | "signup" | "done";
type QrStep = "idle" | "waiting" | "password" | "done" | "expired";
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

/** QR login: the code is shown by this device and scanned by a phone. */
const QR_PROFILE_KEYS = new Set([
  "desktop",
  "macos",
  "web-a",
  "web-k",
  "webogram",
]);

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  phone:
    "Вход по номеру телефона: код придёт в приложение Telegram или по SMS. Здесь создаётся новая сессия (или обновляется существующая с тем же идентификатором).",
  qr: "QR-код показывается на этом устройстве (обычно компьютер или веб), а сканируется телефоном, где вы уже вошли: Настройки → Устройства → Подключить устройство.",
  tdata:
    "Импорт готовой сессии из папки tdata Telegram Desktop. В режиме новой сессии профиль выбирается для новой сессии; в режиме общей сессии используется профиль Telegram Desktop из архива.",
};

const NEW_DEVICE_HINTS: Record<Tab, string> = {
  phone:
    "Создаёт новый идентификатор: Telegram добавит отдельную сессию, а не заменит текущую. Пример — вход в тот же аккаунт со второго устройства. Без галочки обновится существующая сессия этого приложения с тем же идентификатором.",
  qr: "Галочка создаёт отдельную сессию для этого клиента. QR-код сканируется телефоном, где вы уже вошли в Telegram; без галочки обновится существующая сессия с тем же идентификатором.",
  tdata:
    "Для импорта tdata: с галочкой каждый выбранный аккаунт получает новую отдельную сессию, без галочки обновляется прежняя сессия с тем же идентификатором. В режиме общей сессии Desktop идентификатор относится к самому ключу Desktop.",
};

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
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneAttemptId, setPhoneAttemptId] = useState<string | null>(null);
  const [phoneCodeHint, setPhoneCodeHint] = useState<string | null>(null);
  const [phoneAccount, setPhoneAccount] = useState<AccountView | null>(null);

  const [qrStep, setQrStep] = useState<QrStep>("idle");
  const [qrAttemptId, setQrAttemptId] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState("");
  const [qrExpiresAt, setQrExpiresAt] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState("idle");
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrPassword, setQrPassword] = useState("");
  const [qrAccount, setQrAccount] = useState<AccountView | null>(null);

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

  const applyQrStatus = useCallback(
    (status: QrStatusView) => {
      setQrStatus(status.status === "ok" ? "done" : status.status);
      if (status.url) setQrUrl(status.url);
      if (status.expiresAt) setQrExpiresAt(status.expiresAt);
      if (status.error) setQrError(status.error);
      if (status.status === "password_required") {
        setQrStep("password");
        return;
      }
      if (status.status === "ok" || status.status === "done") {
        if (status.account) {
          setQrAccount(status.account);
          onAccountsAdded([status.account]);
        }
        setQrStep("done");
        return;
      }
      if (status.status === "expired" || status.status === "failed") {
        setQrStep("expired");
      }
    },
    [onAccountsAdded],
  );

  // QR status polling is the fallback when the socket is unavailable.
  useEffect(() => {
    if (
      qrAttemptId === null ||
      (qrStep !== "waiting" && qrStep !== "password")
    ) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await apiFetch<QrStatusView>(
          `/auth/qr/${qrAttemptId}`,
          {},
        );
        if (!cancelled) applyQrStatus(status);
      } catch (pollError) {
        if (!cancelled) setError(errorMessage(pollError));
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [qrAttemptId, qrStep, applyQrStatus]);

  // Realtime QR + phone completion events.
  useEffect(() => {
    if (qrAttemptId === null) return;
    return subscribeRealtime((event) => {
      const payload = event.payload as { attemptId?: unknown } | null;
      if (payload && payload.attemptId !== qrAttemptId) return;
      if (event.event === "auth.qr.updated") {
        const updated = event.payload as RealtimeQrUpdatedEvent;
        setQrUrl(updated.url);
        setQrExpiresAt(updated.expiresAt);
        setQrStatus("pending");
        return;
      }
      if (event.event === "auth.qr.scanned") {
        setQrStatus("scanned");
        return;
      }
      if (event.event === "auth.qr.password_required") {
        setQrStatus("password_required");
        setQrStep("password");
        return;
      }
      if (event.event === "auth.done") {
        const done = event.payload as RealtimeAuthDoneEvent;
        setQrAccount(done.account);
        setQrStatus("done");
        setQrStep("done");
        onAccountsAdded([done.account]);
        return;
      }
      if (event.event === "auth.failed") {
        const failed = event.payload as RealtimeAuthFailedEvent;
        setQrError(failed.error);
        setQrStatus("failed");
        setQrStep("expired");
      }
    });
  }, [qrAttemptId, onAccountsAdded]);

  useEffect(() => {
    if (phoneAttemptId === null) return;
    return subscribeRealtime((event) => {
      const payload = event.payload as { attemptId?: unknown } | null;
      if (payload && payload.attemptId !== phoneAttemptId) return;
      if (event.event === "auth.done") {
        const done = event.payload as RealtimeAuthDoneEvent;
        setPhoneAccount(done.account);
        setPhoneStep("done");
        onAccountsAdded([done.account]);
      }
      if (event.event === "auth.failed") {
        const failed = event.payload as RealtimeAuthFailedEvent;
        setError(`Ошибка входа: ${failed.error}`);
        setPhoneAttemptId(null);
        setPhoneStep("input");
      }
    });
  }, [phoneAttemptId, onAccountsAdded]);

  useEffect(() => {
    if (tab === "qr" && !QR_PROFILE_KEYS.has(profile)) {
      setProfile("desktop");
    }
  }, [tab, profile]);

  const profileOptions =
    tab === "qr"
      ? PROFILE_OPTIONS.filter((option) => QR_PROFILE_KEYS.has(option.key))
      : PROFILE_OPTIONS;
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
      const result = await apiFetch<PhoneStartView>("/auth/phone/start", {
        method: "POST",
        body: {
          phone,
          deviceId: effectiveDeviceId(),
          profile,
          ...(proxyId ? { proxyId } : {}),
        },
      });
      setPhoneAttemptId(result.attemptId);
      setPhoneCodeHint(
        `Code sent (${result.codeType}${
          result.nextType ? `, next: ${result.nextType}` : ""
        }). Timeout ${result.timeout}s.`,
      );
      setPhoneStep("code");
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
      const result = await apiFetch<PhoneVerifyView>("/auth/phone/verify", {
        method: "POST",
        body: { attemptId: phoneAttemptId, code },
      });
      if (result.status === "ok") {
        setPhoneAccount(result.account);
        setPhoneStep("done");
        onAccountsAdded([result.account]);
      } else if (result.status === "password_required") {
        setPhoneStep("password");
      } else {
        setPhoneStep("signup");
      }
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
      const result = await apiFetch<PhoneCompletedView>(
        "/auth/phone/password",
        {
          method: "POST",
          body: { attemptId: phoneAttemptId, password: phonePassword },
        },
      );
      setPhoneAccount(result.account);
      setPhoneStep("done");
      onAccountsAdded([result.account]);
    } catch (passwordError) {
      setError(errorMessage(passwordError));
    } finally {
      setBusy(false);
    }
  };

  const submitPhoneSignup = async () => {
    if (!phoneAttemptId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<PhoneCompletedView>("/auth/phone/signup", {
        method: "POST",
        body: {
          attemptId: phoneAttemptId,
          firstName,
          lastName: lastName || undefined,
        },
      });
      setPhoneAccount(result.account);
      setPhoneStep("done");
      onAccountsAdded([result.account]);
    } catch (signupError) {
      setError(errorMessage(signupError));
    } finally {
      setBusy(false);
    }
  };

  const cancelPhone = useCallback(async () => {
    if (!phoneAttemptId) return;
    try {
      await apiFetch("/auth/phone/cancel", {
        method: "POST",
        body: { attemptId: phoneAttemptId },
      });
    } catch {
      // Abandoning an attempt must not surface a second error.
    }
    setPhoneAttemptId(null);
    setPhoneStep("input");
    setCode("");
    setPhonePassword("");
  }, [phoneAttemptId]);

  const startQr = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<QrStartView>("/auth/qr/start", {
        method: "POST",
        body: {
          deviceId: effectiveDeviceId(),
          profile,
          ...(proxyId ? { proxyId } : {}),
        },
      });
      setQrAttemptId(result.attemptId);
      setQrUrl(result.url);
      setQrExpiresAt(result.expiresAt);
      setQrStatus("pending");
      setQrError(null);
      setQrStep("waiting");
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
      await apiFetch(`/auth/qr/${qrAttemptId}/password`, {
        method: "POST",
        body: { password: qrPassword },
      });
    } catch (passwordError) {
      setError(errorMessage(passwordError));
    } finally {
      setBusy(false);
    }
  };

  const cancelQr = useCallback(async () => {
    if (!qrAttemptId) return;
    try {
      await apiFetch(`/auth/qr/${qrAttemptId}/cancel`, {
        method: "POST",
      });
    } catch {
      // Ignore cancel failures.
    }
    setQrAttemptId(null);
    setQrUrl("");
    setQrStatus("idle");
    setQrStep("idle");
  }, [qrAttemptId]);

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
            {tdataReuse ? (
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
                    {tab === "qr"
                      ? "Какое устройство показывает QR-код: компьютер или веб. Сам код сканируется телефоном. Профили телефонов здесь скрыты, чтобы не создавать путаницу."
                      : tab === "tdata"
                        ? "Профиль новой сессии, которую создаём из tdata. В режиме «использовать сессию Telegram Desktop» поле не применяется."
                        : "Как Telegram увидит это устройство: компьютер, телефон или веб. Влияет на список устройств и параметры подключения."}
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
            )}

            <div className="text-xs font-medium text-zinc-400">
              <span className="flex items-center gap-1.5">
                Идентификатор устройства
                <InfoHint placement="top">
                  Внутренний идентификатор этого клиента. Уникальный id = новая
                  отдельная сессия в Telegram. Если войти снова с тем же id,
                  обновится уже существующая сессия (полезно после истечения
                  ключа), а не добавится ещё одна.
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
                    />
                    Новое устройство (добавить сессию)
                  </label>
                  <InfoHint>{NEW_DEVICE_HINTS[tab]}</InfoHint>
                </div>
              </div>
            </div>

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
                  <input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="+1 555 000 1234"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={startPhone}
                    disabled={busy || !phone.trim()}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    Отправить код
                  </button>
                </>
              )}

              {phoneStep === "code" && (
                <>
                  <p className="text-sm text-zinc-400">{phoneCodeHint}</p>
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="12345"
                    inputMode="numeric"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={verifyPhone}
                      disabled={busy || !code.trim()}
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
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={submitPhonePassword}
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
                </>
              )}

              {phoneStep === "signup" && (
                <>
                  <p className="text-sm text-zinc-400">
                    Этот номер ещё не зарегистрирован в Telegram. Введите имя
                    для регистрации.
                  </p>
                  <input
                    value={firstName}
                    onChange={(event) => setFirstName(event.target.value)}
                    placeholder="Имя"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <input
                    value={lastName}
                    onChange={(event) => setLastName(event.target.value)}
                    placeholder="Фамилия (необязательно)"
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={submitPhoneSignup}
                    disabled={busy || !firstName.trim()}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    Зарегистрироваться
                  </button>
                </>
              )}

              {phoneStep === "done" && phoneAccount && (
                <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
                  Аккаунт <strong>{accountName(phoneAccount)}</strong> добавлен.
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
                    onClick={startQr}
                    disabled={busy}
                    className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                  >
                    Войти по QR
                  </button>
                </>
              )}

              {(qrStep === "waiting" || qrStep === "password") && (
                <>
                  <div className="flex flex-col items-center gap-3">
                    {qrUrl ? (
                      <div className="rounded-lg bg-white p-3">
                        <QRCodeSVG value={qrUrl} size={220} />
                      </div>
                    ) : (
                      <div className="flex h-56 w-56 items-center justify-center rounded-lg bg-zinc-800 text-sm text-zinc-500">
                        Генерация QR…
                      </div>
                    )}
                    <p className="text-sm text-zinc-300">
                      Статус:{" "}
                      <span className="font-medium text-sky-400">
                        {qrStatus}
                      </span>
                    </p>
                    {qrExpiresAt && (
                      <p className="text-xs text-zinc-500">
                        Истекает в {formatTime(qrExpiresAt)}
                      </p>
                    )}
                    {qrError && (
                      <p className="text-xs text-red-300">{qrError}</p>
                    )}
                  </div>

                  {qrStep === "password" ? (
                    <div className="space-y-2">
                      <input
                        type="password"
                        value={qrPassword}
                        onChange={(event) => setQrPassword(event.target.value)}
                        placeholder="Пароль двухэтапной проверки"
                        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={submitQrPassword}
                        disabled={busy || !qrPassword}
                        className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
                      >
                        Подтвердить пароль
                      </button>
                    </div>
                  ) : null}

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
                      Аккаунт <strong>{accountName(qrAccount)}</strong>{" "}
                      добавлен.
                    </>
                  ) : (
                    "Аккаунт добавлен."
                  )}
                </div>
              )}

              {qrStep === "expired" && (
                <div className="space-y-3">
                  <p className="text-sm text-red-300">
                    {qrError
                      ? `Ошибка входа по QR: ${qrError}`
                      : "QR-вход истёк или завершился ошибкой."}
                  </p>
                  <button
                    type="button"
                    onClick={startQr}
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
                  />
                  <input
                    type="password"
                    value={tdataPasscode}
                    onChange={(event) => setTdataPasscode(event.target.value)}
                    placeholder="Пароль папки (необязательно)"
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
