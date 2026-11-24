"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AiAccessList,
  type AiAccessPatch,
  type AiAccessView,
  type AiWarningResult,
  blockAi,
  getAiAccess,
  listAiAccess,
  setAiAccess,
  unblockAi,
  warnAi,
} from "../../lib/ai-access-api";
import { errorMessage } from "../../lib/api";

/** Decorated state of one chat, used by the list badges and the header chip. */
export interface AiChatStatus {
  allowed: boolean;
  blocked: boolean;
  warnings: number;
  reason: string | null;
}

export interface AiAccessStore {
  /** `GET /ai-access` of the active account is in flight. */
  loading: boolean;
  /** Last failed action; every surface shows it inline in Russian. */
  error: string | null;
  clearError: () => void;
  /** Whole-chat (`threadId = 0`) state of the chat list. */
  statusFor: (chatId: number) => AiChatStatus | undefined;
  viewFor: (chatId: number, threadId?: number) => AiAccessView | undefined;
  /** Loads one chat/topic view on demand and caches it. */
  ensureView: (
    chatId: number,
    threadId?: number,
  ) => Promise<AiAccessView | null>;
  setAccess: (
    chatId: number,
    patch: AiAccessPatch,
  ) => Promise<AiAccessView | null>;
  block: (
    chatId: number,
    options?: { reason?: string | null; threadId?: number },
  ) => Promise<AiAccessView | null>;
  unblock: (chatId: number, threadId?: number) => Promise<boolean>;
  warn: (
    chatId: number,
    options?: { reason?: string | null; threadId?: number },
  ) => Promise<AiWarningResult | null>;
  busyFor: (chatId: number, threadId?: number) => boolean;
  /** Re-runs the account-wide list request. */
  reload: () => void;
}

const AiAccessContext = createContext<AiAccessStore | null>(null);

function statusOf(view: AiAccessView): AiChatStatus {
  return {
    allowed: view.allowed,
    blocked: view.blocked,
    warnings: view.warnings,
    reason: view.reason,
  };
}

/** Seeds the store from `GET /ai-access` so a list render needs no extra call. */
function seed(list: AiAccessList): Map<number, Map<number, AiAccessView>> {
  const byChat = new Map<number, Map<number, AiAccessView>>();

  const put = (chatId: number, view: AiAccessView) => {
    const threads = byChat.get(chatId) ?? new Map<number, AiAccessView>();
    const current = threads.get(view.threadId);
    threads.set(view.threadId, current ? { ...current, ...view } : view);
    byChat.set(chatId, threads);
  };

  for (const row of list.accesses) {
    put(row.chatId, {
      allowed: row.enabled,
      blocked: false,
      reason: null,
      warnings: 0,
      soulId: row.soulId,
      note: row.note,
      threadId: row.threadId,
    });
  }
  for (const row of list.blocks) {
    put(row.chatId, {
      allowed: false,
      blocked: true,
      reason: row.reason,
      warnings: row.warnings,
      soulId: byChat.get(row.chatId)?.get(row.threadId)?.soulId ?? null,
      note: byChat.get(row.chatId)?.get(row.threadId)?.note ?? null,
      threadId: row.threadId,
    });
  }
  return byChat;
}

function mergeStatus(
  current: AiChatStatus,
  patch: Partial<AiAccessView>,
): AiChatStatus {
  return {
    allowed: patch.allowed ?? current.allowed,
    blocked: patch.blocked ?? current.blocked,
    warnings: patch.warnings ?? current.warnings,
    reason: patch.reason !== undefined ? patch.reason : current.reason,
  };
}

/**
 * Account-scoped cache of per-chat AI permissions. Mounted above the chat list
 * and the chat window so the list, the header, the info panel and the comment
 * drawer always read and update the same rows without reloading the page.
 */
