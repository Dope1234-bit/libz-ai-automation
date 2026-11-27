import { AppError, ErrorCode } from "@jarvis/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { unwrap } from "../db.js";
import { normalizeEmail, normalizePhone } from "../lib/phone.js";
import { parseBody, uuidParam } from "../validation.js";

/*
 * Business core API: companies, contacts, deals, projects, tasks, activities.
 * One factory gives every entity the same list/create/read/update/delete
 * behaviour; row-level security in Postgres decides what each user may do.
 */

const CURRENCIES = ["USD", "ZWG", "ZAR", "GBP", "EUR"] as const;
const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1, "must not be empty").max(max);
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const id = z.uuid();
const tags = z.array(z.string().trim().min(1).max(40)).max(20);
const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });
const money = z.number().nonnegative().max(1e12).multipleOf(0.01);

/** camelCase body keys -> snake_case columns; phone/email are normalised. */
function toRow(body: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === "phone") {
      if (value === null || value === "") {
        row.phone_e164 = null;
      } else {
        const phone = normalizePhone(String(value));
        if (!phone)
          throw new AppError(
            ErrorCode.BadRequest,
            "Invalid request: phone: not a valid phone number",
          );
        row.phone_e164 = phone;
      }
      continue;
    }
    if (key === "email") {
      if (value === null || value === "") {
        row.email = null;
      } else {
        const email = normalizeEmail(String(value));
        if (!email)
          throw new AppError(
            ErrorCode.BadRequest,
            "Invalid request: email: not a valid email address",
          );
        row.email = email;
      }
      continue;
    }
    row[key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)] = value === "" ? null : value;
  }
  return row;
}

/** Escape LIKE wildcards in user search text. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

interface EntityConfig {
  /** Table name and URL segment. */
  table: "companies" | "contacts" | "deals" | "projects" | "tasks" | "activities";
  label: string;
  columns: string;
  create: z.ZodObject;
  update: z.ZodObject;
  searchColumn?: string;
  /** Query parameter -> column, with a validator for the value. */
  filters?: Record<string, { column: string; schema: z.ZodType }>;
  order: { column: string; ascending: boolean; nullsFirst?: boolean };
  /** Extra list filters computed from query params (e.g. task due views). */
  customFilters?: (query: QueryBuilder, c: Context<AppEnv>) => QueryBuilder;
}

// Minimal structural type for the PostgREST builder methods used here.
interface QueryBuilder {
  eq(column: string, value: unknown): QueryBuilder;
  in(column: string, values: unknown[]): QueryBuilder;
  lt(column: string, value: unknown): QueryBuilder;
  gte(column: string, value: unknown): QueryBuilder;
  ilike(column: string, pattern: string): QueryBuilder;
  not(column: string, operator: string, value: unknown): QueryBuilder;
}

