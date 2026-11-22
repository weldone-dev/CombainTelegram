"use client";

import type { ChatFolderSelection, FolderView } from "../../lib/types";

/**
 * Folder tabs above the chat list: "Все", "Архив" and every Telegram folder of
 * the account.
 */
export function ChatFolderTabs({
  folders,
  selected,
  loading,
  onSelect,
}: {
  folders: FolderView[];
  selected: ChatFolderSelection;
  loading: boolean;
  onSelect: (selection: ChatFolderSelection) => void;
}) {
  const isActive = (selection: ChatFolderSelection) => {
    if (selection.kind !== selected.kind) return false;
    if (selection.kind === "folder" && selected.kind === "folder") {
      return selection.id === selected.id;
    }
    return true;
  };

  const tabClass = (active: boolean) =>
    `shrink-0 rounded-full px-2.5 py-1 text-[11px] transition-colors ${
      active
        ? "bg-sky-500/15 font-medium text-sky-300"
        : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
    }`;

  return (
    <div
      className="flex gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5"
      role="tablist"
      aria-label="Папки чатов"
    >
      <button
        type="button"
        role="tab"
        aria-selected={isActive({ kind: "all" })}
        title="Все чаты"
        onClick={() => onSelect({ kind: "all" })}
        className={tabClass(isActive({ kind: "all" }))}
      >
        Все
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={isActive({ kind: "archive" })}
        title="Архивные чаты"
        onClick={() => onSelect({ kind: "archive" })}
        className={tabClass(isActive({ kind: "archive" }))}
      >
        Архив
      </button>
      {folders.map((folder) => {
        const selection: ChatFolderSelection = {
          kind: "folder",
          id: folder.id,
        };
        return (
          <button
            key={folder.id}
            type="button"
            role="tab"
            aria-selected={isActive(selection)}
            title={folder.title}
            onClick={() => onSelect(selection)}
            className={tabClass(isActive(selection))}
          >
            {folder.emoticon ? (
              <span aria-hidden="true" className="mr-1">
                {folder.emoticon}
              </span>
            ) : null}
            {folder.title}
          </button>
        );
      })}
      {loading && (
        <span className="shrink-0 self-center px-2 text-[11px] text-zinc-500">
          …
        </span>
      )}
    </div>
  );
}
