"use client";

import { useEffect, useState } from "react";
import {
  type AiCapabilities,
  type AiCapability,
  type AiSettings,
  aiErrorMessage,
  getAiSettings,
  updateAiPolicy,
} from "../../lib/ai-api";
import { accountName } from "../../lib/format";
import {
  Card,
  ErrorBanner,
  Field,
  inputClass,
  OkBanner,
  PrimaryButton,
  Toggle,
} from "../dashboard/ai-ui";
import { useAppData } from "../dashboard/app-data";

const CAPABILITY_LABELS: Record<AiCapability, string> = {
  read: "Чтение",
  send: "Отправка сообщений",
  sendUnknown: "Писать незнакомым",
  edit: "Редактирование",
  delete: "Удаление",
  react: "Реакции",
  admin: "Администрирование",
  souls: "Души и память",
  skills: "Скиллы",
  automations: "Автоматизации",
  bots: "Боты",
  policy: "Изменение разрешений",
  mcp: "MCP-доступ",
};

const CAPABILITY_HINTS: Partial<Record<AiCapability, string>> = {
  send: "Без этого ИИ и MCP не могут отправлять сообщения от имени аккаунта.",
  sendUnknown:
    "По умолчанию выключено: писать можно только в чаты, где уже есть диалог.",
  delete: "Удаление сообщений у всех. Включайте осознанно.",
  admin: "Участники, баны, ссылки-приглашения. Очень опасное право.",
  policy: "Позволяет ИИ менять собственные разрешения.",
  mcp: "Полный выключатель внешнего доступа по HTTP.",
};

function parseNumberList(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item !== 0);
}

/**
 * AI permission policy. This used to live in the `/ai` settings tab together
 * with the provider form; permissions are owned by the stored AI settings so
 * they moved here with the rest of the configuration.
 */
export function AiPermissionsCard({
  settings,
  onChange,
}: {
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
}) {
  const { accounts } = useAppData();
  const [capabilities, setCapabilities] = useState<AiCapabilities>(
    settings.capabilities,
  );
  const [dryRun, setDryRun] = useState(settings.dryRun);
  const [allowAccountIds, setAllowAccountIds] = useState<string[]>(
    settings.allowAccountIds,
  );
  const [allowChats, setAllowChats] = useState(
    settings.allowChatIds.join(", "),
  );
  const [blockChats, setBlockChats] = useState(
    settings.blockChatIds.join(", "),
  );
  const [ownerIds, setOwnerIds] = useState(settings.ownerTgUserIds.join(", "));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Reset the local form when the parent replaces the settings object. */
  useEffect(() => {
    setCapabilities(settings.capabilities);
    setDryRun(settings.dryRun);
    setAllowAccountIds(settings.allowAccountIds);
    setAllowChats(settings.allowChatIds.join(", "));
    setBlockChats(settings.blockChatIds.join(", "));
    setOwnerIds(settings.ownerTgUserIds.join(", "));
  }, [settings]);

  const savePolicy = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await updateAiPolicy({
        capabilities,
        dryRun,
        allowAccountIds,
        allowChatIds: parseNumberList(allowChats),
        blockChatIds: parseNumberList(blockChats),
        ownerTgUserIds: parseNumberList(ownerIds),
      });
      const next = await getAiSettings();
      onChange(next);
      setStatus("Разрешения сохранены");
    } catch (saveError) {
      setError(aiErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Разрешения"
      description="Что ИИ и MCP-клиенты могут делать с аккаунтами. Пустые списки значат «без ограничений по этому измерению»."
      actions={
        <PrimaryButton onClick={savePolicy} disabled={busy}>
          Сохранить разрешения
        </PrimaryButton>
      }
    >
      <ErrorBanner message={error} />
      <OkBanner message={status} />
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(CAPABILITY_LABELS) as AiCapability[]).map((key) => (
          <Toggle
            key={key}
            checked={capabilities[key]}
            onChange={(value) =>
              setCapabilities((previous) => ({
                ...previous,
                [key]: value,
              }))
            }
            label={CAPABILITY_LABELS[key]}
            hint={CAPABILITY_HINTS[key]}
          />
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <fieldset className="min-w-0">
          <legend className="mb-1 text-xs text-zinc-400">Аккаунты</legend>
          <div className="space-y-1.5 rounded-md border border-zinc-800 p-2">
            {accounts.length === 0 && (
              <p className="text-xs text-zinc-500">Нет аккаунтов</p>
            )}
            {accounts.map((account) => {
              // An empty list means "all accounts"; expand it before toggling
              // so unchecking one account actually excludes it.
              const effective =
                allowAccountIds.length === 0
                  ? accounts.map((item) => item.id)
                  : allowAccountIds;
              const checked = effective.includes(account.id);
              const lastChecked = checked && effective.length === 1;
              return (
                <label
                  key={account.id}
                  title={
                    lastChecked
                      ? "Пустой список значит «все аккаунты», поэтому последний снять нельзя"
                      : undefined
                  }
                  className={`flex min-w-0 items-center gap-2 text-xs ${
                    lastChecked ? "text-zinc-500" : "text-zinc-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={lastChecked}
                    autoComplete="off"
                    name={`ct-ai-account-${account.id}`}
                    onChange={(event) => {
                      setAllowAccountIds(
                        event.target.checked
                          ? [...new Set([...effective, account.id])]
                          : effective.filter((id) => id !== account.id),
                      );
                    }}
                    className="h-3.5 w-3.5 shrink-0 accent-sky-500"
                  />
                  <span className="truncate">{accountName(account)}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Пусто = все аккаунты, поэтому последний отмеченный снять нельзя.
          </p>
        </fieldset>
        <div className="min-w-0 space-y-2">
          <Field label="Разрешённые чаты (id через запятую)">
            <input
              value={allowChats}
              onChange={(event) => setAllowChats(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              name="ct-ai-allow-chats"
              className={inputClass}
              placeholder="пусто = разрешённые по умолчанию"
            />
          </Field>
          <Field label="Запрещённые чаты">
            <input
              value={blockChats}
              onChange={(event) => setBlockChats(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              name="ct-ai-block-chats"
              className={inputClass}
              placeholder="например 123456789"
            />
          </Field>
          <Field
            label="Owner Telegram id (для ботов)"
            hint="Пусто = владельцы всех аккаунтов"
          >
            <input
              value={ownerIds}
              onChange={(event) => setOwnerIds(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              name="ct-ai-owner-ids"
              className={inputClass}
            />
          </Field>
        </div>
      </div>

      <div className="mt-4">
        <Toggle
          checked={dryRun}
          onChange={setDryRun}
          label="dryRun — примерка без действий в Telegram"
          hint="Инструменты отправки, редактирования и удаления только имитируются: в ответе инструмента будет dryRun: true. Автоответ души работает отдельно и от этого флага не зависит."
        />
      </div>
    </Card>
  );
}
