"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { SystemStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { getSupabase } from "@/lib/supabase/client";
import { crm, TASKS_CHANGED } from "@/lib/crm";
import type { Mode } from "@/lib/workspace-context";
import { useWorkspace, WorkspaceProvider } from "@/lib/workspace-context";
import {
  ActivityIcon,
  ChatIcon,
  ClientsIcon,
  CoreIcon,
  LogoutIcon,
  MemoryIcon,
  MoreIcon,
  PipelineIcon,
  ProjectsIcon,
  ReportsIcon,
  SettingsIcon,
  TasksIcon,
} from "./icons";
import { ModeSwitch } from "./ModeSwitch";

type NavItem = {
  href: string;
  label: string;
  icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactNode;
  match: (p: string) => boolean;
  modes: Mode[];
  /** Shown in the phone tab bar; everything else lives under "More". */
  tab: Mode[];
};

const at = (prefix: string) => (p: string) => p === prefix || p.startsWith(`${prefix}/`);

/** Only sections that actually exist are listed; more are added as they ship. */
const NAV: NavItem[] = [
  {
    href: "/app",
    label: "Command",
    icon: CoreIcon,
    match: (p) => p === "/app",
    modes: ["personal", "business"],
    tab: ["personal", "business"],
  },
  {
    href: "/app/chat",
    label: "Chat",
    icon: ChatIcon,
    match: at("/app/chat"),
    modes: ["personal", "business"],
    tab: ["personal", "business"],
  },
  {
    href: "/app/clients",
    label: "Clients",
    icon: ClientsIcon,
    match: at("/app/clients"),
    modes: ["business"],
    tab: ["business"],
  },
  {
    href: "/app/pipeline",
    label: "Pipeline",
    icon: PipelineIcon,
    match: at("/app/pipeline"),
    modes: ["business"],
    tab: ["business"],
  },
  {
    href: "/app/projects",
    label: "Projects",
    icon: ProjectsIcon,
    match: at("/app/projects"),
    modes: ["business"],
    tab: [],
  },
  {
    href: "/app/tasks",
    label: "Tasks",
    icon: TasksIcon,
    match: at("/app/tasks"),
    modes: ["personal", "business"],
    tab: ["personal", "business"],
  },
  {
    href: "/app/reports",
    label: "Reports",
    icon: ReportsIcon,
    match: at("/app/reports"),
    modes: ["business"],
    tab: [],
  },
  {
    href: "/app/memory",
    label: "Memory",
    icon: MemoryIcon,
    match: at("/app/memory"),
    modes: ["personal", "business"],
    tab: ["personal"],
  },
  {
    href: "/app/activity",
    label: "Activity",
    icon: ActivityIcon,
    match: at("/app/activity"),
    modes: ["personal", "business"],
    tab: [],
  },
  {
    href: "/app/settings",
    label: "Settings",
    icon: SettingsIcon,
    match: at("/app/settings"),
    modes: ["personal", "business"],
    tab: [],
  },
];

export function navFor(mode: Mode) {
  const items = NAV.filter((n) => n.modes.includes(mode));
  return {
    rail: items,
    tabs: items.filter((n) => n.tab.includes(mode)),
    more: items.filter((n) => !n.tab.includes(mode)),
  };
}

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
  const { me, workspace, error, mode } = useWorkspace();
  const status = useSystemStatus();
  const overdue = useOverdueCount(workspace?.id, pathname);
  const nav = navFor(mode);
  const moreActive = nav.more.some((n) => n.match(pathname)) || pathname === "/app/more";
  const badge = (href: string) =>
    href === "/app/tasks" && overdue > 0 ? (
      <span className="nav-badge" aria-label={`${overdue} overdue`}>
        {overdue > 99 ? "99+" : overdue}
      </span>
    ) : null;

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
            SIR LIBZ
            <small>Libz Enterprises Manager</small>
          </span>
        </Link>
        <nav className="rail-nav">
          {nav.rail.map(({ href, label, icon: Icon, match }) => (
            <Link key={href} href={href} className={`rail-link ${match(pathname) ? "active" : ""}`}>
              <Icon />
              <span>{label}</span>
              {badge(href)}
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
          <Link href="/app" className="brand brand-compact" aria-label="SIR LIBZ home">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-text">SIR LIBZ</span>
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
        {nav.tabs.map(({ href, label, icon: Icon, match }) => (
          <Link key={href} href={href} className={`tab ${match(pathname) ? "active" : ""}`}>
            <span className="tab-icon">
              <Icon />
              {badge(href)}
            </span>
            <span>{label}</span>
          </Link>
        ))}
        <Link href="/app/more" className={`tab ${moreActive ? "active" : ""}`}>
          <span className="tab-icon">
            <MoreIcon />
          </span>
          <span>More</span>
        </Link>
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

/** Real count of open tasks due before today, refreshed on navigation. */
function useOverdueCount(workspaceId: string | undefined, pathname: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const load = () =>
      crm.tasks
        .list(workspaceId, { view: "overdue", limit: 1 })
        .then((r) => active && setCount(r.total))
        .catch(() => active && setCount(0));
    void load();
    window.addEventListener(TASKS_CHANGED, load);
    return () => {
      active = false;
      window.removeEventListener(TASKS_CHANGED, load);
    };
  }, [workspaceId, pathname]);
  return count;
}
