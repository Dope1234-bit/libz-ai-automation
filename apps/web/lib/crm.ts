"use client";

import { api } from "./api";

export const DEAL_STAGES = [
  "lead",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const STAGE_LABELS: Record<DealStage, string> = {
  lead: "Lead",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export const CURRENCIES = ["USD", "ZWG", "ZAR", "GBP", "EUR"] as const;
export const PROJECT_STATUSES = ["planned", "active", "on_hold", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const ACTIVITY_TYPES = ["note", "call", "email", "whatsapp", "meeting"] as const;

export interface Company {
  id: string;
  workspace_id: string;
  name: string;
  industry: string | null;
  website: string | null;
  phone_e164: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  source: string;
  notes: string | null;
  tags: string[];
  created_at: string;
}

export interface Contact {
  id: string;
  company_id: string | null;
  full_name: string;
  role_title: string | null;
  phone_e164: string | null;
  email: string | null;
  marketing_consent: "unknown" | "granted" | "denied";
  do_not_contact: boolean;
  notes: string | null;
  created_at: string;
}

export interface Deal {
  id: string;
  company_id: string;
  contact_id: string | null;
  title: string;
  stage: DealStage;
  value: number;
  currency: string;
  expected_close: string | null;
  closed_at: string | null;
  stage_changed_at: string;
  companies: { name: string } | null;
  created_at: string;
}

export interface Project {
  id: string;
  company_id: string;
  deal_id: string | null;
  name: string;
  status: (typeof PROJECT_STATUSES)[number];
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  budget: number | null;
  currency: string;
  companies: { name: string } | null;
  created_at: string;
}

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  priority: (typeof TASK_PRIORITIES)[number];
  assignee_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Activity {
  id: string;
  type: (typeof ACTIVITY_TYPES)[number];
  direction: "inbound" | "outbound" | "internal";
  summary: string;
  occurred_at: string;
  company_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  source: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Summary {
  generatedAt: string;
  pipeline: {
    byStage: { stage: DealStage; count: number; value: Record<string, number> }[];
    open: Record<string, number>;
  };
  wonThisMonth: { count: number; value: Record<string, number> };
  lostThisMonth: number;
  tasks: { open: number; overdue: number; dueToday: number };
  counts: { companies: number; contacts: number; activitiesLast7Days: number };
  revenueBasis: "won_deals";
}

export interface ImportResult {
  dryRun: boolean;
  totalRows: number;
  toCreate?: number;
  createdContacts?: number;
  createdCompanies?: number;
  newCompanies?: string[];
  skipped: { row: number; reason: string }[];
  preview?: {
    row: number;
    full_name: string;
    email: string | null;
    phone_e164: string | null;
    company: string | null;
  }[];
}

type Entity = "companies" | "contacts" | "deals" | "projects" | "tasks" | "activities";
type Query = Record<string, string | number | undefined>;

function qs(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Fired after any task change so badges (e.g. overdue count) stay current. */
export const TASKS_CHANGED = "jarvis:tasks-changed";

function entity<T>(name: Entity) {
  const changed = <R>(result: R): R => {
    if (name === "tasks" && typeof window !== "undefined")
      window.dispatchEvent(new Event(TASKS_CHANGED));
    return result;
  };
  return {
    list: (workspaceId: string, query?: Query) =>
      api.raw<Page<T>>("GET", `/v1/workspaces/${workspaceId}/${name}${qs(query)}`),
    get: (id: string) => api.raw<{ item: T }>("GET", `/v1/${name}/${id}`).then((r) => r.item),
    create: (workspaceId: string, body: Record<string, unknown>) =>
      api
        .raw<{ item: T }>("POST", `/v1/workspaces/${workspaceId}/${name}`, body)
        .then((r) => changed(r.item)),
    update: (id: string, body: Record<string, unknown>) =>
      api.raw<{ item: T }>("PATCH", `/v1/${name}/${id}`, body).then((r) => changed(r.item)),
    remove: (id: string) => api.raw<void>("DELETE", `/v1/${name}/${id}`).then(changed),
  };
}

export const crm = {
  companies: entity<Company>("companies"),
  contacts: entity<Contact>("contacts"),
  deals: entity<Deal>("deals"),
  projects: entity<Project>("projects"),
  tasks: entity<Task>("tasks"),
  activities: entity<Activity>("activities"),
  summary: (workspaceId: string) =>
    api.raw<Summary>("GET", `/v1/workspaces/${workspaceId}/reports/summary`),
  importContacts: (workspaceId: string, csv: string, dryRun: boolean) =>
    api.raw<ImportResult>("POST", `/v1/workspaces/${workspaceId}/import/contacts`, { csv, dryRun }),
};

/** "USD 1,200.00 · ZAR 500.00" — amounts in different currencies are never summed together. */
export function formatMoney(values: Record<string, number>, empty = "—"): string {
  const entries = Object.entries(values).filter(([, v]) => v > 0);
  if (entries.length === 0) return empty;
  return entries
    .map(([currency, v]) => {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(v);
      } catch {
        return `${currency} ${v.toFixed(2)}`;
      }
    })
    .join(" · ");
}

export function formatDue(iso: string | null): string {
  if (!iso) return "No due date";
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000);
  if (days === 0)
    return `Today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function isOverdue(task: Pick<Task, "due_at" | "status">): boolean {
  if (!task.due_at || task.status === "done" || task.status === "cancelled") return false;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  return Date.parse(task.due_at) < startOfToday.getTime();
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export interface Prospect {
  placeId: string;
  name: string;
  address: string | null;
  phone: string | null;
  phoneE164: string | null;
  website: string | null;
  googleMapsUri: string | null;
  rating: number | null;
  ratingCount: number | null;
  types: string[];
  businessStatus: string | null;
  existingClientId: string | null;
}

export const prospects = {
  status: (workspaceId: string) =>
    api.raw<{ configured: boolean; dailyLimit: number }>(
      "GET",
      `/v1/workspaces/${workspaceId}/prospects/status`,
    ),
  search: (workspaceId: string, body: { what: string; where?: string; pageToken?: string }) =>
    api.raw<{ query: string; nextPageToken: string | null; results: Prospect[] }>(
      "POST",
      `/v1/workspaces/${workspaceId}/prospects/search`,
      body,
    ),
  add: (workspaceId: string, placeId: string, createDeal: boolean) =>
    api.raw<{ company: { id: string; name: string }; dealId: string | null }>(
      "POST",
      `/v1/workspaces/${workspaceId}/prospects/add`,
      { placeId, createDeal },
    ),
};
