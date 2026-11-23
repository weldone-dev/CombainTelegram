"use client";

import { useCallback, useEffect, useState } from "react";
import {
  aiErrorMessage,
  type BotView,
  checkBot,
  deleteBot,
  listBots,
  listSkills,
  type SkillView,
  saveAccountBot,
  saveSharedBot,
  setBotSkills,
  updateBot,
} from "../../lib/ai-api";
import { accountName } from "../../lib/format";
import {
  Card,
  Field,
  GhostButton,
  inputClass,
  Pill,
  PrimaryButton,
  Toggle,
} from "./ai-ui";
import { useAppData } from "./app-data";

function BotEditor({
  title,
  description,
  accountId,
  bot,
  skills,
  onSaved,
  onDeleted,
}: {
  title: string;
  description: string;
  accountId: string | null;
  bot: BotView | null;
  skills: SkillView[];
  onSaved: (bot: BotView) => void;
  onDeleted: () => void;
}) {
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);
  const [username, setUsername] = useState(bot?.username ?? "");
  const [allowed, setAllowed] = useState(bot?.allowedUserIds.join(", ") ?? "");
  const [attached, setAttached] = useState<string[]>(bot?.skills ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(bot?.enabled ?? true);
    setUsername(bot?.username ?? "");
    setAllowed(bot?.allowedUserIds.join(", ") ?? "");
    setAttached(bot?.skills ?? []);
    setToken("");
  }, [bot]);

  const tokenValid =
    token.trim() === "" || /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());

  const save = async () => {
    const allowedIds = allowed
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const badAllowed = allowedIds.find((item) => !/^\d+$/.test(item));
    if (badAllowed) {
      setError(`Telegram id «${badAllowed}» должен состоять только из цифр`);
      return;
    }
    if (!tokenValid) {
      setError("Токен должен выглядеть как 123456789:AA…");
      return;
    }
    if (!bot && !token.trim()) {
      setError("Для нового бота нужен токен BotFather");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const body: Record<string, unknown> = {
        enabled,
        username: username.trim(),
        allowedUserIds: allowedIds,
        ...(token.trim() ? { token: token.trim() } : {}),
      };
      const saved = bot
        ? await updateBot(bot.id, body)
        : accountId
          ? await saveAccountBot(accountId, body)
          : await saveSharedBot(body);
      let next = saved;
      if (attached.length > 0 || skills.length > 0) {
        next = await setBotSkills(saved.id, attached);
      }
      onSaved(next);
      setToken("");
      setStatus(
        "Сохранено. Бот начнёт получать сообщения в течение 10 секунд.",
      );
    } catch (saveError) {
      setError(aiErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!bot || !bot.hasToken) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const checked = await checkBot(bot.id);
      onSaved(checked);
      setStatus(
        `Бот @${checked.username ?? "?"} отвечает. Long polling активен.`,
      );
    } catch (checkError) {
      setError(aiErrorMessage(checkError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!bot) return;
    if (!window.confirm("Отвязать этого бота? Сам бот в Telegram останется.")) {
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await deleteBot(bot.id);
      setToken("");
      onDeleted();
      setStatus("Бот удалён из приложения (сам бот в Telegram остаётся).");
    } catch (removeError) {
      setError(aiErrorMessage(removeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={title}
      description={description}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {bot && (
            <Pill tone={bot.hasToken ? "green" : "amber"}>
              {bot.hasToken ? "токен есть" : "нет токена"}
            </Pill>
          )}
          {bot?.hasToken && (
            <GhostButton onClick={() => void verify()} disabled={busy}>
              Проверить
            </GhostButton>
          )}
          <PrimaryButton
            onClick={() => void save()}
            disabled={busy || (!bot && !token.trim())}
          >
            {busy ? "Сохранение…" : "Сохранить"}
          </PrimaryButton>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field
          label="Токен BotFather"
          hint="Создайте бота у @BotFather (/newbot). Токен хранится зашифрованным и никогда не показывается обратно. Бот может писать только тем, кто сам начал с ним диалог."
        >
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            aria-invalid={!tokenValid}
            className={`${inputClass} ${
              tokenValid ? "" : "border-red-700 focus:border-red-500"
            }`}
            placeholder={
              bot?.hasToken
                ? "оставьте пустым, чтобы не менять"
                : "123456789:AA…"
            }
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Username бота">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className={inputClass}
              placeholder="my_assistant_bot"
            />
          </Field>
          <Field
            label="Кому разрешено (Telegram id)"
            hint="Пусто = владельцы аккаунтов"
          >
            <input
              value={allowed}
              onChange={(event) => setAllowed(event.target.value)}
              className={inputClass}
              placeholder="через запятую"
            />
          </Field>
        </div>
        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label="Бот включён (long polling)"
          hint="Работает, пока запущен API."
        />
        <div>
          <p className="mb-1 text-xs text-zinc-400">Скиллы бота</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {skills.map((skill) => {
              const active = attached.includes(skill.slug);
              return (
                <label
                  key={skill.slug}
                  className={`flex min-w-0 items-center gap-2 text-xs ${
                    skill.enabled ? "text-zinc-300" : "text-zinc-600 opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={!skill.enabled}
                    onChange={(event) =>
                      setAttached((previous) =>
                        event.target.checked
                          ? [...previous, skill.slug]
                          : previous.filter((slug) => slug !== skill.slug),
                      )
                    }
                    className="h-3.5 w-3.5 shrink-0 accent-sky-500"
                  />
                  <span className="truncate">{skill.name}</span>
                  <span className="ml-auto truncate text-[10px] text-zinc-600">
                    {skill.enabled ? skill.slug : "выключен"}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
      {(error || status) && (
        <div className="mt-3 space-y-2">
          {error && (
            <div
              role="alert"
              className="break-words rounded-md border border-red-900/60 bg-red-950/40 px-2 py-1.5 text-xs text-red-300"
            >
              {error}
            </div>
          )}
          {status && (
            <div
              aria-live="polite"
              className="break-words rounded-md border border-emerald-900/60 bg-emerald-950/40 px-2 py-1.5 text-xs text-emerald-300"
            >
              {status}
            </div>
          )}
        </div>
      )}
      {bot?.lastError && (
        <p className="mt-2 break-words text-[11px] text-red-400">
          Последняя ошибка: {bot.lastError}
        </p>
      )}
      {bot && (
        <div className="mt-3">
          <GhostButton onClick={() => void remove()} disabled={busy} danger>
            Отвязать бота
          </GhostButton>
        </div>
      )}
    </Card>
  );
}

export function BotsPanel() {
  const { accounts } = useAppData();
  const [bots, setBots] = useState<BotView[]>([]);
  const [shared, setShared] = useState<BotView | null>(null);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [botList, skillList] = await Promise.all([
        listBots(),
        listSkills(),
      ]);
      setBots(botList.bots);
      setShared(botList.shared);
      setSkills(skillList.skills);
    } catch (loadError) {
      setError(aiErrorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="min-w-0 space-y-4">
      {error && (
        <div
          role="alert"
          className="break-words rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </div>
      )}
      <Card
        title="Как подключить бота"
        description="ИИ общается с вами через Telegram-бота. Бот не может писать незнакомым людям — только отвечать тем, кто сам начал с ним диалог. Переписку в обычных личных чатах ведёт душа аккаунта через TDLib."
      >
        <ol className="list-decimal space-y-1 pl-4 text-xs text-zinc-400">
          <li>
            Откройте{" "}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              @BotFather
            </a>{" "}
            → <code>/newbot</code>.
          </li>
          <li>Придумайте имя и username (должен заканчиваться на bot).</li>
          <li>
            BotFather пришлёт токен вида <code>123456789:AA…</code> — вставьте
            его в карточку ниже.
          </li>
          <li>Напишите своему боту /start — после этого он сможет отвечать.</li>
        </ol>
      </Card>

      <BotEditor
        accountId={null}
        title="Общий бот · создатель душ"
        description="Один бот на всё приложение. Через него вы просите ИИ создать или отредактировать душу, скиллы и автоматизации. У него есть скилл soul-creator."
        bot={shared}
        skills={skills}
        onSaved={(next) => {
          setShared(next);
          void load();
        }}
        onDeleted={() => {
          setShared(null);
          void load();
        }}
      />

      {accounts.map((account) => {
        const bot = bots.find((item) => item.accountId === account.id) ?? null;
        return (
          <AccountBotCard
            key={account.id}
            accountId={account.id}
            accountLabel={accountName(account)}
            bot={bot}
            skills={skills}
            onSaved={() => void load()}
          />
        );
      })}
    </div>
  );
}

function AccountBotCard({
  accountId,
  accountLabel,
  bot,
  skills,
  onSaved,
}: {
  accountId: string;
  accountLabel: string;
  bot: BotView | null;
  skills: SkillView[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<BotView | null>(bot);

  useEffect(() => {
    setDraft(bot);
  }, [bot]);

  return (
    <BotEditor
      accountId={accountId}
      title={`Бот аккаунта · ${accountLabel}`}
      description="Личный пульт этого аккаунта. Скиллы подбираются под задачу (например, telegram-assistant для работы с чатами)."
      bot={draft}
      skills={skills}
      onSaved={(next) => {
        setDraft(next);
        onSaved();
      }}
      onDeleted={() => {
        setDraft(null);
        onSaved();
      }}
    />
  );
}
