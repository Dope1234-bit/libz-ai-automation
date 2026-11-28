"use client";

import Link from "next/link";
import { useState } from "react";
import type { Proposal } from "@/lib/api";
import { api } from "@/lib/api";
import { TASKS_CHANGED } from "@/lib/crm";
import { CheckIcon, CloseIcon } from "../icons";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/**
 * A change Sir Libz suggested. Nothing is saved until the user taps Confirm;
 * the server re-checks permissions and records the decision in the audit log.
 */
export function ProposalCard({
  proposal,
  canDecide,
  onChange,
}: {
  proposal: Proposal;
  canDecide: boolean;
  onChange: (p: Proposal) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = proposal.payload;
  const company = str(p.company_name);
  const companyId = str(p.company_id);

  async function decide(confirm: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { proposal: updated } = await api.decideProposal(proposal.id, confirm);
      onChange(updated);
      if (confirm && updated.kind === "task") window.dispatchEvent(new Event(TASKS_CHANGED));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your decision.");
    } finally {
      setBusy(false);
    }
  }

  const details: string[] = [];
  if (proposal.kind === "lead") {
    if (str(p.address)) details.push(String(p.address));
    if (str(p.phone_e164)) details.push(String(p.phone_e164));
    details.push("New lead deal · from Google Maps");
  } else if (proposal.kind === "task") {
    const due = str(p.due_at);
    if (due) {
      details.push(
        `Due ${new Date(due).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
      );
    }
    if (str(p.priority) && p.priority !== "normal") details.push(`${String(p.priority)} priority`);
  } else {
    details.push(
      [str(p.type), str(p.direction) !== "internal" ? str(p.direction) : null]
        .filter(Boolean)
        .join(" · "),
    );
  }
  if (company && proposal.kind !== "lead") details.push(company);

  const title =
    proposal.kind === "task"
      ? str(p.title)
      : proposal.kind === "lead"
        ? str(p.name)
        : str(p.summary);
  const resultHref =
    proposal.kind === "task"
      ? "/app/tasks"
      : proposal.kind === "lead"
        ? proposal.result_id
          ? `/app/clients/${proposal.result_id}`
          : null
        : companyId
          ? `/app/clients/${companyId}`
          : null;

  return (
    <div
      className={`proposal proposal-${proposal.status}`}
      role="group"
      aria-label="Suggested change"
    >
      <p className="proposal-kind">
        {proposal.kind === "task"
          ? "Suggested task"
          : proposal.kind === "lead"
            ? "Suggested lead"
            : "Suggested log entry"}
        <span className={`tag ${proposal.status === "confirmed" ? "tag-ok" : ""}`}>
          {proposal.status === "pending"
            ? "Needs your OK"
            : proposal.status === "confirmed"
              ? "Saved"
              : "Dismissed"}
        </span>
      </p>
      <p className="proposal-title">{title ?? proposal.summary}</p>
      {details.filter(Boolean).length > 0 && (
        <p className="proposal-details capitalize">{details.filter(Boolean).join(" · ")}</p>
      )}
      {proposal.kind === "task" && str(p.notes) && <p className="proposal-notes">{str(p.notes)}</p>}
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {proposal.status === "pending" && canDecide && (
        <div className="proposal-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void decide(true)}
          >
            <CheckIcon width={16} height={16} /> Confirm
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => void decide(false)}
          >
            <CloseIcon width={16} height={16} /> Dismiss
          </button>
        </div>
      )}
      {proposal.status === "confirmed" && resultHref && (
        <Link href={resultHref} className="link-more">
          View
        </Link>
      )}
    </div>
  );
}
