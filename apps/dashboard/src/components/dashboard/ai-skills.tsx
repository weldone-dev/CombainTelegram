"use client";

import { useCallback, useEffect, useState } from "react";
import {
  aiErrorMessage,
  createSkill,
  deleteSkill,
  listSkills,
  type SkillView,
  updateSkill,
} from "../../lib/ai-api";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
  PrimaryButton,
  textareaClass,
} from "./ai-ui";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

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
      setError(aiErrorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const slugValid =
    Boolean(draft.id) ||
    draft.slug.trim() === "" ||
    SLUG_RE.test(draft.slug.trim());
  const canSave =
    !busy && Boolean(draft.name.trim()) && Boolean(draft.instructions.trim());

  const save = async () => {
    if (!draft.name.trim()) {
      setError("Укажите название скилла");
      return;
    }
    if (!draft.id && !slugValid) {
      setError(
        "Slug: латиница, цифры, дефис или подчёркивание, 2–64 символа, начинается с буквы или цифры",
      );
      return;
    }
    if (!draft.instructions.trim()) {
      setError("Нужны инструкции для скилла");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions.trim(),
        tools: draft.tools
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        enabled: draft.enabled,
      };
      const savedSkill = draft.id
        ? await updateSkill(draft.id, body)
        : await createSkill({ ...body, slug: draft.slug.trim().toLowerCase() });
      setDraft(draftOf(savedSkill));
      setSaved(`Скилл «${savedSkill.name}» сохранён`);
      await load(savedSkill.slug);
    } catch (saveError) {
      setError(aiErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id) return;
    if (!window.confirm(`Удалить скилл «${draft.name}»?`)) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await deleteSkill(draft.id);
      await load();
      setSaved("Скилл удалён");
    } catch (removeError) {
      setError(aiErrorMessage(removeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Card
        title="Скиллы"
        description="Инструкции для агента"
        actions={
          <GhostButton
            onClick={() => {
              setDraft(draftOf(null));
              setSaved(null);
              setError(null);
            }}
          >
            + Новый
          </GhostButton>
        }
      >
        <div className="space-y-1">
          {skills.length === 0 && (
            <p className="text-xs text-zinc-500">
              Скиллов пока нет. Создайте первый справа.
            </p>
          )}
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

      <div className="min-w-0 space-y-4">
        <ErrorBanner message={error} />
        <OkBanner message={saved} />
        <Card
          title={draft.id ? "Редактирование скилла" : "Новый скилл"}
          description="Скилл — это markdown-инструкция плюс необязательный список инструментов."
          actions={
            <div className="flex flex-wrap gap-2">
              {draft.id && draft.origin !== "system" && (
                <GhostButton
                  onClick={() => void remove()}
                  disabled={busy}
                  danger
                >
                  Удалить
                </GhostButton>
              )}
              <PrimaryButton onClick={() => void save()} disabled={!canSave}>
                {busy ? "Сохранение…" : "Сохранить"}
              </PrimaryButton>
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
                aria-invalid={!slugValid}
                className={`${inputClass} ${
                  slugValid ? "" : "border-red-700 focus:border-red-500"
                }`}
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
              className="h-3.5 w-3.5 accent-sky-500"
            />
            Скилл включён
          </label>
        </Card>
      </div>
    </div>
  );
}
