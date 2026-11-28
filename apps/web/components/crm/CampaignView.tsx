"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Campaign, CampaignLead, Company, LeadStatus, Prospect } from "@/lib/crm";
import {
  crm,
  errorMessage,
  LEAD_STATUS_LABELS,
  outreach,
  prospects as prospectsApi,
  sendLinks,
} from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { PlusIcon, SearchIcon, TrashIcon } from "../icons";
import { BusinessOnly } from "./BusinessOnly";
import { Sheet } from "./Sheet";

const FOLLOW_UP_STATUSES: LeadStatus[] = ["sent", "replied", "interested", "not_interested", "won"];

export function CampaignView({ id }: { id: string }) {
  return (
    <BusinessOnly title="Outreach">
      <CampaignDetail id={id} />
    </BusinessOnly>
  );
}

function CampaignDetail({ id }: { id: string }) {
  const { workspace } = useWorkspace();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [leads, setLeads] = useState<CampaignLead[]>([]);
  const [dialog, setDialog] = useState<"maps" | "clients" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = workspace?.role !== "viewer";

  const load = useCallback(async () => {
    try {
      const data = await outreach.campaign(id);
      setCampaign(data.campaign);
      setLeads(data.leads);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load this campaign."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const leadCompanyIds = useMemo(() => new Set(leads.map((l) => l.company_id)), [leads]);
  const replaceLead = (lead: CampaignLead) =>
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? lead : l)));

  if (!campaign) {
    return (
      <div className="page">
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted small">Loading…</p>
        )}
        <Link href="/app/outreach">← All campaigns</Link>
      </div>
    );
  }

  const count = (s: LeadStatus[]) => leads.filter((l) => s.includes(l.status)).length;

  return (
    <div className="page page-wide">
      <header className="page-head page-head-actions">
        <div>
          <p className="eyebrow">
            <Link href="/app/outreach">Outreach</Link> · {campaign.channel}
          </p>
          <h1>{campaign.name}</h1>
          <p className="muted crm-summary">{campaign.offer}</p>
        </div>
        {canWrite && (
          <div className="section-actions">
            <button className="btn btn-primary" onClick={() => setDialog("maps")}>
              <SearchIcon /> Find on Google Maps
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog("clients")}>
              <PlusIcon /> Add clients
            </button>
          </div>
        )}
      </header>

      <div className="kpis">
        <Stat label="Leads" value={leads.length} />
        <Stat label="To contact" value={count(["to_contact", "drafted"])} />
        <Stat
          label="Contacted"
          value={count(["sent", "replied", "interested", "not_interested", "won"])}
        />
        <Stat label="Interested / won" value={count(["interested", "won"])} />
      </div>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel" aria-label="Leads">
        <h2 className="panel-label">Leads</h2>
        {leads.length === 0 ? (
          <p className="muted small">
            No leads yet. Find {campaign.target_what ?? "businesses"} on Google Maps or add existing
            clients.
          </p>
        ) : (
          <ul className="lead-list">
            {leads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                channel={campaign.channel}
                canWrite={canWrite}
                onChange={replaceLead}
                onRemoved={() => setLeads((prev) => prev.filter((l) => l.id !== lead.id))}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </section>

      {dialog === "maps" && (
        <FindOnMaps
          campaign={campaign}
          onClose={() => setDialog(null)}
          onAdded={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "clients" && workspace && (
        <AddClients
          workspaceId={workspace.id}
          campaignId={campaign.id}
          existing={leadCompanyIds}
          onClose={() => setDialog(null)}
          onAdded={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <section className="panel kpi">
      <h2 className="panel-label">{label}</h2>
      <p className="kpi-value">{value}</p>
    </section>
  );
}

function LeadCard({
  lead,
  channel,
  canWrite,
  onChange,
  onRemoved,
  onError,
}: {
  lead: CampaignLead;
  channel: Campaign["channel"];
  canWrite: boolean;
  onChange: (l: CampaignLead) => void;
  onRemoved: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState(lead.message ?? "");
  const [opened, setOpened] = useState(false);
  const company = lead.companies;
  const blocked = company?.do_not_contact ?? false;
  const links = sendLinks({ ...lead, message: draft });
  const link = links[channel];
  const contacted = FOLLOW_UP_STATUSES.includes(lead.status);

  useEffect(() => setDraft(lead.message ?? ""), [lead.message]);

  async function run<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    try {
      return await fn();
    } catch (err) {
      onError(errorMessage(err, "Something went wrong."));
      return null;
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={`lead ${blocked ? "lead-blocked" : ""}`}>
      <div className="lead-head">
        <div className="crm-row-main">
          <Link href={`/app/clients/${lead.company_id}`} className="list-title">
            {company?.name ?? "Client"}
          </Link>
          <span className="muted small">
            {[company?.phone_e164, company?.email, company?.address].filter(Boolean).join(" · ") ||
              "No contact details"}
          </span>
        </div>
        {blocked ? (
          <span className="tag tag-danger">Do not contact</span>
        ) : contacted && canWrite ? (
          <select
            className="select-sm"
            value={lead.status}
            aria-label={`Status of ${company?.name}`}
            onChange={(e) =>
              void run("status", async () => {
                const res = await outreach.updateLead(lead.id, {
                  status: e.target.value as LeadStatus,
                });
                onChange(res.lead);
              })
            }
          >
            {FOLLOW_UP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        ) : (
          <span className={`tag ${lead.status === "drafted" ? "tag-ok" : ""}`}>
            {LEAD_STATUS_LABELS[lead.status]}
          </span>
        )}
      </div>

      {!blocked && canWrite && !contacted && (
        <>
          {lead.message || draft ? (
            <textarea
              className="lead-message"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft !== (lead.message ?? ""))
                  void run("save", async () =>
                    onChange((await outreach.updateLead(lead.id, { message: draft })).lead),
                  );
              }}
              rows={5}
              maxLength={2000}
              aria-label={`Message to ${company?.name}`}
            />
          ) : null}
          <div className="lead-actions">
            <button
              className="btn btn-secondary btn-sm"
              disabled={!!busy}
              onClick={() =>
                void run("draft", async () => onChange((await outreach.draft(lead.id)).lead))
              }
            >
              {busy === "draft" ? "Writing…" : lead.message ? "Rewrite" : "Write message"}
            </button>
            {draft &&
              (link ? (
                <a
                  className="btn btn-primary btn-sm"
                  href={link}
                  target={channel === "call" ? undefined : "_blank"}
                  rel="noopener noreferrer"
                  onClick={() => setOpened(true)}
                >
                  {channel === "whatsapp"
                    ? "Open WhatsApp"
                    : channel === "email"
                      ? "Open email"
                      : "Call"}
                </a>
              ) : (
                <span className="muted small">
                  No {channel === "email" ? "email address" : "phone number"} for this client.
                </span>
              ))}
            {draft && (
              <button
                className={`btn btn-sm ${opened ? "btn-primary" : "btn-ghost"}`}
                disabled={!!busy}
                onClick={() =>
                  void run("sent", async () =>
                    onChange((await outreach.markSent(lead.id, channel)).lead),
                  )
                }
              >
                {busy === "sent" ? "Saving…" : "Mark as sent"}
              </button>
            )}
            <button
              className="btn btn-ghost icon-btn"
              aria-label={`Remove ${company?.name} from campaign`}
              title="Remove from campaign"
              disabled={!!busy}
              onClick={() =>
                void run("remove", async () => {
                  await outreach.removeLead(lead.id);
                  onRemoved();
                })
              }
            >
              <TrashIcon />
            </button>
          </div>
        </>
      )}
      {contacted && lead.sent_at && (
        <p className="muted small">
          Sent by {lead.sent_via} on {new Date(lead.sent_at).toLocaleDateString()}
          {lead.follow_up_at &&
            ` · follow-up due ${new Date(lead.follow_up_at).toLocaleDateString()}`}
        </p>
      )}
    </li>
  );
}

function FindOnMaps({
  campaign,
  onClose,
  onAdded,
}: {
  campaign: Campaign;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [what, setWhat] = useState(campaign.target_what ?? "");
  const [where, setWhere] = useState(campaign.target_where ?? "");
  const [results, setResults] = useState<Prospect[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    prospectsApi
      .status(campaign.workspace_id)
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, [campaign.workspace_id]);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await prospectsApi.search(campaign.workspace_id, {
        what: what.trim(),
        ...(where.trim() ? { where: where.trim() } : {}),
      });
      setResults(res.results);
      // Preselect new businesses that have a way to reach them.
      setPicked(
        new Set(
          res.results.filter((r) => !r.existingClientId && r.phoneE164).map((r) => r.placeId),
        ),
      );
    } catch (err) {
      setError(errorMessage(err, "Search failed."));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await outreach.addFromMaps(campaign.id, [...picked].slice(0, 20));
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Could not add these businesses."));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Find businesses on Google Maps" onClose={onClose}>
      {configured === false ? (
        <p className="muted">
          Google Maps is not connected yet. An owner needs to add a Google Maps API key
          (GOOGLE_MAPS_API_KEY) to the server settings. You can still add existing clients.
        </p>
      ) : (
        <div className="settings-form">
          <form className="inline-form" onSubmit={(e) => void search(e)}>
            <label className="grow">
              Looking for
              <input
                value={what}
                onChange={(e) => setWhat(e.target.value)}
                required
                minLength={2}
                maxLength={100}
              />
            </label>
            <label className="grow">
              Where
              <input value={where} onChange={(e) => setWhere(e.target.value)} maxLength={100} />
            </label>
            <button className="btn btn-secondary" disabled={busy || what.trim().length < 2}>
              {busy && !results ? "Searching…" : "Search"}
            </button>
          </form>
          {results && (
            <ul className="pick-list">
              {results.map((p) => (
                <li key={p.placeId}>
                  <label className="pick">
                    <input
                      type="checkbox"
                      checked={picked.has(p.placeId)}
                      disabled={picked.size >= 20 && !picked.has(p.placeId)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.placeId);
                          else next.delete(p.placeId);
                          return next;
                        })
                      }
                    />
                    <span className="crm-row-main">
                      <span className="list-title">{p.name}</span>
                      <span className="muted small">
                        {[
                          p.phoneE164 ?? "no phone",
                          p.rating !== null ? `★ ${p.rating.toFixed(1)}` : null,
                          p.existingClientId ? "already a client" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {results && <p className="muted small">Results from Google Maps</p>}
          {error && (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || picked.size === 0}
              onClick={() => void add()}
            >
              {busy && results ? "Adding…" : `Add ${picked.size} to campaign`}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function AddClients({
  workspaceId,
  campaignId,
  existing,
  onClose,
  onAdded,
}: {
  workspaceId: string;
  campaignId: string;
  existing: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<Company[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      crm.companies
        .list(workspaceId, { q: query.trim(), limit: 100 })
        .then((r) => setClients(r.items.filter((c) => !existing.has(c.id))))
        .catch((err: unknown) => setError(errorMessage(err, "Could not load clients.")));
    }, 200);
    return () => clearTimeout(t);
  }, [workspaceId, query, existing]);

  return (
    <Sheet title="Add clients to campaign" onClose={onClose}>
      <div className="settings-form">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clients…"
          aria-label="Search clients"
        />
        {clients.length === 0 ? (
          <p className="muted small">No other clients to add.</p>
        ) : (
          <ul className="pick-list">
            {clients.map((c) => (
              <li key={c.id}>
                <label className="pick">
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                  />
                  <span className="crm-row-main">
                    <span className="list-title">{c.name}</span>
                    <span className="muted small">
                      {c.phone_e164 ?? c.email ?? "no contact details"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || picked.size === 0}
            onClick={() => {
              setBusy(true);
              outreach
                .addClients(campaignId, [...picked])
                .then(onAdded)
                .catch((err: unknown) => {
                  setError(errorMessage(err, "Could not add clients."));
                  setBusy(false);
                });
            }}
          >
            {busy ? "Adding…" : `Add ${picked.size}`}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
