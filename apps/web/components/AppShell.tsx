"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { SystemStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { getSupabase } from "@/lib/supabase/client";
import { useWorkspace, WorkspaceProvider } from "@/lib/workspace-context";
import { ChatIcon, CoreIcon, LogoutIcon, MemoryIcon } from "./icons";
import { ModeSwitch } from "./ModeSwitch";

/** Only sections that actually exist are listed; more are added as they ship. */
const NAV = [
  { href: "/app", label: "Command", icon: CoreIcon, match: (p: string) => p === "/app" },
  {
    href: "/app/chat",
    label: "Chat",
    icon: ChatIcon,
    match: (p: string) => p.startsWith("/app/chat"),
  },
  {
    href: "/app/memory",
    label: "Memory",
    icon: MemoryIcon,
    match: (p: string) => p.startsWith("/app/memory"),
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, workspace, error } = useWorkspace();
  const status = useSystemStatus();

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const coreOnline = status?.ai.status === "configured";

  return (
    <div className="app">
      <aside className="rail" aria-label="Main navigation">
        <Link href="/app" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-text">
            JARVIS
            <small>Libz AI Automation</small>
          </span>
        </Link>
        <nav className="rail-nav">
          {NAV.map(({ href, label, icon: Icon, match }) => (
            <Link key={href} href={href} className={`rail-link ${match(pathname) ? "active" : ""}`}>
              <Icon />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="rail-foot">
          <div className="who">
            <span className="who-name">{me?.profile.displayName ?? me?.user.email ?? "…"}</span>
            <span className="muted small">{workspace?.name ?? ""}</span>
          </div>
          <button
            className="btn btn-ghost icon-btn"
            onClick={() => void signOut()}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogoutIcon />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Link href="/app" className="brand brand-compact" aria-label="JARVIS home">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-text">JARVIS</span>
          </Link>
          <ModeSwitch />
          <div
            className="topbar-status"
            title={coreOnline ? "AI core online" : "AI core not configured"}
          >
            <span className={`dot ${status ? (coreOnline ? "dot-ok" : "dot-warn") : "dot-idle"}`} />
            <span className="topbar-status-label">
              {status ? (coreOnline ? "Core online" : "Core offline") : "Connecting"}
            </span>
          </div>
          <button
            className="btn btn-ghost icon-btn mobile-only"
            onClick={() => void signOut()}
            aria-label="Sign out"
          >
            <LogoutIcon />
          </button>
        </header>

        {error && (
          <p className="alert alert-error shell-alert" role="alert">
            {error}
          </p>
        )}

        <div className="content">{children}</div>
      </div>

      <nav className="tabbar" aria-label="Main navigation">
        {NAV.map(({ href, label, icon: Icon, match }) => (
          <Link key={href} href={href} className={`tab ${match(pathname) ? "active" : ""}`}>
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Shared, lightly polled system status for the shell indicator. */
function useSystemStatus(): SystemStatus | null {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      api
        .status()
        .then((s) => active && setStatus(s))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return status;
}
