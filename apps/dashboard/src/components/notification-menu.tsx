"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  notificationsReady,
  notificationsSupported,
  readNotificationsEnabled,
  showMessageNotification,
  writeNotificationsEnabled,
} from "../lib/notifications";
import {
  disablePush,
  enablePush,
  getPushStatus,
  PUSH_DISABLED_MESSAGE,
  type PushStatus,
  pushConfiguredOnServer,
  registerServiceWorker,
  sendTestPush,
} from "../lib/push";
import {
  playChime,
  primeAudio,
  readSoundEnabled,
  writeSoundEnabled,
} from "../lib/sound";

type NotificationState = "on" | "off" | "denied" | "unsupported";

const NOTIFICATION_LABEL: Record<NotificationState, string> = {
  on: "вкл",
  off: "выкл",
  denied: "заблокированы",
  unsupported: "не поддерживаются",
};

const NOTIFICATION_HINT: Record<NotificationState, string> = {
  on: "всплывающие уведомления о новых сообщениях",
  off: "показывать desktop-уведомления о новых сообщениях",
  denied: "разрешите уведомления в настройках браузера",
  unsupported: "браузер не поддерживает системные уведомления",
};

function readNotificationState(): NotificationState {
  if (!notificationsSupported()) return "unsupported";
  if (window.Notification.permission === "denied") return "denied";
  return readNotificationsEnabled() ? "on" : "off";
}

function pushStateLabel(
  status: PushStatus,
  serverConfigured: boolean | null,
): string {
  if (status === "subscribed") return "вкл";
  if (status === "denied") return "заблокированы";
  if (status === "unsupported") return "не поддерживаются";
  if (serverConfigured === false) return "не настроено на сервере";
  return "выкл";
}

function pushStateHint(
  status: PushStatus,
  serverConfigured: boolean | null,
): string {
  if (status === "subscribed") {
    return "push приходит, даже когда вкладка закрыта";
  }
  if (status === "denied") return "разрешите уведомления в настройках браузера";
  if (status === "unsupported") return "браузер не поддерживает Web Push";
  if (serverConfigured === false) {
    return "администратор должен задать VAPID-ключи";
  }
  return "подписать это устройство на push";
}

/**
 * The header's single notification control: in-app notifications, the chime
 * and Web Push in one popover that closes on Escape or an outside click.
 */
