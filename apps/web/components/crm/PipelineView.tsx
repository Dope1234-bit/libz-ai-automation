"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Company, Deal, DealStage } from "@/lib/crm";
import { crm, DEAL_STAGES, errorMessage, formatMoney, STAGE_LABELS } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { PlusIcon } from "../icons";
import { BusinessOnly } from "./BusinessOnly";
import { DealForm } from "./ClientDetail";

export function PipelineView() {
  return (
    <BusinessOnly title="Pipeline">
      <Pipeline />
    </BusinessOnly>
  );
}

function sum(deals: Deal[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of deals) out[d.currency] = (out[d.currency] ?? 0) + Number(d.value);
  return out;
}

function Pipeline() {
  const { workspace } = useWorkspace();
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [stage, setStage] = useState<DealStage>("lead");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = workspace?.role !== "viewer";

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setDeals((await crm.deals.list(workspace.id, { limit: 200 })).items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load the pipeline."));
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(deal: Deal, to: DealStage) {
    // Optimistic, then confirmed by the server (which records the change).
    setDeals((ds) => ds?.map((d) => (d.id === deal.id ? { ...d, stage: to } : d)) ?? null);
    try {
      await crm.deals.update(deal.id, { stage: to });
    } catch (err) {
      setError(errorMessage(err, "Could not move the deal."));
    }
    void load();
  }

  async function openAdd() {
    if (!workspace) return;
    try {
      setCompanies((await crm.companies.list(workspace.id, { limit: 200 })).items);
      setAdding(true);
    } catch (err) {
      setError(errorMessage(err, "Could not load clients."));
    }
  }

  const byStage = (s: DealStage) => (deals ?? []).filter((d) => d.stage === s);
  const open = (deals ?? []).filter((d) => d.stage !== "won" && d.stage !== "lost");

  return (
    <div className="page page-full">
      <header className="page-head page-head-actions">
        <div>
          <p className="eyebrow">Business · {workspace?.name}</p>
          <h1>Pipeline</h1>
          <p className="muted">
            {deals === null
              ? "Loading…"
              : `${open.length} open deal${open.length === 1 ? "" : "s"} · ${formatMoney(sum(open))}`}
          </p>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => void openAdd()}>
            <PlusIcon /> Add deal
          </button>
        )}
      </header>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      {deals !== null && deals.length === 0 && (
        <p className="panel empty-panel muted">
          No deals yet. Add a client first, then track each opportunity here from lead to won.
        </p>
      )}

      {/* Phones: one stage at a time */}
      <div className="stage-tabs" role="tablist" aria-label="Deal stages">
        {DEAL_STAGES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={stage === s}
            className={`segment ${stage === s ? "active" : ""}`}
            onClick={() => setStage(s)}
          >
            {STAGE_LABELS[s]} <span className="count">{byStage(s).length}</span>
          </button>
        ))}
      </div>

      <div className="board">
        {DEAL_STAGES.map((s) => (
          <section
            key={s}
            className={`board-col ${stage === s ? "is-current" : ""}`}
            aria-label={`${STAGE_LABELS[s]} deals`}
          >
            <header className="board-head">
              <span className={`stage stage-${s}`}>{STAGE_LABELS[s]}</span>
              <span className="muted small">{byStage(s).length}</span>
            </header>
            <p className="board-total muted small">{formatMoney(sum(byStage(s)))}</p>
            {byStage(s).map((d) => (
              <article key={d.id} className="deal-card">
                <p className="deal-title">{d.title}</p>
                <Link href={`/app/clients/${d.company_id}`} className="deal-company small">
                  {d.companies?.name ?? "Client"}
                </Link>
                <p className="deal-value">{formatMoney({ [d.currency]: Number(d.value) })}</p>
                {canWrite && (
                  <label className="deal-move">
                    <span className="sr-only">Move {d.title} to stage</span>
                    <select
                      value={d.stage}
                      onChange={(e) => void move(d, e.target.value as DealStage)}
                    >
                      {DEAL_STAGES.map((to) => (
                        <option key={to} value={to}>
                          {STAGE_LABELS[to]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </article>
            ))}
          </section>
        ))}
      </div>

      {adding && workspace && (
        <DealForm
          workspaceId={workspace.id}
          companies={companies}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
