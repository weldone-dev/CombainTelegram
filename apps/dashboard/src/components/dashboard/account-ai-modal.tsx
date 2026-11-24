"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  aiErrorMessage,
  getSoul,
  listSkills,
  type SkillView,
  type SoulView,
} from "../../lib/ai-api";
import { ApiError } from "../../lib/api";
import { accountName } from "../../lib/format";
import type { AccountView } from "../../lib/types";
import { AccountAiPermissions } from "./account-ai-permissions";
import { Card, ErrorBanner, GhostButton, PrimaryButton } from "./ai-ui";
import { defaultSoul, SoulSettingsForm } from "./soul-settings-form";

type AiTab = "soul" | "permissions";

const AI_TABS: Array<{ id: AiTab; label: string }> = [
  { id: "soul", label: "Душа" },
  { id: "permissions", label: "Права ИИ" },
];

/**
 * AI settings of one account, opened from the accounts list: the soul/persona
 * editor and the per-account capability overrides. The API's soul PUT upserts,
 * so the same form both creates a missing soul and updates an existing one;
 * nothing else on the page reloads.
 */
export function AccountAiModal({
  account,
  onClose,
  onNotice,
}: {
  account: AccountView;
  onClose: () => void;
  onNotice?: (message: string) => void;
}) {
  const [soul, setSoul] = useState<SoulView | null>(null);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<AiTab>("soul");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const label = accountName(account);

  const load = useCallback(async (accountId: string, displayName: string) => {
    setLoading(true);
    setLoadError(null);
    setMissing(false);
    setCreating(false);
    setSoul(null);
    try {
      const [soulResult, skillsResult] = await Promise.allSettled([
        getSoul(accountId),
        listSkills(),
      ]);
      if (skillsResult.status === "fulfilled") {
        setSkills(skillsResult.value.skills);
      }
      if (soulResult.status === "rejected") {
        const error = soulResult.reason;
        if (error instanceof ApiError && error.status === 404) {
          // The account exists (it is in the list) but has no soul row yet;
          // offer creating one instead of pretending it is a load failure.
          setMissing(true);
          setSoul(defaultSoul(accountId, displayName));
        } else {
          throw error;
        }
      } else {
        setSoul(soulResult.value);
      }
    } catch (error) {
      setLoadError(aiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey retries a failed load
  useEffect(() => {
    void load(account.id, label);
  }, [load, account.id, label, reloadKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const startCreating = () => {
    setSoul(defaultSoul(account.id, label));
    setCreating(true);
    setMissing(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Настройки ИИ · ${label}`}
    >
      <div className="flex h-dvh w-full flex-col overflow-hidden border-zinc-700 bg-zinc-900 shadow-2xl sm:h-auto sm:max-h-[92vh] sm:max-w-4xl sm:rounded-xl sm:border">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2.5 sm:px-5 sm:py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100 sm:text-base">
              Настройки ИИ · {label}
            </h2>
            <p className="truncate text-[11px] text-zinc-500">
              {tab === "soul"
                ? "Душа, присутствие, чаты, лимиты и скиллы этого аккаунта"
                : "Индивидуальные права ИИ поверх глобальных настроек"}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="shrink-0 rounded-md px-2 py-1 text-xl leading-none text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            ×
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-800 px-2 py-1.5 sm:px-4">
          {AI_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-pressed={tab === item.id}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                tab === item.id
                  ? "bg-sky-500/15 font-medium text-sky-300"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          <div hidden={tab !== "soul"}>
            {loading && (
              <p className="p-4 text-sm text-zinc-500" aria-live="polite">
                Загрузка настроек ИИ…
              </p>
            )}

            {!loading && loadError && (
              <div className="p-2">
                <ErrorBanner message={loadError} />
                <GhostButton onClick={() => setReloadKey((key) => key + 1)}>
                  Повторить
                </GhostButton>
              </div>
            )}

            {!loading && !loadError && missing && (
              <Card
                title={`Душа · ${label}`}
                description="У аккаунта ещё нет души. Создайте её — персона, режим, присутствие, лимиты и скиллы настраиваются сразу."
              >
                <div className="flex flex-wrap items-center gap-3">
                  <PrimaryButton onClick={startCreating}>
                    Создать душу
                  </PrimaryButton>
                  <span className="text-[11px] text-zinc-500">
                    Сохраняется на этом аккаунте, другие аккаунты не меняются.
                  </span>
                </div>
              </Card>
            )}

            {!loading && !loadError && soul && (
              <SoulSettingsForm
                soul={soul}
                skills={skills}
                title={creating ? `Новая душа · ${label}` : `Душа · ${label}`}
                description={
                  creating
                    ? "Заполните персону и сохраните — душа появится у аккаунта."
                    : "Персона, которую ИИ использует в переписке и при работе с аккаунтом."
                }
                onSaved={(saved) => {
                  setSoul(saved);
                  setCreating(false);
                  setMissing(false);
                  onNotice?.(`Настройки ИИ сохранены · ${label}`);
                }}
              />
            )}
          </div>

          {/* Kept mounted while hidden so unsaved edits survive tab switches. */}
          <div hidden={tab !== "permissions"} className="min-w-0">
            <AccountAiPermissions accountId={account.id} onNotice={onNotice} />
          </div>
        </div>
      </div>
    </div>
  );
}
