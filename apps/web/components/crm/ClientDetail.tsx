"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Activity, Company, Contact, Deal, Project, Task } from "@/lib/crm";
import {
  ACTIVITY_TYPES,
  CURRENCIES,
  crm,
  errorMessage,
  formatMoney,
  STAGE_LABELS,
} from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { PlusIcon, TrashIcon } from "../icons";
import { BusinessOnly } from "./BusinessOnly";
import { Sheet } from "./Sheet";
import { TaskForm, TaskRow } from "./TasksView";

const ACTIVITY_LABELS: Record<Activity["type"], string> = {
  note: "Note",
  call: "Call",
  email: "Email",
  whatsapp: "WhatsApp",
  meeting: "Meeting",
};

export function ClientDetail({ id }: { id: string }) {
  return (
    <BusinessOnly title="Client">
      <Detail id={id} />
    </BusinessOnly>
  );
}

interface Data {
  company: Company;
  contacts: Contact[];
  deals: Deal[];
  projects: Project[];
  tasks: Task[];
  activities: Activity[];
}

type Dialog = "contact" | "deal" | "project" | "task" | "activity" | null;

function Detail({ id }: { id: string }) {
  const router = useRouter();
  const { workspace } = useWorkspace();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const canWrite = workspace?.role !== "viewer";
  const canDelete = workspace?.role === "owner" || workspace?.role === "admin";

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const company = await crm.companies.get(id);
      const filter = { company_id: id, limit: 100 };
      const [contacts, deals, projects, tasks, activities] = await Promise.all([
        crm.contacts.list(workspace.id, filter),
        crm.deals.list(workspace.id, filter),
        crm.projects.list(workspace.id, filter),
        crm.tasks.list(workspace.id, filter),
        crm.activities.list(workspace.id, { company_id: id, limit: 30 }),
      ]);
      setData({
        company,
        contacts: contacts.items,
        deals: deals.items,
        projects: projects.items,
        tasks: tasks.items,
        activities: activities.items,
      });
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load this client."));
    }
  }, [id, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = () => {
    setDialog(null);
    void load();
  };

  if (error && !data) {
    return (
      <div className="page">
        <p className="alert alert-error" role="alert">
          {error}
        </p>
        <Link href="/app/clients">← Back to clients</Link>
      </div>
    );
  }
  if (!data || !workspace) {
    return (
      <div className="page">
        <p className="muted small">Loading…</p>
      </div>
    );
  }

  const { company } = data;
  const openDeals = data.deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue: Record<string, number> = {};
  for (const d of openDeals) openValue[d.currency] = (openValue[d.currency] ?? 0) + Number(d.value);

  return (
    <div className="page page-wide">
      <header className="page-head page-head-actions">
        <div>
          <p className="eyebrow">
            <Link href="/app/clients">Clients</Link> · {company.industry ?? "Client"}
          </p>
          <h1>{company.name}</h1>
          <p className="muted crm-facts">
            {company.phone_e164 && <a href={`tel:${company.phone_e164}`}>{company.phone_e164}</a>}
            {company.email && <a href={`mailto:${company.email}`}>{company.email}</a>}
            {company.website && (
              <a href={company.website} target="_blank" rel="noopener noreferrer">
                {company.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            {company.city && <span>{company.city}</span>}
          </p>
        </div>
        {canWrite && (
          <div className="section-actions">
            <button className="btn btn-primary" onClick={() => setDialog("activity")}>
              Log call / note
            </button>
            {canDelete && (
              <button
                className="btn btn-ghost icon-btn"
                aria-label="Delete client"
                title="Delete client"
                onClick={() => {
                  if (!window.confirm(`Delete ${company.name} and its deals and projects?`)) return;
                  crm.companies
                    .remove(company.id)
                    .then(() => router.push("/app/clients"))
                    .catch((err: unknown) => setError(errorMessage(err, "Could not delete.")));
                }}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        )}
      </header>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <div className="crm-grid">
        <section className="panel" aria-labelledby="deals-title">
          <div className="panel-head">
            <h2 className="panel-label" id="deals-title">
              Deals · open {formatMoney(openValue)}
            </h2>
            {canWrite && (
              <button className="btn btn-ghost btn-sm" onClick={() => setDialog("deal")}>
                <PlusIcon /> Deal
              </button>
            )}
          </div>
          {data.deals.length === 0 ? (
            <p className="muted small">No deals yet.</p>
          ) : (
            <ul className="list">
              {data.deals.map((d) => (
                <li key={d.id} className="list-row">
                  <span className="crm-row-main">
                    <span className="list-title">{d.title}</span>
                    <span className="muted small">
                      {formatMoney({ [d.currency]: Number(d.value) })}
                    </span>
                  </span>
                  <span className={`stage stage-${d.stage}`}>{STAGE_LABELS[d.stage]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="contacts-title">
          <div className="panel-head">
            <h2 className="panel-label" id="contacts-title">
              Contacts · {data.contacts.length}
            </h2>
            {canWrite && (
              <button className="btn btn-ghost btn-sm" onClick={() => setDialog("contact")}>
                <PlusIcon /> Contact
              </button>
            )}
          </div>
          {data.contacts.length === 0 ? (
            <p className="muted small">No contacts yet.</p>
          ) : (
            <ul className="list">
              {data.contacts.map((c) => (
                <li key={c.id} className="list-row">
                  <span className="crm-row-main">
                    <span className="list-title">{c.full_name}</span>
                    <span className="muted small">
                      {[c.role_title, c.phone_e164, c.email].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </span>
                  {c.do_not_contact ? (
                    <span className="tag tag-danger">Do not contact</span>
                  ) : c.marketing_consent === "granted" ? (
                    <span className="tag tag-ok">Opted in</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="tasks-title">
          <div className="panel-head">
            <h2 className="panel-label" id="tasks-title">
              Tasks ·{" "}
              {data.tasks.filter((t) => t.status === "open" || t.status === "in_progress").length}{" "}
              open
            </h2>
            {canWrite && (
              <button className="btn btn-ghost btn-sm" onClick={() => setDialog("task")}>
                <PlusIcon /> Task
              </button>
            )}
          </div>
          {data.tasks.length === 0 ? (
            <p className="muted small">No tasks yet.</p>
          ) : (
            <ul className="list">
              {data.tasks.map((t) => (
                <TaskRow key={t.id} task={t} canWrite={canWrite} onChanged={() => void load()} />
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="projects-title">
          <div className="panel-head">
            <h2 className="panel-label" id="projects-title">
              Projects · {data.projects.length}
            </h2>
            {canWrite && (
              <button className="btn btn-ghost btn-sm" onClick={() => setDialog("project")}>
                <PlusIcon /> Project
              </button>
            )}
          </div>
          {data.projects.length === 0 ? (
            <p className="muted small">No projects yet.</p>
          ) : (
            <ul className="list">
              {data.projects.map((p) => (
                <li key={p.id} className="list-row">
                  <span className="list-title">{p.name}</span>
                  <span className="tag capitalize">{p.status.replace("_", " ")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel crm-span" aria-labelledby="timeline-title">
          <h2 className="panel-label" id="timeline-title">
            Timeline
          </h2>
          {data.activities.length === 0 ? (
            <p className="muted small">No calls, messages or notes logged yet.</p>
          ) : (
            <ol className="timeline">
              {data.activities.map((a) => (
                <li key={a.id}>
                  <span className="timeline-dot" aria-hidden="true" />
                  <div>
                    <p className="timeline-title">
                      {ACTIVITY_LABELS[a.type]}
                      {a.direction !== "internal" ? ` · ${a.direction}` : ""}
                    </p>
                    <p className="crm-summary">{a.summary}</p>
                    <p className="muted small">{new Date(a.occurred_at).toLocaleString()}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {dialog === "activity" && (
        <ActivityForm
          workspaceId={workspace.id}
          company={company}
          contacts={data.contacts}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog === "contact" && (
        <ContactForm
          workspaceId={workspace.id}
          companyId={company.id}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog === "deal" && (
        <DealForm
          workspaceId={workspace.id}
          companyId={company.id}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog === "project" && (
        <ProjectForm
          workspaceId={workspace.id}
          companyId={company.id}
          deals={data.deals}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog === "task" && (
        <Sheet title="Add task" onClose={() => setDialog(null)}>
          <TaskForm workspaceId={workspace.id} extra={{ companyId: company.id }} onSaved={saved} />
        </Sheet>
      )}
    </div>
  );
}

interface FormProps {
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}

function useSubmit(onSaved: () => void, fallback: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved();
    } catch (err) {
      setError(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function FormError({ error }: { error: string | null }) {
  return error ? (
    <p className="alert alert-error" role="alert">
      {error}
    </p>
  ) : null;
}

function Actions({
  busy,
  label,
  onClose,
  disabled,
}: {
  busy: boolean;
  label: string;
  onClose: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="dialog-actions">
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <button className="btn btn-primary" disabled={busy || disabled}>
        {busy ? "Saving…" : label}
      </button>
    </div>
  );
}

function ActivityForm({
  workspaceId,
  company,
  contacts,
  onClose,
  onSaved,
}: FormProps & { company: Company; contacts: Contact[] }) {
  const [type, setType] = useState<Activity["type"]>("call");
  const [direction, setDirection] = useState<Activity["direction"]>("outbound");
  const [contactId, setContactId] = useState("");
  const [summary, setSummary] = useState("");
  const { busy, error, submit } = useSubmit(onSaved, "Could not log this.");

  return (
    <Sheet title={`Log activity · ${company.name}`} onClose={onClose}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(() =>
            crm.activities.create(workspaceId, {
              type,
              direction: type === "note" ? "internal" : direction,
              summary: summary.trim(),
              companyId: company.id,
              ...(contactId ? { contactId } : {}),
            }),
          );
        }}
      >
        <p className="muted small">
          This records what already happened. Jarvis does not send messages or place calls.
        </p>
        <div className="form-grid">
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as Activity["type"])}>
              {ACTIVITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACTIVITY_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          {type !== "note" && (
            <label>
              Direction
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as Activity["direction"])}
              >
                <option value="outbound">Outbound</option>
                <option value="inbound">Inbound</option>
              </select>
            </label>
          )}
        </div>
        {contacts.length > 0 && (
          <label>
            With
            <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">—</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Summary
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={4}
            maxLength={5000}
            required
            autoFocus
          />
        </label>
        <FormError error={error} />
        <Actions busy={busy} label="Save" onClose={onClose} disabled={!summary.trim()} />
      </form>
    </Sheet>
  );
}

function ContactForm({
  workspaceId,
  companyId,
  onClose,
  onSaved,
}: FormProps & { companyId: string }) {
  const [form, setForm] = useState({ fullName: "", roleTitle: "", phone: "", email: "" });
  const [doNotContact, setDoNotContact] = useState(false);
  const { busy, error, submit } = useSubmit(onSaved, "Could not save the contact.");
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Sheet title="Add contact" onClose={onClose}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ""));
          void submit(() => crm.contacts.create(workspaceId, { ...body, companyId, doNotContact }));
        }}
      >
        <label>
          Full name
          <input
            value={form.fullName}
            onChange={set("fullName")}
            required
            maxLength={200}
            autoFocus
          />
        </label>
        <div className="form-grid">
          <label>
            Role
            <input value={form.roleTitle} onChange={set("roleTitle")} maxLength={100} />
          </label>
          <label>
            Phone
            <input value={form.phone} onChange={set("phone")} inputMode="tel" maxLength={40} />
          </label>
        </div>
        <label>
          Email
          <input value={form.email} onChange={set("email")} type="email" maxLength={320} />
        </label>
        <label className="switch switch-left">
          <input
            type="checkbox"
            checked={doNotContact}
            onChange={(e) => setDoNotContact(e.target.checked)}
          />
          Do not contact (they asked not to be contacted)
        </label>
        <FormError error={error} />
        <Actions
          busy={busy}
          label="Save contact"
          onClose={onClose}
          disabled={!form.fullName.trim()}
        />
      </form>
    </Sheet>
  );
}

export function DealForm({
  workspaceId,
  companyId,
  companies,
  onClose,
  onSaved,
}: FormProps & { companyId?: string; companies?: Company[] }) {
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState(companyId ?? "");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [expectedClose, setExpectedClose] = useState("");
  const { busy, error, submit } = useSubmit(onSaved, "Could not save the deal.");

  return (
    <Sheet title="Add deal" onClose={onClose}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(() =>
            crm.deals.create(workspaceId, {
              title: title.trim(),
              companyId: company,
              currency,
              ...(value ? { value: Math.round(Number(value) * 100) / 100 } : {}),
              ...(expectedClose ? { expectedClose } : {}),
            }),
          );
        }}
      >
        <label>
          Deal
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="e.g. WhatsApp booking bot"
            autoFocus
          />
        </label>
        {!companyId && (
          <label>
            Client
            <select value={company} onChange={(e) => setCompany(e.target.value)} required>
              <option value="">Choose a client…</option>
              {companies?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="form-grid">
          <label>
            Value
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
            />
          </label>
          <label>
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Expected close
          <input
            value={expectedClose}
            onChange={(e) => setExpectedClose(e.target.value)}
            type="date"
          />
        </label>
        <FormError error={error} />
        <Actions
          busy={busy}
          label="Save deal"
          onClose={onClose}
          disabled={!title.trim() || !company}
        />
      </form>
    </Sheet>
  );
}

export function ProjectForm({
  workspaceId,
  companyId,
  companies,
  deals,
  onClose,
  onSaved,
}: FormProps & { companyId?: string; companies?: Company[]; deals?: Deal[] }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState(companyId ?? "");
  const [dealId, setDealId] = useState("");
  const [budget, setBudget] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const { busy, error, submit } = useSubmit(onSaved, "Could not save the project.");

  return (
    <Sheet title="Add project" onClose={onClose}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(() =>
            crm.projects.create(workspaceId, {
              name: name.trim(),
              companyId: company,
              currency,
              status: "active",
              ...(dealId ? { dealId } : {}),
              ...(budget ? { budget: Math.round(Number(budget) * 100) / 100 } : {}),
              ...(startDate ? { startDate } : {}),
              ...(endDate ? { endDate } : {}),
            }),
          );
        }}
      >
        <label>
          Project
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            autoFocus
          />
        </label>
        {!companyId && (
          <label>
            Client
            <select value={company} onChange={(e) => setCompany(e.target.value)} required>
              <option value="">Choose a client…</option>
              {companies?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {deals && deals.length > 0 && (
          <label>
            From deal
            <select value={dealId} onChange={(e) => setDealId(e.target.value)}>
              <option value="">—</option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="form-grid">
          <label>
            Budget
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
            />
          </label>
          <label>
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Start
            <input value={startDate} onChange={(e) => setStartDate(e.target.value)} type="date" />
          </label>
          <label>
            End
            <input value={endDate} onChange={(e) => setEndDate(e.target.value)} type="date" />
          </label>
        </div>
        <FormError error={error} />
        <Actions
          busy={busy}
          label="Save project"
          onClose={onClose}
          disabled={!name.trim() || !company}
        />
      </form>
    </Sheet>
  );
}