export function NotificationMenu() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationState>("off");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [pushStatus, setPushStatus] = useState<PushStatus>("off");
  const [pushServer, setPushServer] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const syncNotifications = useCallback(() => {
    const state = readNotificationState();
    if (state === "denied") writeNotificationsEnabled(false);
    setNotifications(state);
  }, []);

  const syncPush = useCallback(async () => {
    await registerServiceWorker();
    const [status, serverConfigured] = await Promise.all([
      getPushStatus(),
      pushConfiguredOnServer(),
    ]);
    setPushStatus(status);
    setPushServer(serverConfigured);
  }, []);

  useEffect(() => {
    setSoundEnabled(readSoundEnabled());
    syncNotifications();
  }, [syncNotifications]);

  // Permission and subscription may change outside this tab (browser settings,
  // another tab), so both are re-read on focus and whenever the menu opens.
  useEffect(() => {
    const sync = () => {
      syncNotifications();
      void syncPush();
    };
    sync();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [syncNotifications, syncPush]);

  useEffect(() => {
    if (!open) return;
    syncNotifications();
    void syncPush();
    setTestMessage(null);
    setPushError(null);
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, syncNotifications, syncPush]);

  const toggleNotifications = async () => {
    if (notifications === "unsupported") return;
    // Every click is a user gesture: prime the shared AudioContext here so a
    // later incoming message can play the chime without being blocked.
    primeAudio();

    let permission = window.Notification.permission;
    if (permission === "default") {
      permission = await window.Notification.requestPermission();
    }
    if (notifications === "on") {
      writeNotificationsEnabled(false);
      setNotifications(permission === "granted" ? "off" : "denied");
      return;
    }
    if (permission !== "granted") {
      writeNotificationsEnabled(false);
      setNotifications("denied");
      return;
    }
    writeNotificationsEnabled(true);
    setNotifications("on");
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    primeAudio();
    writeSoundEnabled(next);
    setSoundEnabled(next);
    // Turning it on plays one chime as confirmation.
    if (next) playChime();
  };

  const togglePush = async () => {
    if (pushBusy || pushStatus === "unsupported" || pushStatus === "denied") {
      return;
    }
    setPushBusy(true);
    setPushError(null);
    try {
      if (pushStatus === "subscribed") {
        await disablePush();
        setPushStatus(await getPushStatus());
        return;
      }
      const status = await enablePush();
      setPushStatus(status);
      if (status === "denied") {
        setPushError("Разрешение на уведомления отклонено в браузере");
      } else if (status === "subscribed") {
        setPushServer(true);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Не удалось изменить push-уведомления";
      if (message === PUSH_DISABLED_MESSAGE) setPushServer(false);
      else setPushError(message);
    } finally {
      setPushBusy(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    primeAudio();

    const lines: string[] = [];
    let error = false;

    const soundOn = readSoundEnabled();
    if (soundOn) playChime();

    let desktopShown = false;
    if (notificationsReady()) {
      showMessageNotification(
        "CombainTelegram",
        "Проверка",
        "Тестовое уведомление",
        0,
      );
      desktopShown = true;
    }

    if (soundOn && desktopShown) {
      lines.push("Звук и уведомление отправлены");
    } else if (soundOn) {
      lines.push("Звук отправлен");
    } else if (desktopShown) {
      lines.push("Уведомление отправлено");
    } else {
      lines.push("Звук выключен, уведомления выключены");
      error = true;
    }

    if (pushStatus === "subscribed") {
      try {
        const result = await sendTestPush();
        lines.push(`Push: отправлено ${result.sent}, ошибок ${result.failed}`);
        if (result.failed > 0) error = true;
      } catch (pushFailure) {
        lines.push(
          pushFailure instanceof Error
            ? `Push: ${pushFailure.message}`
            : "Push: не удалось отправить",
        );
        error = true;
      }
    }

    setTestMessage({ text: lines.join("\n"), error });
    setTesting(false);
  };

  const notificationsOn = notifications === "on";
  const pushOn = pushStatus === "subscribed";
  const bellActive = notificationsOn || pushOn;
  const notificationsSwitchable = notifications !== "unsupported";
  const pushSwitchable =
    pushStatus !== "unsupported" && pushStatus !== "denied";

  const notificationsLabel = notificationsOn
    ? "Выключить уведомления"
    : "Включить уведомления";

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        title={notificationsLabel}
        aria-label={notificationsLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notification-menu"
        className={`relative rounded-md p-1.5 transition-colors ${
          bellActive
            ? "text-sky-400 hover:bg-zinc-800 hover:text-sky-300"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        }`}
      >
        <BellIcon muted={!bellActive} />
        {pushOn && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-zinc-900"
          />
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id="notification-menu"
          role="dialog"
          aria-label="Настройки уведомлений"
          tabIndex={-1}
          className="fixed right-3 top-16 z-50 w-[min(18rem,calc(100vw-1.5rem))] rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-2xl outline-none"
        >
          <div className="flex items-center justify-between px-1 pb-1 pt-0.5">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">
              Настройки
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              aria-label="Закрыть меню уведомлений"
              className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <CloseIcon />
            </button>
          </div>

          <MenuRow
            label="Уведомления"
            status={NOTIFICATION_LABEL[notifications]}
            statusTone={
              notificationsOn
                ? "on"
                : notifications === "off"
                  ? "off"
                  : "blocked"
            }
            hint={NOTIFICATION_HINT[notifications]}
            checked={notificationsOn}
            disabled={!notificationsSwitchable}
            onToggle={() => void toggleNotifications()}
          />

          <MenuRow
            label="Звук"
            status={soundEnabled ? "вкл" : "выкл"}
            statusTone={soundEnabled ? "on" : "off"}
            hint="звук для новых сообщений"
            checked={soundEnabled}
            onToggle={toggleSound}
          />

          <MenuRow
            label="Push-уведомления"
            status={pushStateLabel(pushStatus, pushServer)}
            statusTone={
              pushOn
                ? "on"
                : pushStatus === "off" && pushServer !== false
                  ? "off"
                  : "blocked"
            }
            hint={pushStateHint(pushStatus, pushServer)}
            checked={pushOn}
            disabled={!pushSwitchable || pushBusy}
            onToggle={() => void togglePush()}
          />

          {pushError && (
            <p className="px-1 pb-1 text-[11px] leading-snug text-amber-300">
              {pushError}
            </p>
          )}

          <div className="my-1 border-t border-zinc-800" />

          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
          >
            {testing ? "Проверяем…" : "Проверить"}
          </button>

          {testMessage && (
            <output
              className={`block whitespace-pre-line px-1 pt-2 text-[11px] leading-snug ${
                testMessage.error ? "text-amber-300" : "text-zinc-400"
              }`}
            >
              {testMessage.text}
            </output>
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  label,
  status,
  statusTone,
  hint,
  checked,
  disabled = false,
  onToggle,
}: {
  label: string;
  status: string;
  statusTone: "on" | "off" | "blocked";
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const toneClass =
    statusTone === "on"
      ? "text-sky-400"
      : statusTone === "blocked"
        ? "text-amber-400"
        : "text-zinc-500";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label}: ${status}`}
      disabled={disabled}
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-zinc-800/60 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="text-sm text-zinc-200">{label}</span>
          <span className={`text-[11px] ${toneClass}`}>{status}</span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">
          {hint}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-sky-500" : "bg-zinc-700"
        } ${disabled ? "opacity-50" : ""}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
    </button>
  );
}

function BellIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
      <path d="M10.3 18a2 2 0 0 0 3.4 0" />
      {muted && <path d="M3 3l18 18" />}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      className="h-3.5 w-3.5"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