export const ENTITIES: EntityConfig[] = [
  {
    table: "companies",
    label: "Company",
    columns:
      "id, workspace_id, name, industry, website, phone_e164, email, address, city, country, source, notes, tags, attributes, created_by, created_at, updated_at",
    create: z
      .object({
        name: required(200),
        industry: optional(text(100)),
        website: optional(z.url({ protocol: /^https?$/ }).max(500)),
        phone: optional(z.string().max(40)),
        email: optional(z.string().max(320)),
        address: optional(text(500)),
        city: optional(text(100)),
        country: optional(text(100)),
        source: z.enum(["manual", "import", "referral", "website", "event", "other"]).optional(),
        notes: optional(text(5000)),
        tags: tags.optional(),
      })
      .strict(),
    update: z.object({}).strict(), // filled below as partial(create)
    searchColumn: "name",
    order: { column: "name", ascending: true },
  },
  {
    table: "contacts",
    label: "Contact",
    columns:
      "id, workspace_id, company_id, full_name, role_title, phone_e164, email, marketing_consent, consent_source, consent_at, do_not_contact, notes, tags, created_by, created_at, updated_at",
    create: z
      .object({
        companyId: optional(id),
        fullName: required(200),
        roleTitle: optional(text(100)),
        phone: optional(z.string().max(40)),
        email: optional(z.string().max(320)),
        marketingConsent: z.enum(["unknown", "granted", "denied"]).optional(),
        consentSource: optional(text(200)),
        consentAt: optional(datetime),
        doNotContact: z.boolean().optional(),
        notes: optional(text(5000)),
        tags: tags.optional(),
      })
      .strict(),
    update: z.object({}).strict(),
    searchColumn: "full_name",
    filters: { company_id: { column: "company_id", schema: id } },
    order: { column: "full_name", ascending: true },
  },
  {
    table: "deals",
    label: "Deal",
    columns:
      "id, workspace_id, company_id, contact_id, title, stage, value, currency, expected_close, owner_id, lost_reason, stage_changed_at, closed_at, created_by, created_at, updated_at, companies (name)",
    create: z
      .object({
        companyId: id,
        contactId: optional(id),
        title: required(200),
        stage: z
          .enum(["lead", "contacted", "qualified", "proposal", "negotiation", "won", "lost"])
          .optional(),
        value: money.optional(),
        currency: z.enum(CURRENCIES).optional(),
        expectedClose: optional(date),
        ownerId: optional(id),
        lostReason: optional(text(500)),
      })
      .strict(),
    update: z.object({}).strict(),
    searchColumn: "title",
    filters: {
      stage: {
        column: "stage",
        schema: z.enum([
          "lead",
          "contacted",
          "qualified",
          "proposal",
          "negotiation",
          "won",
          "lost",
        ]),
      },
      company_id: { column: "company_id", schema: id },
    },
    order: { column: "updated_at", ascending: false },
  },
  {
    table: "projects",
    label: "Project",
    columns:
      "id, workspace_id, company_id, deal_id, name, status, description, start_date, end_date, budget, currency, created_by, created_at, updated_at, companies (name)",
    create: z
      .object({
        companyId: id,
        dealId: optional(id),
        name: required(200),
        status: z.enum(["planned", "active", "on_hold", "done", "cancelled"]).optional(),
        description: optional(text(5000)),
        startDate: optional(date),
        endDate: optional(date),
        budget: optional(money),
        currency: z.enum(CURRENCIES).optional(),
      })
      .strict(),
    update: z.object({}).strict(),
    searchColumn: "name",
    filters: {
      status: {
        column: "status",
        schema: z.enum(["planned", "active", "on_hold", "done", "cancelled"]),
      },
      company_id: { column: "company_id", schema: id },
    },
    order: { column: "updated_at", ascending: false },
  },
  {
    table: "tasks",
    label: "Task",
    columns:
      "id, workspace_id, title, notes, due_at, status, priority, assignee_id, company_id, contact_id, deal_id, project_id, completed_at, created_by, created_at, updated_at",
    create: z
      .object({
        title: required(300),
        notes: optional(text(5000)),
        dueAt: optional(datetime),
        status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        assigneeId: optional(id),
        companyId: optional(id),
        contactId: optional(id),
        dealId: optional(id),
        projectId: optional(id),
      })
      .strict(),
    update: z.object({}).strict(),
    searchColumn: "title",
    filters: {
      status: { column: "status", schema: z.enum(["open", "in_progress", "done", "cancelled"]) },
      company_id: { column: "company_id", schema: id },
      deal_id: { column: "deal_id", schema: id },
      project_id: { column: "project_id", schema: id },
    },
    order: { column: "due_at", ascending: true, nullsFirst: false },
    customFilters: (query, c) => {
      const view = c.req.query("view");
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
      let q = query;
      if (c.req.query("assignee") === "me") q = q.eq("assignee_id", c.get("user").id);
      if (view === "open") q = q.in("status", ["open", "in_progress"]);
      if (view === "overdue")
        q = q.in("status", ["open", "in_progress"]).lt("due_at", startOfDay.toISOString());
      if (view === "today") {
        q = q
          .in("status", ["open", "in_progress"])
          .gte("due_at", startOfDay.toISOString())
          .lt("due_at", endOfDay.toISOString());
      }
      return q;
    },
  },
  {
    table: "activities",
    label: "Activity",
    columns:
      "id, workspace_id, type, direction, summary, occurred_at, company_id, contact_id, deal_id, project_id, source, created_by, created_at",
    create: z
      .object({
        type: z.enum(["note", "call", "email", "whatsapp", "meeting"]),
        direction: z.enum(["inbound", "outbound", "internal"]).optional(),
        summary: required(5000),
        occurredAt: optional(datetime),
        companyId: optional(id),
        contactId: optional(id),
        dealId: optional(id),
        projectId: optional(id),
      })
      .strict(),
    update: z.object({}).strict(),
    searchColumn: "summary",
    filters: {
      type: { column: "type", schema: z.enum(["note", "call", "email", "whatsapp", "meeting"]) },
      company_id: { column: "company_id", schema: id },
      contact_id: { column: "contact_id", schema: id },
      deal_id: { column: "deal_id", schema: id },
      project_id: { column: "project_id", schema: id },
    },
    order: { column: "occurred_at", ascending: false },
  },
];

