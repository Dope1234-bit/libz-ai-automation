"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Task } from "@/lib/crm";
import { crm, formatDue, formatMoney, isOverdue, STAGE_LABELS } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { ArrowIcon } from "../icons";
import { useSummary } from "./ReportsView";

/** Command Centre panels built from real records only; empty states otherwise. */
export function TodayPanels() {
  const { workspace, mode } = useWorkspace();
  const { summary } = useSummary(workspace?.id, mode === "business");
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    if (!workspace) return;
    let active = true;
    setTasks(null);
    crm.tasks
      .list(workspace.id, { view: "open", limit: 6 })
      .then((r) => active && setTasks(r.items))
      .catch(() => active && setTasks([]));
    return () => {
      active = false;
    };
  }, [workspace]);

  return (
    <>
      {mode === "business" && (
        <section className="panel" aria-labelledby="pipeline-title">
          <div className="panel-head">
            <h2 className="panel-label" id="pipeline-title">
              Pipeline
            </h2>
            <Link href="/app/pipeline" className="link-more">
              Open <ArrowIcon width={14} height={14} />
            </Link>
          </div>
          {!summary ? (
            <p className="muted small">Loading…</p>
          ) : summary.pipeline.byStage.every((s) => s.count === 0) ? (
            <p className="muted small">
              No deals yet. <Link href="/app/clients">Add your first client</Link> to start
              tracking.
            </p>
          ) : (
            <>
              <p className="usage-num">{formatMoney(summary.pipeline.open, "No open deals")}</p>
              <p className="muted small">
                open pipeline · won this month {formatMoney(summary.wonThisMonth.value, "none yet")}
              </p>
              <ul className="status-list">
                {summary.pipeline.byStage
                  .filter((s) => s.count > 0)
                  .map((s) => (
                    <li key={s.stage}>
                      <span className={`stage stage-${s.stage}`}>{STAGE_LABELS[s.stage]}</span>
                      <span className="status-value">
                        {s.count} · {formatMoney(s.value)}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="tasks-today-title">
        <div className="panel-head">
          <h2 className="panel-label" id="tasks-today-title">
            Tasks
            {summary && summary.tasks.overdue > 0 ? ` · ${summary.tasks.overdue} overdue` : ""}
          </h2>
          <Link href="/app/tasks" className="link-more">
            All <ArrowIcon width={14} height={14} />
          </Link>
        </div>
        {tasks === null ? (
          <p className="muted small">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="muted small">
            Nothing open. <Link href="/app/tasks">Add a task</Link>.
          </p>
        ) : (
          <ul className="list">
            {tasks.map((t) => (
              <li key={t.id}>
                <Link href="/app/tasks" className="list-link">
                  <span className="list-title">{t.title}</span>
                  <span className={`small ${isOverdue(t) ? "task-overdue" : "muted"}`}>
                    {formatDue(t.due_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
