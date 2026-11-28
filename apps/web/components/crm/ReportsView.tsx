"use client";

import { useEffect, useState } from "react";
import type { Summary } from "@/lib/crm";
import { crm, errorMessage, formatMoney, STAGE_LABELS } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { BusinessOnly } from "./BusinessOnly";

export function ReportsView() {
  return (
    <BusinessOnly title="Reports">
      <Reports />
    </BusinessOnly>
  );
}

export function useSummary(workspaceId: string | undefined, enabled = true) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !enabled) return;
    let active = true;
    setSummary(null);
    crm
      .summary(workspaceId)
      .then((s) => active && setSummary(s))
      .catch((err: unknown) => active && setError(errorMessage(err, "Could not load the report.")));
    return () => {
      active = false;
    };
  }, [workspaceId, enabled]);
  return { summary, error };
}

function Reports() {
  const { workspace } = useWorkspace();
  const { summary, error } = useSummary(workspace?.id);
  const maxCount = Math.max(1, ...(summary?.pipeline.byStage.map((s) => s.count) ?? [1]));

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Business · {workspace?.name}</p>
        <h1>Reports</h1>
        <p className="muted">
          Calculated live from your records. Revenue means won deals; invoicing is not connected
          yet.
        </p>
      </header>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      {!summary ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Open pipeline" value={formatMoney(summary.pipeline.open, "None open")} />
            <Kpi
              label="Won this month"
              value={formatMoney(summary.wonThisMonth.value, "None yet")}
              note={`${summary.wonThisMonth.count} deal${summary.wonThisMonth.count === 1 ? "" : "s"} · ${summary.lostThisMonth} lost`}
            />
            <Kpi
              label="Tasks"
              value={String(summary.tasks.open)}
              note={`${summary.tasks.overdue} overdue · ${summary.tasks.dueToday} due today`}
              warn={summary.tasks.overdue > 0}
            />
            <Kpi
              label="Clients"
              value={String(summary.counts.companies)}
              note={`${summary.counts.contacts} contacts · ${summary.counts.activitiesLast7Days} activities in 7 days`}
            />
          </div>

          <section className="panel" aria-labelledby="stages-title">
            <h2 className="panel-label" id="stages-title">
              Deals by stage
            </h2>
            <ul className="bars">
              {summary.pipeline.byStage.map((s) => (
                <li key={s.stage}>
                  <span className="bar-label">{STAGE_LABELS[s.stage]}</span>
                  {/* SVG attributes, not inline styles, so the strict CSP stays intact. */}
                  <svg
                    className="bar-track"
                    viewBox="0 0 100 8"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <rect
                      className={`bar-fill stage-fill-${s.stage}`}
                      x="0"
                      y="0"
                      height="8"
                      rx="2"
                      width={(s.count / maxCount) * 100}
                    />
                  </svg>
                  <span className="bar-value">
                    {s.count} · {formatMoney(s.value)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <p className="muted small">
            Updated {new Date(summary.generatedAt).toLocaleTimeString()}. Amounts in different
            currencies are shown separately, never converted.
          </p>
        </>
      )}
    </div>
  );
}

export function Kpi({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: string;
  note?: string;
  warn?: boolean;
}) {
  return (
    <section className="panel kpi">
      <h2 className="panel-label">{label}</h2>
      <p className={`kpi-value ${warn ? "kpi-warn" : ""}`}>{value}</p>
      {note && <p className="muted small">{note}</p>}
    </section>
  );
}
