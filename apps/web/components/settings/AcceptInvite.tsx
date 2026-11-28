"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";

/** Accepting an invitation is an explicit action, never automatic on page load. */
export function AcceptInvite() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh, selectWorkspace } = useWorkspace();
  const token = params.get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[0-9a-f]{64}$/.test(token);

  return (
    <div className="page">
      <section className="panel invite-panel">
        <p className="eyebrow">Invitation</p>
        <h1>Join a business workspace</h1>
        {valid ? (
          <>
            <p className="muted">
              You’ve been invited to a Sir Libz business workspace. It only works for the email
              address it was sent to.
            </p>
            {error && (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const { workspaceId } = await api.acceptInvitation(token);
                  await refresh();
                  selectWorkspace(workspaceId);
                  router.replace("/app");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not accept the invitation.");
                  setBusy(false);
                }
              }}
            >
              {busy ? "Joining…" : "Accept invitation"}
            </button>
          </>
        ) : (
          <p className="alert alert-error">This invitation link is incomplete or invalid.</p>
        )}
      </section>
    </div>
  );
}