export function AiAccessProvider({
  accountId,
  children,
}: {
  accountId: string | null;
  children: ReactNode;
}) {
  const [views, setViews] = useState<Map<number, Map<number, AiAccessView>>>(
    () => new Map(),
  );
  const [statuses, setStatuses] = useState<Map<number, AiChatStatus>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const viewsRef = useRef(views);
  const pendingViews = useRef(new Map<string, Promise<AiAccessView | null>>());
  viewsRef.current = views;

  const clearError = useCallback(() => setError(null), []);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is a manual refetch trigger
  useEffect(() => {
    if (!accountId) {
      setViews(new Map());
      setStatuses(new Map());
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    listAiAccess(accountId)
      .then((list) => {
        if (!active) return;
        const seeded = seed(list);
        setViews(seeded);
        setStatuses(() => {
          const next = new Map<number, AiChatStatus>();
          for (const [chatId, threads] of seeded) {
            const whole = threads.get(0);
            if (whole) next.set(chatId, statusOf(whole));
          }
          return next;
        });
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(`Не удалось загрузить доступ ИИ: ${errorMessage(caught)}`);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, reloadToken]);

  const setView = useCallback((chatId: number, view: AiAccessView) => {
    setViews((previous) => {
      const next = new Map(previous);
      const threads = new Map(next.get(chatId) ?? []);
      threads.set(view.threadId, view);
      next.set(chatId, threads);
      return next;
    });
    if (view.threadId === 0) {
      setStatuses((previous) => {
        const next = new Map(previous);
        next.set(chatId, statusOf(view));
        return next;
      });
    }
  }, []);

  const patchView = useCallback(
    (chatId: number, threadId: number, patch: Partial<AiAccessView>) => {
      setViews((previous) => {
        const next = new Map(previous);
        const threads = new Map(next.get(chatId) ?? []);
        const current = threads.get(threadId) ?? {
          allowed: false,
          blocked: false,
          reason: null,
          warnings: 0,
          soulId: null,
          note: null,
          threadId,
        };
        threads.set(threadId, { ...current, ...patch });
        next.set(chatId, threads);
        return next;
      });
      if (threadId === 0) {
        setStatuses((previous) => {
          const next = new Map(previous);
          next.set(
            chatId,
            mergeStatus(
              next.get(chatId) ?? {
                allowed: false,
                blocked: false,
                warnings: 0,
                reason: null,
              },
              patch,
            ),
          );
          return next;
        });
      }
    },
    [],
  );

  const currentView = useCallback(
    (chatId: number, threadId: number): AiAccessView | undefined =>
      viewsRef.current.get(chatId)?.get(threadId),
    [],
  );

  const ensureView = useCallback(
    async (chatId: number, threadId = 0): Promise<AiAccessView | null> => {
      if (!accountId) return null;
      const cached = currentView(chatId, threadId);
      if (cached) return cached;
      const key = `${accountId}:${chatId}:${threadId}`;
      const pending = pendingViews.current.get(key);
      if (pending) return pending;
      const request = getAiAccess(accountId, chatId, threadId)
        .then((view) => {
          setView(chatId, view);
          return view;
        })
        .catch((caught: unknown) => {
          setError(`Не удалось загрузить доступ ИИ: ${errorMessage(caught)}`);
          return null;
        })
        .finally(() => {
          pendingViews.current.delete(key);
        });
      pendingViews.current.set(key, request);
      return request;
    },
    [accountId, currentView, setView],
  );

  const runAction = useCallback(
    async (
      chatId: number,
      threadId: number,
      optimistic: Partial<AiAccessView>,
      request: () => Promise<AiAccessView>,
      apply: (view: AiAccessView) => void = (view) => setView(chatId, view),
    ): Promise<AiAccessView | null> => {
      if (!accountId) return null;
      const key = `${chatId}:${threadId}`;
      const before = currentView(chatId, threadId);
      setBusyKey(key);
      setError(null);
      patchView(chatId, threadId, optimistic);
      try {
        const view = await request();
        apply(view);
        return view;
      } catch (caught) {
        // Roll back exactly the fields the optimistic patch touched.
        patchView(chatId, threadId, {
          allowed: before?.allowed ?? false,
          blocked: before?.blocked ?? false,
          warnings: before?.warnings ?? 0,
          reason: before?.reason ?? null,
          soulId: before?.soulId ?? null,
          note: before?.note ?? null,
        });
        setError(`Не удалось изменить доступ ИИ: ${errorMessage(caught)}`);
        return null;
      } finally {
        setBusyKey((current) => (current === key ? null : current));
      }
    },
    [accountId, currentView, patchView, setView],
  );

  const setAccess = useCallback(
    (chatId: number, patch: AiAccessPatch): Promise<AiAccessView | null> => {
      const threadId = patch.threadId ?? 0;
      if (!accountId) return Promise.resolve(null);
      const before = currentView(chatId, threadId);
      const blocked = before?.blocked ?? false;
      const allowed =
        patch.enabled !== undefined
          ? patch.enabled && !blocked
          : (before?.allowed ?? false);
      return runAction(
        chatId,
        threadId,
        {
          allowed,
          soulId: patch.soulId !== undefined ? patch.soulId : before?.soulId,
          note: patch.note !== undefined ? patch.note : before?.note,
        },
        () => setAiAccess(accountId, chatId, { ...patch, threadId }),
      );
    },
    [accountId, currentView, runAction],
  );

  const block = useCallback(
    (
      chatId: number,
      options: { reason?: string | null; threadId?: number } = {},
    ): Promise<AiAccessView | null> => {
      const threadId = options.threadId ?? 0;
      if (!accountId) return Promise.resolve(null);
      const before = currentView(chatId, threadId);
      return runAction(
        chatId,
        threadId,
        {
          allowed: false,
          blocked: true,
          reason: options.reason ?? before?.reason ?? null,
        },
        () => blockAi(accountId, chatId, options),
      );
    },
    [accountId, currentView, runAction],
  );

  const unblock = useCallback(
    async (chatId: number, threadId = 0): Promise<boolean> => {
      if (!accountId) return false;
      const key = `${chatId}:${threadId}`;
      const before = currentView(chatId, threadId);
      setBusyKey(key);
      setError(null);
      patchView(chatId, threadId, {
        blocked: false,
        reason: null,
        warnings: 0,
      });
      try {
        try {
          await unblockAi(accountId, chatId, threadId);
        } catch (caught) {
          patchView(chatId, threadId, {
            blocked: before?.blocked ?? false,
            allowed: before?.allowed ?? false,
            warnings: before?.warnings ?? 0,
            reason: before?.reason ?? null,
          });
          setError(`Не удалось разблокировать ИИ: ${errorMessage(caught)}`);
          return false;
        }
        // Unblocking does not change the access row, so re-read the decision
        // instead of guessing whether the soul is allowed again. A failed
        // refresh keeps the optimistic state: the block is gone already.
        try {
          const fresh = await getAiAccess(accountId, chatId, threadId);
          setView(chatId, fresh);
        } catch {
          // The next list load reconciles the access row.
        }
        return true;
      } finally {
        setBusyKey((current) => (current === key ? null : current));
      }
    },
    [accountId, currentView, patchView, setView],
  );

  const warn = useCallback(
    (
      chatId: number,
      options: { reason?: string | null; threadId?: number } = {},
    ): Promise<AiWarningResult | null> => {
      const threadId = options.threadId ?? 0;
      if (!accountId) return Promise.resolve(null);
      const before = currentView(chatId, threadId);
      const warnings = (before?.warnings ?? 0) + 1;
      const blocked = warnings >= 3;
      const key = `${chatId}:${threadId}`;
      setBusyKey(key);
      setError(null);
      patchView(chatId, threadId, {
        warnings,
        blocked,
        allowed: blocked ? false : (before?.allowed ?? false),
        reason: blocked
          ? (options.reason ?? before?.reason ?? null)
          : before?.reason,
      });
      return warnAi(accountId, chatId, options)
        .then((result) => {
          patchView(chatId, threadId, {
            warnings: result.warnings,
            blocked: result.blocked,
            allowed:
              result.blocked || before?.blocked
                ? false
                : (before?.allowed ?? false),
          });
          return result;
        })
        .catch((caught: unknown) => {
          patchView(chatId, threadId, {
            warnings: before?.warnings ?? 0,
            blocked: before?.blocked ?? false,
            allowed: before?.allowed ?? false,
            reason: before?.reason ?? null,
          });
          setError(`Не удалось предупредить ИИ: ${errorMessage(caught)}`);
          return null;
        })
        .finally(() => {
          setBusyKey((current) => (current === key ? null : current));
        });
    },
    [accountId, currentView, patchView],
  );

  const value = useMemo<AiAccessStore>(
    () => ({
      loading,
      error,
      clearError,
      statusFor: (chatId) => statuses.get(chatId),
      viewFor: (chatId, threadId = 0) => views.get(chatId)?.get(threadId),
      ensureView,
      setAccess,
      block,
      unblock,
      warn,
      busyFor: (chatId, threadId = 0) => busyKey === `${chatId}:${threadId}`,
      reload,
    }),
    [
      loading,
      error,
      clearError,
      statuses,
      views,
      ensureView,
      setAccess,
      block,
      unblock,
      warn,
      busyKey,
      reload,
    ],
  );

  return (
    <AiAccessContext.Provider value={value}>
      {children}
    </AiAccessContext.Provider>
  );
}

export function useAiAccess(): AiAccessStore {
  const store = useContext(AiAccessContext);
  if (!store) {
    throw new Error("useAiAccess must be used inside AiAccessProvider");
  }
  return store;
}
