"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  ErrorBanner,
  GhostButton,
  OkBanner,
  PrimaryButton,
  textareaClass,
} from "../../components/dashboard/ai-ui";
import {
  EVE_PERSONA_DOC_KINDS,
  type EvePersonaDocKind,
  type EvePersonaDocView,
  eveErrorMessage,
  generatePersonaDocs,
  getPersonaDocs,
  savePersonaDoc,
} from "../../lib/eve-api";

type DocMap = Record<EvePersonaDocKind, string>;

const EMPTY_DOCS: DocMap = {
  persona: "",
  speech: "",
  boundaries: "",
  communication: "",
};

function mergeDocs(current: DocMap, docs: EvePersonaDocView[]): DocMap {
  const next: DocMap = { ...current };
  for (const doc of docs) {
    if (doc.kind in next && typeof doc.content === "string") {
      next[doc.kind as EvePersonaDocKind] = doc.content;
    }
  }
  return next;
}

/**
 * Markdown editor for the four girl-agent persona files. Generation is done on
 * Nest (`POST .../generate`) so the browser never owns prompt construction;
 * this card only edits and persists the resulting text.
 */
export function PersonaDocsCard({
  personaId,
  onNotice,
}: {
  personaId: string;
  onNotice: (message: string) => void;
}) {
  const [active, setActive] = useState<EvePersonaDocKind>("persona");
  const [docs, setDocs] = useState<DocMap>(EMPTY_DOCS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(
    async (announce = false) => {
      setLoading(true);
      setError(null);
      try {
        const list = await getPersonaDocs(personaId);
        setDocs((current) => mergeDocs(current, list));
        setDirty(false);
        if (announce) setSaved("Документы загружены");
      } catch (loadError) {
        setError(eveErrorMessage(loadError));
      } finally {
        setLoading(false);
      }
    },
    [personaId],
  );

  useEffect(() => {
    setDocs(EMPTY_DOCS);
    setSaved(null);
    setDirty(false);
    setActive("persona");
    void load();
  }, [load]);

  const meta = EVE_PERSONA_DOC_KINDS.find((item) => item.kind === active) ?? {
    kind: "persona",
    label: "persona",
    hint: "",
  };
  const content = docs[active];

  const save = async () => {
    setError(null);
    setSaved(null);
    if (!content.trim()) {
      setError("Текст документа не может быть пустым");
      return;
    }
    setSaving(true);
    try {
      const result = await savePersonaDoc(personaId, active, content);
      setDocs((current) => ({ ...current, [active]: result.content }));
      setSaved(`Документ ${active} сохранён`);
      setDirty(false);
      onNotice(`Документ ${active} сохранён`);
    } catch (saveError) {
      setError(eveErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    if (
      !window.confirm(
        "Сгенерировать все четыре документа заново? Ручные правки в них будут перезаписаны.",
      )
    ) {
      return;
    }
    setError(null);
    setSaved(null);
    setGenerating(true);
    try {
      const list = await generatePersonaDocs(personaId);
      if (list.length === 0) {
        throw new Error(
          "Nest вернул пустой ответ генерации. Проверьте роут POST /internal/eve/personas/:id/generate",
        );
      }
      setDocs((current) => mergeDocs(current, list));
      setDirty(false);
      setSaved("Документы сгенерированы");
      onNotice("Документы персоны сгенерированы");
    } catch (generateError) {
      setError(eveErrorMessage(generateError));
    } finally {
      setGenerating(false);
    }
  };

  const reload = () => {
    if (
      dirty &&
      !window.confirm("Сбросить несохранённые правки и перечитать документы?")
    ) {
      return;
    }
    void load(true);
  };

  const busy = loading || saving || generating;

  return (
    <Card
      title="Документы персоны"
      description="Четыре markdown-файла в стиле girl-agent. Их видит промпт Eve; правьте вручную или сгенерируйте шаблон из имени, возраста и национальности."
      actions={
        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={reload} disabled={busy}>
            {loading ? "Загрузка…" : "Обновить"}
          </GhostButton>
          <GhostButton onClick={() => void generate()} disabled={busy}>
            {generating ? "Генерация…" : "Сгенерировать"}
          </GhostButton>
          <PrimaryButton
            onClick={() => void save()}
            disabled={busy || !dirty || !content.trim()}
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </PrimaryButton>
        </div>
      }
    >
      <ErrorBanner message={error} />
      <OkBanner message={saved} />

      {error && !loading && (
        <p className="mb-3 text-xs text-zinc-500">
          Если Nest ещё не отдаёт документы, нужен роут{" "}
          <code className="text-zinc-400">
            GET /internal/eve/personas/:id/docs
          </code>{" "}
          (и <code className="text-zinc-400">PUT</code> для сохранения).
        </p>
      )}

      <div
        role="tablist"
        aria-label="Документы персоны"
        className="mb-2 flex flex-wrap gap-1"
      >
        {EVE_PERSONA_DOC_KINDS.map((item) => (
          <button
            key={item.kind}
            type="button"
            role="tab"
            aria-selected={item.kind === active}
            onClick={() => setActive(item.kind)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${
              item.kind === active
                ? "bg-sky-500/15 text-sky-200"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {item.label}
            {docs[item.kind].trim() ? "" : " · пусто"}
          </button>
        ))}
      </div>

      <p className="mb-2 text-[11px] text-zinc-500">{meta.hint}</p>

      {loading && !content ? (
        <div
          className="h-64 animate-pulse rounded-md bg-zinc-800/60"
          aria-hidden="true"
        />
      ) : (
        <textarea
          aria-label={`Документ ${active}`}
          value={content}
          onChange={(event) => {
            setDocs((current) => ({
              ...current,
              [active]: event.target.value,
            }));
            setDirty(true);
            setSaved(null);
          }}
          className={`${textareaClass} min-h-64 font-mono text-xs`}
          spellCheck={false}
          autoComplete="off"
          placeholder={`# ${meta.label}\n\nТекст документа…`}
        />
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span>
          {content.length} символов · {content.split("\n").length} строк
        </span>
        <span>
          {dirty ? "Есть несохранённые правки" : "Все изменения сохранены"}
        </span>
      </div>
    </Card>
  );
}
