"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Campaign, OutreachChannel } from "@/lib/crm";
import { errorMessage, outreach } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { ArrowIcon, PlusIcon } from "../icons";
import { BusinessOnly } from "./BusinessOnly";
import { Sheet } from "./Sheet";

const CHANNEL_LABELS: Record<OutreachChannel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  call: "Phone call",
};

export function OutreachView() {
  return (
    <BusinessOnly title="Outreach">
      <Outreach />
    </BusinessOnly>
  );
}

function Outreach() {
  const router = useRouter();
  const { workspace } = useWorkspace();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = workspace?.role !== "viewer";

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setCampaigns((await outreach.campaigns(workspace.id)).campaigns);
    } catch (err) {
      setError(errorMessage(err, "Could not load campaigns."));
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <header className="page-head page-head-actions">
        <div>
          <p className="eyebrow">Business · {workspace?.name}</p>
          <h1>Outreach</h1>
          <p className="muted">
            Pick a kind of business and an area. Sir Libz finds them, writes a personal message for
            each, and you send it from your own WhatsApp, email or phone with one tap.
          </p>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <PlusIcon /> New campaign
          </button>
        )}
      </header>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel" aria-label="Campaigns">
        {campaigns === null ? (
          <p className="muted small">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="muted small">
            No campaigns yet. Start one, e.g. “Salons in Harare” offering WhatsApp booking bots.
          </p>
        ) : (
          <ul className="list crm-list">
            {campaigns.map((c) => {
              const total = Object.values(c.counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);
              const sent =
                (c.counts?.sent ?? 0) +
                (c.counts?.replied ?? 0) +
                (c.counts?.interested ?? 0) +
                (c.counts?.not_interested ?? 0) +
                (c.counts?.won ?? 0);
              return (
                <li key={c.id}>
                  <Link href={`/app/outreach/${c.id}`} className="list-link crm-row">
                    <span className="crm-row-main">
                      <span className="list-title">{c.name}</span>
                      <span className="muted small">
                        {[c.target_what, c.target_where].filter(Boolean).join(" · ") ||
                          "Any business"}{" "}
                        · {CHANNEL_LABELS[c.channel]} · {total} lead{total === 1 ? "" : "s"}, {sent}{" "}
                        contacted
                        {c.counts?.won ? `, ${c.counts.won} won` : ""}
                      </span>
                    </span>
                    {c.status !== "active" && <span className="tag capitalize">{c.status}</span>}
                    <ArrowIcon />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="muted small">
        Sir Libz never sends anything by itself. Every message is reviewed and sent by you, each one
        offers an opt-out, and clients marked “do not contact” are skipped.
      </p>

      {creating && workspace && (
        <NewCampaign
          workspaceId={workspace.id}
          onClose={() => setCreating(false)}
          onCreated={(id) => router.push(`/app/outreach/${id}`)}
        />
      )}
    </div>
  );
}

function NewCampaign({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [what, setWhat] = useState("");
  const [where, setWhere] = useState("Harare");
  const [offer, setOffer] = useState("");
  const [channel, setChannel] = useState<OutreachChannel>("whatsapp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const name = [what.trim(), where.trim()].filter(Boolean).join(" in ") || "New campaign";
      const { campaign } = await outreach.createCampaign(workspaceId, {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        ...(what.trim() ? { targetWhat: what.trim() } : {}),
        ...(where.trim() ? { targetWhere: where.trim() } : {}),
        offer: offer.trim(),
        channel,
      });
      onCreated(campaign.id);
    } catch (err) {
      setError(errorMessage(err, "Could not create the campaign."));
      setBusy(false);
    }
  }

  return (
    <Sheet title="New outreach campaign" onClose={onClose}>
      <form className="settings-form" onSubmit={(e) => void save(e)}>
        <div className="form-grid">
          <label>
            Who to reach
            <input
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              placeholder="e.g. salons, schools, hardware stores"
              maxLength={100}
              required
              autoFocus
            />
          </label>
          <label>
            Area
            <input value={where} onChange={(e) => setWhere(e.target.value)} maxLength={100} />
          </label>
        </div>
        <label>
          What you offer them
          <textarea
            value={offer}
            onChange={(e) => setOffer(e.target.value)}
            rows={3}
            maxLength={2000}
            required
            placeholder="e.g. We build WhatsApp booking bots so your clients can book appointments 24/7, set up in 3 days."
          />
        </label>
        <label>
          Send by
          <select value={channel} onChange={(e) => setChannel(e.target.value as OutreachChannel)}>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="call">Phone call</option>
          </select>
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
          <button className="btn btn-primary" disabled={busy || !what.trim() || !offer.trim()}>
            {busy ? "Creating…" : "Create campaign"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
