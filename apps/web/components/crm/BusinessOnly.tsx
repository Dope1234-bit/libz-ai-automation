"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

/** CRM screens exist only in Business mode (the database enforces this too). */
export function BusinessOnly({ title, children }: { title: string; children: ReactNode }) {
  const { mode, setMode, workspace, businessWorkspaces, createBusiness } = useWorkspace();
  const [name, setName] = useState("Libz AI Automation");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workspace) {
    return (
      <div className="page">
        <p className="muted small">Loading…</p>
      </div>
    );
  }
  if (mode === "business") return <>{children}</>;

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Business mode</p>
        <h1>{title}</h1>
        <p className="muted">
          {title} lives in your business workspace, so personal data and client data never mix.
        </p>
      </header>
      <section className="panel invite-panel">
        {businessWorkspaces.length > 0 ? (
          <button className="btn btn-primary" onClick={() => setMode("business")}>
            Switch to Business mode
          </button>
        ) : (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              createBusiness(name.trim())
                .catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : "Could not create the workspace."),
                )
                .finally(() => setBusy(false));
            }}
          >
            <label className="grow">
              Business name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
              />
            </label>
            <button className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create business workspace"}
            </button>
          </form>
        )}
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
