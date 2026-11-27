"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Company, ImportResult } from "@/lib/crm";
import { crm, errorMessage } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { ArrowIcon, PlusIcon } from "../icons";
import { BusinessOnly } from "./BusinessOnly";
import { Sheet } from "./Sheet";

const PAGE = 50;

export function ClientsView() {
  return (
    <BusinessOnly title="Clients">
      <Clients />
    </BusinessOnly>
  );
}

function Clients() {
  const { workspace } = useWorkspace();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Company[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const canWrite = workspace?.role !== "viewer";

  const load = useCallback(
    async (offset = 0) => {
      if (!workspace) return;
      try {
        const page = await crm.companies.list(workspace.id, {
          q: query.trim(),
          limit: PAGE,
          offset,
        });
        setItems((current) => (offset === 0 ? page.items : [...(current ?? []), ...page.items]));
        setTotal(page.total);
        setError(null);
      } catch (err) {
        setError(errorMessage(err, "Could not load clients."));
      }
    },
    [workspace, query],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="page page-wide">
      <header className="page-head page-head-actions">
        <div>
          <p className="eyebrow">Business · {workspace?.name}</p>
          <h1>Clients</h1>
          <p className="muted">Companies you work with or are talking to.</p>
        </div>
        {canWrite && (
          <div className="section-actions">
            <button className="btn btn-secondary" onClick={() => setImporting(true)}>
              Import CSV
            </button>
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <PlusIcon /> Add client
            </button>
          </div>
        )}
      </header>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search clients by name…"
        aria-label="Search clients"
        maxLength={100}
      />

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel" aria-label="Clients">
        <h2 className="panel-label">
          {items === null ? "Clients" : `${total} client${total === 1 ? "" : "s"}`}
        </h2>
        {items === null ? (
          <p className="muted small">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted small">
            {query
              ? "No clients match that search."
              : "No clients yet. Add one, or import a CSV of your own contacts."}
          </p>
        ) : (
          <ul className="list crm-list">
            {items.map((c) => (
              <li key={c.id}>
                <Link href={`/app/clients/${c.id}`} className="list-link crm-row">
                  <span className="crm-row-main">
                    <span className="list-title">{c.name}</span>
                    <span className="muted small">
                      {[c.industry, c.city, c.phone_e164].filter(Boolean).join(" · ") ||
                        "No details yet"}
                    </span>
                  </span>
                  <ArrowIcon />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {items && items.length < total && (
          <button className="btn btn-ghost" onClick={() => void load(items.length)}>
            Load more
          </button>
        )}
      </section>

      {adding && workspace && (
        <AddCompany
          workspaceId={workspace.id}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load(0);
          }}
        />
      )}
      {importing && workspace && (
        <ImportContacts
          workspaceId={workspace.id}
          onClose={() => {
            setImporting(false);
            void load(0);
          }}
        />
      )}
    </div>
  );
}

function AddCompany({
  workspaceId,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    industry: "",
    phone: "",
    email: "",
    city: "",
    website: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ""));
      await crm.companies.create(workspaceId, body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not save the client."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add client" onClose={onClose}>
      <form className="settings-form" onSubmit={(e) => void save(e)}>
        <label>
          Company name
          <input value={form.name} onChange={set("name")} required maxLength={200} autoFocus />
        </label>
        <div className="form-grid">
          <label>
            Industry
            <input value={form.industry} onChange={set("industry")} maxLength={100} />
          </label>
          <label>
            City
            <input value={form.city} onChange={set("city")} maxLength={100} />
          </label>
          <label>
            Phone
            <input
              value={form.phone}
              onChange={set("phone")}
              inputMode="tel"
              placeholder="077 212 3456"
              maxLength={40}
            />
          </label>
          <label>
            Email
            <input value={form.email} onChange={set("email")} type="email" maxLength={320} />
          </label>
        </div>
        <label>
          Website
          <input
            value={form.website}
            onChange={set("website")}
            type="url"
            placeholder="https://"
            maxLength={500}
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
          <button className="btn btn-primary" disabled={busy || !form.name.trim()}>
            {busy ? "Saving…" : "Save client"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function ImportContacts({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await crm.importContacts(workspaceId, csv, dryRun);
      if (dryRun) setPreview(result);
      else setDone(result);
    } catch (err) {
      setError(errorMessage(err, "Could not read that file."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Import contacts" onClose={onClose}>
      {done ? (
        <div className="settings-form">
          <p className="alert alert-info">
            Imported {done.createdContacts} contact{done.createdContacts === 1 ? "" : "s"} and{" "}
            {done.createdCompanies} new compan{done.createdCompanies === 1 ? "y" : "ies"}.
            {done.skipped.length > 0 && ` ${done.skipped.length} row(s) skipped.`}
          </p>
          <div className="dialog-actions">
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-form">
          <p className="muted small">
            Upload a CSV of <strong>your own</strong> contacts with a <code>name</code> column and
            optionally <code>company</code>, <code>phone</code>, <code>email</code>,{" "}
            <code>role</code>, <code>notes</code>. Numbers are converted to international format
            (Zimbabwe by default); duplicates are skipped. Imported contacts are marked “consent
            unknown”, so Sir Libz will not treat them as opted in to marketing.
          </p>
          <label>
            CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setPreview(null);
                if (!file) return;
                if (file.size > 800_000) {
                  setError("That file is too large. Split it into files under 800 KB.");
                  return;
                }
                setFileName(file.name);
                void file.text().then(setCsv);
              }}
            />
          </label>
          {preview && (
            <div className="import-preview">
              <p>
                <strong>{fileName}</strong>: {preview.totalRows} rows → {preview.toCreate} new
                contact
                {preview.toCreate === 1 ? "" : "s"}
                {preview.newCompanies && preview.newCompanies.length > 0
                  ? `, ${preview.newCompanies.length} new compan${preview.newCompanies.length === 1 ? "y" : "ies"}`
                  : ""}
                .
              </p>
              {preview.skipped.length > 0 && (
                <details>
                  <summary>{preview.skipped.length} row(s) will be skipped</summary>
                  <ul className="small muted">
                    {preview.skipped.slice(0, 50).map((s) => (
                      <li key={s.row}>
                        Row {s.row}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {preview.preview && preview.preview.length > 0 && (
                <ul className="list small">
                  {preview.preview.slice(0, 5).map((p) => (
                    <li key={p.row} className="list-row">
                      <span className="list-title">{p.full_name}</span>
                      <span className="muted">{p.company ?? p.phone_e164 ?? p.email ?? ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            {preview ? (
              <button
                className="btn btn-primary"
                disabled={busy || !preview.toCreate}
                onClick={() => void run(false)}
              >
                {busy ? "Importing…" : `Import ${preview.toCreate}`}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={busy || !csv}
                onClick={() => void run(true)}
              >
                {busy ? "Checking…" : "Preview"}
              </button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
