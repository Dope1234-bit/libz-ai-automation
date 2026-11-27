"use client";

import { useEffect, useState } from "react";
import type { AuditEvent, Member } from "@/lib/api";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";

export const ACTION_LABELS: Record<string, string> = {
  "user.signed_up": "Account created",
  "workspace.created": "Workspace created",
  "workspace.updated": "Workspace updated",
  "workspace.deleted": "Workspace deleted",
  "invitation.created": "Invitation created",
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
  "jarvis.proposal_created": "Jarvis suggested a change",
  "jarvis.proposal_confirmed": "Jarvis suggestion confirmed",
  "jarvis.proposal_dismissed": "Jarvis suggestion dismissed",
  "member.role_changed": "Member role changed",
  "member.removed": "Member removed",
  "member.left": "Member left",
  "memory.created": "Memory saved",
  "memory.deleted": "Memory deleted",
};

/** The workspace audit log: append-only, written by the database itself. */
export function ActivityView() {
  const { workspace } = useWorkspace();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";

  useEffect(() => {
    if (!workspace) return;
    setEvents(null);
    if (!isAdmin) {
      setEvents([]);
      return;
    }
    void api
      .auditLogs(workspace.id, 100)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
    void api
      .members(workspace.id)
      .then((r) =>
        setNames(new Map(r.members.map((m: Member) => [m.userId, m.displayName ?? "A member"]))),
      )
      .catch(() => undefined);
  }, [workspace, isAdmin]);

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Audit · {workspace?.name ?? "…"}</p>
        <h1>Activity</h1>
        <p className="muted">
          A tamper-proof record of important actions in this workspace. Entries can never be edited
          or deleted, and never include the content of your messages or memories.
        </p>
      </header>

      <section className="panel" aria-label="Activity log">
        {!isAdmin ? (
          <p className="muted small">The activity log is visible to workspace owners and admins.</p>
        ) : events === null ? (
          <p className="muted small">Loading…</p>
        ) : events.length === 0 ? (
          <p className="muted small">No activity recorded yet.</p>
        ) : (
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id}>
                <span className="timeline-dot" aria-hidden="true" />
                <div>
                  <p className="timeline-title">{ACTION_LABELS[e.action] ?? e.action}</p>
                  <p className="muted small">
                    {e.actor_id ? (names.get(e.actor_id) ?? "Former member") : "System"} ·{" "}
                    {new Date(e.created_at).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
