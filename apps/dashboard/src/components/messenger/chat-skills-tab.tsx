"use client";

import { useEffect, useState } from "react";
import { aiErrorMessage, listSkills, type SkillView } from "../../lib/ai-api";
import { getChatSkills, removeChatSkills, setChatSkills } from "./chat-ai-api";
import {
  EmptyNote,
  PanelCard,
  RowsSkeleton,
  SMALL_BUTTON,
  TabError,
  TabHeader,
  useCachedResource,
} from "./chat-tab-ui";

function skillName(skills: SkillView[], slug: string): string {
  return skills.find((skill) => skill.slug === slug)?.name ?? slug;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((slug) => b.includes(slug));
}

/**
 * «Скиллы» tab: the effective set of one chat/topic (chat override or soul
 * defaults), the soul's own set and the whole catalog with a save/reset flow.
 */
export function ChatSkillsTab({
  accountId,
  chatId,
  threadId,
}: {
  accountId: string;
  chatId: number;
  threadId: number;
}) {
  const skills = useCachedResource(
    `chat-skills:${accountId}:${chatId}:${threadId}`,
    () => getChatSkills(accountId, chatId, threadId),
  );
  const catalog = useCachedResource("skills-catalog", () => listSkills());
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A different chat/topic starts from its own stored set, not the previous draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on scope change only
  useEffect(() => {
    setDraft(null);
    setError(null);
    setNotice(null);
  }, [accountId, chatId, threadId]);

  const catalogSkills = catalog.data?.skills ?? [];
  const known = [...catalogSkills, ...(skills.data?.skills ?? [])];
  const saved = skills.data?.effective ?? [];
  const selected = draft ?? saved;
  const changed = draft !== null && !sameSet(draft, saved);
  const source = skills.data?.source ?? "soul";
  const emptyOverride = source === "chat" && saved.length === 0;

  const toggle = (slug: string) => {
    setNotice(null);
    setDraft((previous) => {
      const base = previous ?? saved;
      return base.includes(slug)
        ? base.filter((item) => item !== slug)
        : [...base, slug];
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await setChatSkills(accountId, chatId, selected, threadId);
      setDraft(result.effective);
      setNotice(
        result.effective.length === 0
          ? "Сохранено: в этом чате ИИ работает без скиллов"
          : "Набор скиллов сохранён",
      );
      skills.reload();
    } catch (caught) {
      setError(aiErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const resetToSoul = async () => {
    setResetBusy(true);
    setError(null);
    setNotice(null);
    try {
      await removeChatSkills(accountId, chatId, threadId);
      setDraft(null);
      setNotice("Набор души восстановлен");
      skills.reload();
    } catch (caught) {
      setError(aiErrorMessage(caught));
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <TabHeader
        threadId={threadId}
        onRefresh={() => {
          skills.reload();
          catalog.reload();
        }}
        refreshing={skills.loading}
      >
        {skills.data && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] ${
              source === "chat"
                ? "bg-sky-500/15 text-sky-300"
                : "bg-violet-500/15 text-violet-300"
            }`}
          >
            {source === "chat" ? "набор чата" : "набор души"}
          </span>
        )}
      </TabHeader>

      {skills.loading && !skills.data && <RowsSkeleton rows={3} />}
      {skills.error && <TabError text={skills.error} onRetry={skills.reload} />}
      {catalog.error && (
        <TabError text={catalog.error} onRetry={catalog.reload} />
      )}

      {skills.data && (
        <>
          {emptyOverride && (
            <EmptyNote>
              Сохранён пустой набор: в этом чате ИИ работает без скиллов.
              Снимите галочки и сохраните или верните набор души.
            </EmptyNote>
          )}

          <PanelCard
            title="Действуют сейчас"
            hint="Скиллы, которые ИИ использует в этом чате"
          >
            {saved.length === 0 ? (
              <p className="mt-2 text-[11px] text-zinc-500">Скиллов нет.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1">
                {saved.map((slug) => (
                  <span
                    key={slug}
                    title={slug}
                    className="rounded-full border border-sky-800/60 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200"
                  >
                    {skillName(known, slug)}
                  </span>
                ))}
              </div>
            )}
          </PanelCard>

          <PanelCard
            title="Набор души"
            hint="Что душа использует в остальных чатах"
          >
            {skills.data.defaults.length === 0 ? (
              <p className="mt-2 text-[11px] text-zinc-500">
                У души нет скиллов по умолчанию.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1">
                {skills.data.defaults.map((slug) => (
                  <span
                    key={slug}
                    title={slug}
                    className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
                  >
                    {skillName(known, slug)}
                  </span>
                ))}
              </div>
            )}
            <button
              type="button"
              disabled={resetBusy || saving || source === "soul"}
              onClick={() => void resetToSoul()}
              title={
                source === "soul"
                  ? "Душа и так задаёт набор этого чата"
                  : "Удалить набор чата и вернуть скиллы души"
              }
              className={`mt-2 ${SMALL_BUTTON}`}
            >
              {resetBusy ? "…" : "Вернуть набор души"}
            </button>
          </PanelCard>

          <PanelCard
            title="Каталог"
            hint={`Выбрано: ${selected.length} из ${catalogSkills.length}`}
          >
            {catalog.loading && !catalog.data ? (
              <RowsSkeleton rows={3} />
            ) : catalogSkills.length === 0 ? (
              <EmptyNote>
                Скиллов пока нет. Создайте их в разделе ИИ — они появятся здесь.
              </EmptyNote>
            ) : (
              <div className="mt-2 space-y-1.5">
                {catalogSkills.map((skill) => {
                  const checked = selected.includes(skill.slug);
                  const disabled = saving || (!skill.enabled && !checked);
                  return (
                    <label
                      key={skill.id}
                      className={`flex min-w-0 items-start gap-2 rounded-lg border px-2 py-1.5 text-xs ${
                        checked
                          ? "border-sky-700/70 bg-sky-500/10 text-sky-200"
                          : "border-zinc-800 text-zinc-300"
                      } ${disabled ? "opacity-60" : "cursor-pointer"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        autoComplete="off"
                        onChange={() => toggle(skill.slug)}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sky-500"
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {skill.name}
                          {!skill.enabled && (
                            <span className="ml-1 text-[10px] font-normal text-zinc-500">
                              выключен
                            </span>
                          )}
                        </span>
                        {skill.description && (
                          <span className="mt-0.5 block break-words text-[11px] text-zinc-500">
                            {skill.description}
                          </span>
                        )}
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600">
                          {skill.slug}
                          {skill.tools.length > 0
                            ? ` · инструментов: ${skill.tools.length}`
                            : ""}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <p className="mt-2 text-[10px] text-zinc-600">
              Сохранение пустого набора — это осознанное «без скиллов», а не
              возврат к душе.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={saving || resetBusy || !changed}
                onClick={() => void save()}
                title="Сохранить выбранный набор для этого чата"
                className="rounded bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
              >
                {saving ? "…" : "Сохранить"}
              </button>
              <button
                type="button"
                disabled={saving || resetBusy || draft === null}
                onClick={() => setDraft(null)}
                title="Отменить несохранённые изменения"
                className={SMALL_BUTTON}
              >
                Отменить
              </button>
              {changed && (
                <span className="text-[10px] text-amber-300">
                  Есть несохранённые изменения
                </span>
              )}
            </div>
          </PanelCard>
        </>
      )}

      {error && (
        <p role="alert" className="text-[11px] text-red-300">
          {error}
        </p>
      )}
      {notice && <p className="text-[11px] text-emerald-300">{notice}</p>}
    </div>
  );
}
