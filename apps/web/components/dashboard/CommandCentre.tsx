"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AuditEvent, ConversationSummary, Member, SystemStatus, Usage } from "@/lib/api";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { ArrowIcon, SendIcon } from "../icons";
import { TodayPanels } from "../crm/TodayPanels";
import { MicButton } from "../MicButton";

function greeting(date: Date): string {
  const h = date.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const ACTION_LABELS: Record<string, string> = {
  "user.signed_up": "Account created",
  "workspace.created": "Workspace created",
  "workspace.updated": "Workspace updated",
  "invitation.created": "Invitation sent",
  "invitation.accepted": "Invitation accepted",
  "invitation.revoked": "Invitation revoked",
  "company.created": "Client added",
  "company.deleted": "Client deleted",
  "contact.created": "Contact added",
  "contact.deleted": "Contact deleted",
  "deal.created": "Deal added",
  "deal.deleted": "Deal deleted",
  "deal.stage_changed": "Deal moved",
  "project.created": "Project added",
  "project.deleted": "Project deleted",
  "task.created": "Task added",
  "task.completed": "Task completed",
  "task.deleted": "Task deleted",
  "activity.created": "Activity logged",
  "activity.deleted": "Activity deleted",
  "jarvis.proposal_created": "Sir Libz suggested a change",
  "jarvis.proposal_confirmed": "Sir Libz suggestion confirmed",
  "jarvis.proposal_dismissed": "Sir Libz suggestion dismissed",
  "member.role_changed": "Member role changed",
  "member.removed": "Member removed",
  "member.left": "Member left",
};

export function CommandCentre() {
  const router = useRouter();
  const { me, workspace, mode } = useWorkspace();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [recent, setRecent] = useState<ConversationSummary[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [command, setCommand] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void api
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
    void api
      .usage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setRecent(null);
    setMembers(null);
    setEvents(null);
    void api
      .conversations(workspace.id)
      .then((r) => setRecent(r.conversations.slice(0, 5)))
      .catch(() => setRecent([]));
    void api
      .members(workspace.id)
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
    if (workspace.role === "owner" || workspace.role === "admin") {
      void api
        .auditLogs(workspace.id, 6)
        .then((r) => setEvents(r.events))
        .catch(() => setEvents([]));
    } else {
      setEvents([]);
    }
  }, [workspace]);

  const firstName = me?.profile.displayName?.split(" ")[0];
  const coreOnline = status?.ai.status === "configured";
  const pct = usage ? Math.min(100, Math.round((usage.usedToday / usage.dailyLimit) * 100)) : 0;

  return (
    <div className="dash">
      {/* Hero / command bar */}
      <section className="panel hero">
        <div className="hero-text">
          <p className="eyebrow">
            {mode === "business" ? "Business mode" : "Personal mode"} · {workspace?.name ?? "…"}
          </p>
          <h1>
            {greeting(now)}
            {firstName ? `, ${firstName}` : ""}.
          </h1>
          <p className="muted">
            {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}{" "}
            · {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </p>
          <form
            className="command"
            onSubmit={(e) => {
              e.preventDefault();
              const q = command.trim();
              if (q) router.push(`/app/chat?q=${encodeURIComponent(q)}`);
            }}
          >
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Ask Sir Libz anything…"
              aria-label="Ask Sir Libz"
              maxLength={20_000}
              disabled={workspace?.role === "viewer"}
            />
            <MicButton onText={setCommand} disabled={workspace?.role === "viewer"} />
            <button
              className="btn btn-primary icon-btn"
              disabled={!command.trim()}
              aria-label="Send to Sir Libz"
            >
              <SendIcon />
            </button>
          </form>
        </div>
        <div className="hero-core" aria-hidden="true">
          <div className={`orb ${coreOnline ? "" : "orb-off"}`} />
          <span className="core-label">
            {coreOnline ? "CORE ONLINE" : status ? "CORE OFFLINE" : "CONNECTING"}
          </span>
        </div>
      </section>

      <TodayPanels />

      {/* AI core status */}
      <section className="panel" aria-labelledby="sys-title">
        <h2 className="panel-label" id="sys-title">
          System status
        </h2>
        {!status ? (
          <p className="muted small">Loading…</p>
        ) : (
          <ul className="status-list">
            <li>
              <span className={`dot ${coreOnline ? "dot-ok" : "dot-warn"}`} />
              <span>AI core</span>
              <span className="status-value">
                {coreOnline
                  ? status.ai.providers.map((p) => p.provider).join(", ")
                  : "Not configured"}
              </span>
            </li>
            <li>
              <span
                className={`dot ${status.ai.lastReply?.status === "complete" ? "dot-ok" : status.ai.lastReply ? "dot-warn" : "dot-idle"}`}
              />
              <span>Last reply</span>
              <span className="status-value">
                {status.ai.lastReply
                  ? `${status.ai.lastReply.model ?? "—"} · ${timeAgo(status.ai.lastReply.at)}`
                  : "No replies yet"}
              </span>
            </li>
            <li>
              <span
                className={`dot ${status.database.status === "online" ? "dot-ok" : "dot-warn"}`}
              />
              <span>Database</span>
              <span className="status-value">
                {status.database.status === "online" ? "Online" : "Degraded"}
              </span>
            </li>
            <li>
              <span className="dot dot-ok" />
              <span>API</span>
              <span className="status-value">v{status.api.version}</span>
            </li>
          </ul>
        )}
      </section>

      {/* Usage */}
      <section className="panel" aria-labelledby="usage-title">
        <h2 className="panel-label" id="usage-title">
          AI usage today
        </h2>
        {!usage ? (
          <p className="muted small">Loading…</p>
        ) : (
          <div className="usage">
            <div className="ring" role="img" aria-label={`${pct}% of today's limit used`}>
              {/* SVG attributes, not inline styles, so the strict CSP stays intact. */}
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className="ring-track" cx="18" cy="18" r="15.915" />
                {pct > 0 && (
                  <circle
                    className="ring-value"
                    cx="18"
                    cy="18"
                    r="15.915"
                    strokeDasharray={`${pct} ${100 - pct}`}
                    strokeDashoffset="25"
                  />
                )}
              </svg>
              <span>{pct}%</span>
            </div>
            <div>
              <p className="usage-num">
                {usage.usedToday.toLocaleString()}{" "}
                <span className="muted">/ {usage.dailyLimit.toLocaleString()} tokens</span>
              </p>
              <p className="muted small">
                Resets{" "}
                {new Date(usage.resetsAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              {usage.byModel.slice(0, 3).map((m) => (
                <p key={`${m.provider}/${m.model}`} className="small usage-model">
                  {m.model} · {m.replies} {m.replies === 1 ? "reply" : "replies"}
                </p>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Recent conversations */}
      <section className="panel" aria-labelledby="recent-title">
        <div className="panel-head">
          <h2 className="panel-label" id="recent-title">
            Recent conversations
          </h2>
          <Link href="/app/chat" className="link-more">
            Open chat <ArrowIcon width={14} height={14} />
          </Link>
        </div>
        {recent === null ? (
          <p className="muted small">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="muted small">No conversations in this workspace yet.</p>
        ) : (
          <ul className="list">
            {recent.map((c) => (
              <li key={c.id}>
                <Link href={`/app/chat/${c.id}`} className="list-link">
                  <span className="list-title">{c.title ?? "Untitled chat"}</span>
                  <span className="muted small">
                    {c.last_message_at ? timeAgo(c.last_message_at) : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Workspace */}
      <section className="panel" aria-labelledby="ws-title">
        <h2 className="panel-label" id="ws-title">
          Workspace
        </h2>
        {workspace && (
          <>
            <p className="ws-name">{workspace.name}</p>
            <p className="muted small">
              {workspace.type === "business" ? "Business" : "Personal"} · your role:{" "}
              {workspace.role}
            </p>
            <p className="small ws-members">
              {members === null
                ? "Loading members…"
                : `${members.length} ${members.length === 1 ? "member" : "members"}`}
            </p>
            <p className="muted small">
              Data in this workspace is isolated from your other workspaces.
            </p>
          </>
        )}
      </section>

      {/* Activity */}
      <section className="panel" aria-labelledby="activity-title">
        <h2 className="panel-label" id="activity-title">
          Recent activity
        </h2>
        {events === null ? (
          <p className="muted small">Loading…</p>
        ) : events.length === 0 ? (
          <p className="muted small">
            {workspace && (workspace.role === "owner" || workspace.role === "admin")
              ? "No activity recorded yet."
              : "Activity is visible to workspace admins."}
          </p>
        ) : (
          <ul className="list">
            {events.map((e) => (
              <li key={e.id} className="list-row">
                <span>{ACTION_LABELS[e.action] ?? e.action}</span>
                <span className="muted small">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Capabilities: honest roadmap, no fake data */}
      <section className="panel capabilities" aria-labelledby="cap-title">
        <h2 className="panel-label" id="cap-title">
          Capabilities
        </h2>
        <ul className="cap-list">
          <li>
            <span className="dot dot-ok" /> Conversations <span className="tag tag-ok">Online</span>
          </li>
          <li>
            <span className="dot dot-ok" /> Personal &amp; business workspaces{" "}
            <span className="tag tag-ok">Online</span>
          </li>
          <li>
            <span className="dot dot-ok" /> Memory (saved notes){" "}
            <span className="tag tag-ok">Online</span>
          </li>
          <li>
            <span className="dot dot-idle" /> Automatic memory &amp; recall{" "}
            <span className="tag">Phase 2</span>
          </li>
          <li>
            <span className="dot dot-ok" /> Voice input &amp; read-aloud (browser){" "}
            <span className="tag tag-ok">Online</span>
          </li>
          <li>
            <span className="dot dot-ok" /> Tasks &amp; in-app reminders{" "}
            <span className="tag tag-ok">Online</span>
          </li>
          <li>
            <span className="dot dot-ok" /> Clients, pipeline, projects &amp; reports{" "}
            <span className="tag tag-ok">Online</span>
          </li>
          <li>
            <span className="dot dot-idle" /> Sir Libz reading your CRM{" "}
            <span className="tag">Next</span>
          </li>
          <li>
            <span className="dot dot-idle" /> Calendar, push &amp; email reminders{" "}
            <span className="tag">Not connected</span>
          </li>
          <li>
            <span className="dot dot-idle" /> WhatsApp &amp; calling{" "}
            <span className="tag">Not connected</span>
          </li>
          <li>
            <span className="dot dot-idle" /> Email &amp; app integrations{" "}
            <span className="tag">Not connected</span>
          </li>
          <li>
            <span className="dot dot-idle" /> Automations <span className="tag">Not connected</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
