"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Company, Project } from "@/lib/crm";
import { crm, errorMessage, formatMoney, PROJECT_STATUSES } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { PlusIcon } from "../icons";
import { BusinessOnly } from "./BusinessOnly";
import { ProjectForm } from "./ClientDetail";

export function ProjectsView() {
  return (
    <BusinessOnly title="Projects">
      <Projects />
    </BusinessOnly>
  );
}

function Projects() {
  const { workspace } = useWorkspace();
  const [status, setStatus] = useState<string>("active");
  const [items, setItems] = useState<Project[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = workspace?.role !== "viewer";

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setItems((await crm.projects.list(workspace.id, { status, limit: 200 })).items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load projects."));
    }
  }, [workspace, status]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  async function changeStatus(p: Project, to: string) {
    try {
      await crm.projects.update(p.id, { status: to });
    } catch (err) {
      setError(errorMessage(err, "Could not update the project."));
    }
    void load();
  }

  return (
    <div className="page">
      <header className="page-head page-head-actions">
        <div>
          <p className="eyebrow">Business · {workspace?.name}</p>
          <h1>Projects</h1>
          <p className="muted">Delivery work for your clients.</p>
        </div>
        {canWrite && (
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!workspace) return;
              crm.companies
                .list(workspace.id, { limit: 200 })
                .then((r) => {
                  setCompanies(r.items);
                  setAdding(true);
                })
                .catch((err: unknown) => setError(errorMessage(err, "Could not load clients.")));
            }}
          >
            <PlusIcon /> Add project
          </button>
        )}
      </header>

      <div className="segmented" role="tablist" aria-label="Project status">
        {PROJECT_STATUSES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={status === s}
            className={`segment capitalize ${status === s ? "active" : ""}`}
            onClick={() => setStatus(s)}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel" aria-label="Projects">
        {items === null ? (
          <p className="muted small">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted small">No {status.replace("_", " ")} projects.</p>
        ) : (
          <ul className="list">
            {items.map((p) => (
              <li key={p.id} className="list-row crm-project">
                <span className="crm-row-main">
                  <span className="list-title">{p.name}</span>
                  <span className="muted small">
                    <Link href={`/app/clients/${p.company_id}`}>
                      {p.companies?.name ?? "Client"}
                    </Link>
                    {p.budget !== null && ` · ${formatMoney({ [p.currency]: Number(p.budget) })}`}
                    {p.end_date && ` · due ${new Date(p.end_date).toLocaleDateString()}`}
                  </span>
                </span>
                {canWrite ? (
                  <select
                    className="select-sm capitalize"
                    value={p.status}
                    aria-label={`Status of ${p.name}`}
                    onChange={(e) => void changeStatus(p, e.target.value)}
                  >
                    {PROJECT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="tag capitalize">{p.status.replace("_", " ")}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {adding && workspace && (
        <ProjectForm
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
