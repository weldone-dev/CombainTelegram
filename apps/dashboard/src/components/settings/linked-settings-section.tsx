"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Settings sections whose full UI already lives at a top-level route. We link
 * to the working page instead of duplicating its forms (and drifting from it).
 */
export function LinkedSettingsSection({
  title,
  description,
  pageHref,
  pageLabel,
  children,
}: {
  title: string;
  description: string;
  pageHref: string;
  pageLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        <p className="mt-1 text-xs text-zinc-500">{description}</p>
      </div>

      <section className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <p className="text-xs text-zinc-400">
          Раздел уже есть в основном меню. Здесь мы не дублируем его форму,
          чтобы настройки не разъехались: всё редактируется на рабочей странице.
        </p>
        <Link
          href={pageHref}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
        >
          Открыть «{pageLabel}»<span aria-hidden="true">→</span>
        </Link>
        {children && <div className="mt-4">{children}</div>}
      </section>
    </div>
  );
}
