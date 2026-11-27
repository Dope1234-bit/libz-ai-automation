"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Prospect } from "@/lib/crm";
import { errorMessage, prospects } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { BusinessOnly } from "./BusinessOnly";

export function ProspectsView() {
  return (
    <BusinessOnly title="Prospects">
      <Prospects />
    </BusinessOnly>
  );
}

function Prospects() {
  const { workspace } = useWorkspace();
  const [status, setStatus] = useState<{ configured: boolean; dailyLimit: number } | null>(null);
  const [what, setWhat] = useState("");
  const [where, setWhere] = useState("Harare");
  const [results, setResults] = useState<Prospect[] | null>(null);
  const [query, setQuery] = useState("");
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = workspace?.role !== "viewer";

  useEffect(() => {
    if (!workspace) return;
    prospects
      .status(workspace.id)
      .then(setStatus)
      .catch((err: unknown) => setError(errorMessage(err, "Could not check Google Maps.")));
  }, [workspace]);

  async function search(e?: React.FormEvent, pageToken?: string) {
    e?.preventDefault();
    if (!workspace || what.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const res = await prospects.search(workspace.id, {
        what: what.trim(),
        ...(where.trim() ? { where: where.trim() } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
      setQuery(res.query);
      setResults((prev) => (pageToken ? [...(prev ?? []), ...res.results] : res.results));
      setNextPage(res.nextPageToken);
    } catch (err) {
      setError(errorMessage(err, "Search failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-wide">
      <header className="page-head">
        <p className="eyebrow">Business · {workspace?.name}</p>
        <h1>Prospects</h1>
        <p className="muted">
          Find businesses on Google Maps and add the ones you want as leads. Nothing is saved or
          contacted until you choose.
        </p>
      </header>

      {status && !status.configured ? (
        <section className="panel invite-panel">
          <p>
            <span className="tag">Not connected</span>
          </p>
          <p>
            Google Maps search needs a Google Maps API key with <strong>Places API (New)</strong>{" "}
            enabled. An owner adds it to the server settings as <code>GOOGLE_MAPS_API_KEY</code>; it
            is never shown in the browser.
          </p>
        </section>
      ) : (
        <form className="panel prospect-search" onSubmit={(e) => void search(e)}>
          <label className="grow">
            Looking for
            <input
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              placeholder="e.g. hardware stores, salons, schools"
              maxLength={100}
              disabled={!canWrite}
              required
            />
          </label>
          <label>
            Where
            <input
              value={where}
              onChange={(e) => setWhere(e.target.value)}
              placeholder="City or area"
              maxLength={100}
              disabled={!canWrite}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy || !canWrite || what.trim().length < 2}
          >
            {busy ? "Searching…" : "Search Google Maps"}
          </button>
          {status && (
            <p className="muted small prospect-note">
              Up to {status.dailyLimit} Google Maps lookups per person per day.
            </p>
          )}
        </form>
      )}

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      {results && (
        <section className="panel" aria-label="Search results">
          <div className="panel-head">
            <h2 className="panel-label">
              {results.length} result{results.length === 1 ? "" : "s"} · {query}
            </h2>
            <span className="muted small">Results from Google Maps</span>
          </div>
          {results.length === 0 ? (
            <p className="muted small">No businesses found. Try different words or a wider area.</p>
          ) : (
            <ul className="list prospect-list">
              {results.map((p) => (
                <ProspectRow
                  key={p.placeId}
                  prospect={p}
                  canWrite={canWrite}
                  onAdded={(id) =>
                    setResults(
                      (prev) =>
                        prev?.map((x) =>
                          x.placeId === p.placeId ? { ...x, existingClientId: id } : x,
                        ) ?? null,
                    )
                  }
                />
              ))}
            </ul>
          )}
          {nextPage && (
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void search(undefined, nextPage)}
            >
              {busy ? "Loading…" : "More results"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function ProspectRow({
  prospect: p,
  canWrite,
  onAdded,
}: {
  prospect: Prospect;
  canWrite: boolean;
  onAdded: (companyId: string) => void;
}) {
  const { workspace } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = p.businessStatus && p.businessStatus !== "OPERATIONAL";

  async function add() {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      const res = await prospects.add(workspace.id, p.placeId, true);
      onAdded(res.company.id);
    } catch (err) {
      setError(errorMessage(err, "Could not add this business."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="prospect">
      <div className="crm-row-main">
        <span className="list-title">{p.name}</span>
        <span className="muted small">{p.address ?? "No address listed"}</span>
        <span className="prospect-facts small">
          {p.phoneE164 ? (
            <a href={`tel:${p.phoneE164}`}>{p.phoneE164}</a>
          ) : (
            <span className="muted">No phone listed</span>
          )}
          {p.website && (
            <a href={p.website} target="_blank" rel="noopener noreferrer">
              Website
            </a>
          )}
          {p.googleMapsUri && (
            <a href={p.googleMapsUri} target="_blank" rel="noopener noreferrer">
              Google Maps
            </a>
          )}
          {p.rating !== null && (
            <span className="muted">
              ★ {p.rating.toFixed(1)} ({p.ratingCount ?? 0})
            </span>
          )}
          {closed && (
            <span className="tag tag-danger">
              {p.businessStatus?.replace(/_/g, " ").toLowerCase()}
            </span>
          )}
        </span>
        {error && <span className="task-overdue small">{error}</span>}
      </div>
      {p.existingClientId ? (
        <Link href={`/app/clients/${p.existingClientId}`} className="btn btn-ghost btn-sm">
          In clients
        </Link>
      ) : (
        canWrite && (
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add as lead"}
          </button>
        )
      )}
    </li>
  );
}
