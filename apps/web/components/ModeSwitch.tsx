"use client";

import { useState } from "react";
import type { Mode } from "@/lib/workspace-context";
import { useWorkspace } from "@/lib/workspace-context";

/** Personal / Business segmented switch, with business workspace creation. */
export function ModeSwitch() {
  const { mode, setMode, businessWorkspaces, workspace, selectWorkspace, createBusiness } =
    useWorkspace();
  const [creating, setCreating] = useState(false);

  function choose(next: Mode) {
    if (next === mode) return;
    if (!setMode(next)) setCreating(true);
  }

  return (
    <div className="mode">
      <div className="mode-switch" role="radiogroup" aria-label="Mode">
        {(["personal", "business"] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={mode === m}
            className={`mode-option ${mode === m ? "active" : ""}`}
            onClick={() => choose(m)}
          >
            {m === "personal" ? "Personal" : "Business"}
          </button>
        ))}
      </div>

      {mode === "business" && businessWorkspaces.length > 1 && (
        <select
          className="mode-select"
          value={workspace?.id ?? ""}
          onChange={(e) => selectWorkspace(e.target.value)}
          aria-label="Business workspace"
        >
          {businessWorkspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}

      {creating && (
        <CreateBusinessDialog
          onClose={() => setCreating(false)}
          onCreate={async (name) => {
            await createBusiness(name);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function CreateBusinessDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("Libz AI Automation");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-business-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onCreate(name.trim());
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not create the workspace.");
            setBusy(false);
          }
        }}
      >
        <p className="eyebrow">Business mode</p>
        <h2 id="create-business-title">Create your business workspace</h2>
        <p className="muted">
          Business conversations, memory and activity live here, fully separated from your personal
          workspace. You can invite your team later.
        </p>
        <label>
          Business name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            required
            autoFocus
          />
        </label>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </div>
  );
}
