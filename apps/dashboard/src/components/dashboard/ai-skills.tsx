"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createSkill,
  deleteSkill,
  listSkills,
  type SkillView,
  updateSkill,
} from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
import { Card, Field, inputClass, Pill, textareaClass } from "./ai-ui";

interface Draft {
  id: string | null;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  tools: string;
  enabled: boolean;
  origin: string;
}

function draftOf(skill: SkillView | null): Draft {
  return {
    id: skill?.id ?? null,
    slug: skill?.slug ?? "",
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    instructions: skill?.instructions ?? "",
    tools: skill?.tools.join(", ") ?? "",
    enabled: skill?.enabled ?? true,
    origin: skill?.origin ?? "user",
  };
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [draft, setDraft] = useState<Draft>(() => draftOf(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async (selectSlug?: string) => {
    setError(null);
    try {
      const result = await listSkills();
      setSkills(result.skills);
      const next =
        result.skills.find((skill) => skill.slug === selectSlug) ??
        result.skills[0] ??
        null;
      setDraft(draftOf(next));
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft.name.trim() || !draft.instructions.trim()) {
      setError("Нужны название и инструкции");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const body = {
        slug: draft.slug,
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        tools: draft.tools
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        enabled: draft.enabled,
      };
      const savedSkill = draft.id
        ? await updateSkill(draft.id, body)
        : await createSkill(body);
      setDraft(draftOf(savedSkill));
      setSaved(`Скилл «${savedSkill.name}» сохранён`);
      await load(savedSkill.slug);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id) return;
    if (!window.confirm(`Удалить скилл «${draft.name}»?`)) return;
    setBusy(true);
    try {
      await deleteSkill(draft.id);
      setSaved("Скилл удалён");
      await load();
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Card
        title="Скиллы"
        description="Инструкции для агента"
        actions={
          <button
            type="button"
            onClick={() => {
              setDraft(draftOf(null));
              setSaved(null);
            }}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            + Новый
          </button>
        }
      >
        <div className="space-y-1">
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => {
                setDraft(draftOf(skill));
                setSaved(null);
              }}
              className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left text-sm ${
                draft.id === skill.id
                  ? "bg-sky-500/15 text-sky-200"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                {skill.origin === "system" && <Pill>built-in</Pill>}
                {!skill.enabled && <Pill tone="red">off</Pill>}
              </span>
              <span className="truncate text-[11px] text-zinc-500">
                {skill.slug}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {saved && (
          <div className="rounded-md border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
            {saved}
          </div>
        )}
        <Card
          title={draft.id ? "Редактирование скилла" : "Новый скилл"}
          description="Скилл — это markdown-инструкция плюс необязательный список инструментов."
          actions={
            <div className="flex gap-2">
              {draft.id && draft.origin !== "system" && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  className="rounded-md border border-red-900/60 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40"
                >
                  Удалить
                </button>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                Сохранить
              </button>
            </div>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Slug"
              hint="Латиница, цифры, дефис. Не меняется после создания."
            >
              <input
                value={draft.slug}
                disabled={Boolean(draft.id)}
                onChange={(event) =>
                  setDraft({ ...draft, slug: event.target.value })
                }
                className={inputClass}
                placeholder="my-skill"
              />
            </Field>
            <Field label="Название">
              <input
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Описание" className="sm:col-span-2">
              <input
                value={draft.description}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field
              label="Инструменты (через запятую)"
              hint="Пусто = все инструменты, разрешённые политикой."
              className="sm:col-span-2"
            >
              <input
                value={draft.tools}
                onChange={(event) =>
                  setDraft({ ...draft, tools: event.target.value })
                }
                className={inputClass}
                placeholder="messages_history, messages_send, memory_view"
              />
            </Field>
            <Field label="Инструкции" className="sm:col-span-2">
              <textarea
                value={draft.instructions}
                onChange={(event) =>
                  setDraft({ ...draft, instructions: event.target.value })
                }
                className={`${textareaClass} min-h-64 font-mono text-xs`}
              />
            </Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            Скилл включён
          </label>
        </Card>
      </div>
    </div>
  );
}
