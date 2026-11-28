"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Me, Workspace } from "./api";
import { api, ApiError } from "./api";

export type Mode = "personal" | "business";

interface WorkspaceState {
  me: Me | null;
  error: string | null;
  mode: Mode;
  workspace: Workspace | null;
  businessWorkspaces: Workspace[];
  /** Switch mode; resolves false when Business mode has no workspace yet. */
  setMode: (mode: Mode) => boolean;
  selectWorkspace: (id: string) => void;
  createBusiness: (name: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WorkspaceState | null>(null);
const STORAGE_KEY = "jarvis.workspace";

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage unavailable (private browsing); the personal workspace is used next time.
  }
}

/**
 * Personal mode = the user's personal workspace; Business mode = one of their
 * business workspaces. Isolation between them is enforced by the database
 * (row-level security), not by this UI state.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.me();
      setMe(data);
      setError(null);
      setWorkspaceId((current) => {
        const wanted = current ?? readStored();
        const found = data.workspaces.find((w) => w.id === wanted);
        return (
          (found ?? data.workspaces.find((w) => w.type === "personal") ?? data.workspaces[0])?.id ??
          null
        );
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Could not load your account.");
    }
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (workspaceId) store(workspaceId);
  }, [workspaceId]);

  const value = useMemo<WorkspaceState>(() => {
    const workspaces = me?.workspaces ?? [];
    const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
    const businessWorkspaces = workspaces.filter((w) => w.type === "business");
    return {
      me,
      error,
      workspace,
      businessWorkspaces,
      mode: workspace?.type ?? "personal",
      setMode: (mode) => {
        const target =
          mode === "personal"
            ? workspaces.find((w) => w.type === "personal")
            : businessWorkspaces[0];
        if (!target) return false;
        setWorkspaceId(target.id);
        return true;
      },
      selectWorkspace: (id) => setWorkspaceId(id),
      createBusiness: async (name) => {
        const { workspace: created } = await api.createWorkspace(name);
        await refresh();
        setWorkspaceId(created.id);
      },
      refresh,
    };
  }, [me, error, workspaceId, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