for (const entity of ENTITIES) {
  entity.update = entity.create
    .partial()
    .strict()
    .refine(
      (b) => Object.keys(b).length > 0,
      "at least one field is required",
    ) as unknown as z.ZodObject;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).max(100_000).catch(0),
});

export const crmRoutes = new Hono<AppEnv>();

for (const entity of ENTITIES) {
  const notFound = () => new AppError(ErrorCode.NotFound, `${entity.label} not found.`);

  crmRoutes.get(`/workspaces/:workspaceId/${entity.table}`, async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const { limit, offset } = listQuery.parse(c.req.query());
    let query = c
      .get("db")
      .from(entity.table)
      .select(entity.columns, { count: "exact" })
      .eq("workspace_id", workspaceId) as unknown as QueryBuilder;

    for (const [param, filter] of Object.entries(entity.filters ?? {})) {
      const raw = c.req.query(param);
      if (raw === undefined) continue;
      const parsed = filter.schema.safeParse(raw);
      if (!parsed.success)
        throw new AppError(ErrorCode.BadRequest, `Invalid request: ${param}: invalid value`);
      query = query.eq(filter.column, parsed.data);
    }
    const q = c.req.query("q")?.trim();
    if (q && entity.searchColumn)
      query = query.ilike(entity.searchColumn, likePattern(q.slice(0, 100)));
    if (entity.customFilters) query = entity.customFilters(query, c);

    const result = await (
      query as unknown as {
        order: (
          col: string,
          opts: object,
        ) => {
          range: (
            a: number,
            b: number,
          ) => PromiseLike<{
            data: unknown[] | null;
            error: { code?: string; message?: string } | null;
            count: number | null;
          }>;
        };
      }
    )
      .order(entity.order.column, {
        ascending: entity.order.ascending,
        ...(entity.order.nullsFirst !== undefined ? { nullsFirst: entity.order.nullsFirst } : {}),
      })
      .range(offset, offset + limit - 1);
    const rows = unwrap(result);
    return c.json({ items: rows, total: result.count ?? rows.length, limit, offset });
  });

  crmRoutes.post(`/workspaces/:workspaceId/${entity.table}`, async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const body = await parseBody(c, entity.create);
    const item = await c
      .get("db")
      .from(entity.table)
      .insert({ ...toRow(body as Record<string, unknown>), workspace_id: workspaceId })
      .select(entity.columns)
      .single()
      .then(unwrap);
    return c.json({ item }, 201);
  });

  crmRoutes.get(`/${entity.table}/:id`, async (c) => {
    const itemId = uuidParam(c, "id");
    const rows = await c
      .get("db")
      .from(entity.table)
      .select(entity.columns)
      .eq("id", itemId)
      .limit(1)
      .then(unwrap);
    if (rows.length === 0) throw notFound();
    return c.json({ item: rows[0] });
  });

  crmRoutes.patch(`/${entity.table}/:id`, async (c) => {
    const itemId = uuidParam(c, "id");
    const body = await parseBody(c, entity.update);
    const rows = await c
      .get("db")
      .from(entity.table)
      .update(toRow(body as Record<string, unknown>))
      .eq("id", itemId)
      .select(entity.columns)
      .then(unwrap);
    if (rows.length === 0) throw notFound();
    return c.json({ item: rows[0] });
  });

  crmRoutes.delete(`/${entity.table}/:id`, async (c) => {
    const itemId = uuidParam(c, "id");
    const rows = await c
      .get("db")
      .from(entity.table)
      .delete()
      .eq("id", itemId)
      .select("id")
      .then(unwrap);
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  });
}
