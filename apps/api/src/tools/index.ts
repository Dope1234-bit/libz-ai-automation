import type { ToolDefinition } from "@jarvis/ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { unwrap } from "../db.js";
import { workspaceSummary } from "../lib/reports.js";

/**
 * Jarvis's workspace tools. Every query runs through the caller's own Supabase
 * client, so row-level security limits Jarvis to exactly what the user can
 * see. Read tools return real rows only; "propose_" tools never write business
 * records — they store a proposal the user must confirm.
 */

export interface ToolContext {
  db: SupabaseClient;
  workspaceId: string;
  workspaceType: "personal" | "business";
  conversationId: string;
  userId: string;
}

export interface Proposal {
  id: string;
  kind: "task" | "activity_note";
  summary: string;
  payload: Record<string, unknown>;
  status: "pending" | "confirmed" | "dismissed";
  result_id: string | null;
  created_at: string;
}

export interface ToolOutcome {
  /** JSON-serialisable data returned to the model. */
  result: unknown;
  /** Short, content-free label for the UI ("Checked the pipeline"). */
  label: string;
  proposal?: Proposal;
}

interface WorkspaceTool {
  definition: ToolDefinition;
  /** Workspaces where the tool is offered. */
  scope: "business" | "any";
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Upper bound on tool output sent back to the model. */
export const TOOL_RESULT_CHARS = 8000;

const uuid = z.uuid();
const STAGES = [
  "lead",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
const ACTIVITY_TYPES = ["note", "call", "email", "whatsapp", "meeting"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

const isoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date or date-time")
  .transform((v) => new Date(v).toISOString());

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

function parse<T extends z.ZodType>(schema: T, args: Record<string, unknown>): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new ToolInputError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

export class ToolInputError extends Error {}

async function requireClient(ctx: ToolContext, clientId: string) {
  const rows = await ctx.db
    .from("companies")
    .select("id, name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", clientId)
    .limit(1)
    .then(unwrap);
  if (!rows[0]) throw new ToolInputError("client_id does not match a client in this workspace");
  return rows[0] as { id: string; name: string };
}

async function createProposal(
  ctx: ToolContext,
  kind: Proposal["kind"],
  payload: Record<string, unknown>,
  summary: string,
): Promise<Proposal> {
  const rows = await ctx.db
    .from("ai_proposals")
    .insert({
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      kind,
      payload,
      summary: summary.slice(0, 500),
    })
    .select("id, kind, summary, payload, status, result_id, created_at")
    .then(unwrap);
  return rows[0] as Proposal;
}

const TOOLS: WorkspaceTool[] = [
  {
    scope: "business",
    definition: {
      name: "search_clients",
      description:
        "Search this workspace's clients (companies) and contacts by name. Use it to find a client_id before other tools.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Part of a company or person name." } },
        required: ["query"],
      },
    },
    async run(args, ctx) {
      const { query } = parse(z.object({ query: z.string().trim().min(1).max(100) }), args);
      const [companies, contacts] = await Promise.all([
        ctx.db
          .from("companies")
          .select("id, name, industry, city, phone_e164, email")
          .eq("workspace_id", ctx.workspaceId)
          .ilike("name", likePattern(query))
          .order("name")
          .limit(10)
          .then(unwrap),
        ctx.db
          .from("contacts")
          .select("id, full_name, role_title, company_id, do_not_contact, companies (name)")
          .eq("workspace_id", ctx.workspaceId)
          .ilike("full_name", likePattern(query))
          .order("full_name")
          .limit(10)
          .then(unwrap),
      ]);
      return { label: "Searched clients", result: { clients: companies, contacts } };
    },
  },
  {
    scope: "business",
    definition: {
      name: "get_client",
      description:
        "Full record for one client: details, contacts, deals, projects, open tasks and recent activity.",
      parameters: {
        type: "object",
        properties: {
          client_id: { type: "string", description: "Client (company) id from search_clients." },
        },
        required: ["client_id"],
      },
    },
    async run(args, ctx) {
      const { client_id } = parse(z.object({ client_id: uuid }), args);
      const companies = await ctx.db
        .from("companies")
        .select(
          "id, name, industry, website, phone_e164, email, city, country, source, notes, tags, created_at",
        )
        .eq("workspace_id", ctx.workspaceId)
        .eq("id", client_id)
        .limit(1)
        .then(unwrap);
      if (!companies[0])
        return { label: "Looked up a client", result: { error: "No client with that id." } };
      const scoped = <T>(table: string, columns: string, build?: (q: T) => T) => {
        let q = ctx.db
          .from(table)
          .select(columns)
          .eq("workspace_id", ctx.workspaceId)
          .eq("company_id", client_id);
        if (build) q = build(q as T) as typeof q;
        return q.limit(20).then(unwrap);
      };
      const [contacts, deals, projects, tasks, activities] = await Promise.all([
        scoped(
          "contacts",
          "id, full_name, role_title, phone_e164, email, marketing_consent, do_not_contact",
        ),
        scoped("deals", "id, title, stage, value, currency, expected_close, closed_at"),
        scoped("projects", "id, name, status, start_date, end_date, budget, currency"),
        ctx.db
          .from("tasks")
          .select("id, title, due_at, status, priority")
          .eq("workspace_id", ctx.workspaceId)
          .eq("company_id", client_id)
          .in("status", ["open", "in_progress"])
          .order("due_at", { ascending: true, nullsFirst: false })
          .limit(20)
          .then(unwrap),
        ctx.db
          .from("activities")
          .select("type, direction, summary, occurred_at, source")
          .eq("workspace_id", ctx.workspaceId)
          .eq("company_id", client_id)
          .order("occurred_at", { ascending: false })
          .limit(10)
          .then(unwrap),
      ]);
      return {
        label: "Read a client record",
        result: {
          client: companies[0],
          contacts,
          deals,
          projects,
          open_tasks: tasks,
          recent_activities: activities,
        },
      };
    },
  },
  {
    scope: "business",
    definition: {
      name: "pipeline_summary",
      description:
        "Live business summary: deals and value per stage (per currency), open pipeline, won/lost this month, task counts, client and contact counts.",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      return {
        label: "Checked the pipeline",
        result: await workspaceSummary(ctx.db, ctx.workspaceId),
      };
    },
  },
  {
    scope: "business",
    definition: {
      name: "list_deals",
      description: "List deals, optionally filtered by stage or client. Newest first.",
      parameters: {
        type: "object",
        properties: {
          stage: { type: "string", enum: [...STAGES] },
          client_id: { type: "string" },
          limit: { type: "integer", description: "1-50, default 20" },
        },
      },
    },
    async run(args, ctx) {
      const a = parse(
        z.object({
          stage: z.enum(STAGES).optional(),
          client_id: uuid.optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        args,
      );
      let q = ctx.db
        .from("deals")
        .select(
          "id, title, stage, value, currency, expected_close, closed_at, stage_changed_at, companies (id, name)",
        )
        .eq("workspace_id", ctx.workspaceId);
      if (a.stage) q = q.eq("stage", a.stage);
      if (a.client_id) q = q.eq("company_id", a.client_id);
      const deals = await q.order("created_at", { ascending: false }).limit(a.limit).then(unwrap);
      return { label: "Listed deals", result: { deals } };
    },
  },
  {
    scope: "any",
    definition: {
      name: "list_tasks",
      description:
        "List tasks in this workspace. view: open (default), today (due today), overdue, or done (recently completed).",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", enum: ["open", "today", "overdue", "done"] },
          limit: { type: "integer", description: "1-50, default 20" },
        },
      },
    },
    async run(args, ctx) {
      const a = parse(
        z.object({
          view: z.enum(["open", "today", "overdue", "done"]).default("open"),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        args,
      );
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
      let q = ctx.db
        .from("tasks")
        .select("id, title, notes, due_at, status, priority, company_id, completed_at")
        .eq("workspace_id", ctx.workspaceId);
      if (a.view === "done") {
        q = q.eq("status", "done").order("completed_at", { ascending: false });
      } else {
        q = q.in("status", ["open", "in_progress"]);
        if (a.view === "overdue") q = q.lt("due_at", startOfDay.toISOString());
        if (a.view === "today")
          q = q.gte("due_at", startOfDay.toISOString()).lt("due_at", endOfDay.toISOString());
        q = q.order("due_at", { ascending: true, nullsFirst: false });
      }
      const tasks = await q.limit(a.limit).then(unwrap);
      return { label: "Checked tasks", result: { view: a.view, tasks } };
    },
  },
  {
    scope: "business",
    definition: {
      name: "recent_activities",
      description: "Logged calls, emails, WhatsApp messages, meetings and notes, newest first.",
      parameters: {
        type: "object",
        properties: {
          client_id: { type: "string" },
          days: { type: "integer", description: "Look back this many days (1-90, default 14)." },
          limit: { type: "integer", description: "1-50, default 20" },
        },
      },
    },
    async run(args, ctx) {
      const a = parse(
        z.object({
          client_id: uuid.optional(),
          days: z.number().int().min(1).max(90).default(14),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        args,
      );
      let q = ctx.db
        .from("activities")
        .select("type, direction, summary, occurred_at, source, companies (id, name)")
        .eq("workspace_id", ctx.workspaceId)
        .gte("occurred_at", new Date(Date.now() - a.days * 86_400_000).toISOString());
      if (a.client_id) q = q.eq("company_id", a.client_id);
      const activities = await q
        .order("occurred_at", { ascending: false })
        .limit(a.limit)
        .then(unwrap);
      return { label: "Read recent activity", result: { days: a.days, activities } };
    },
  },
  {
    scope: "any",
    definition: {
      name: "propose_task",
      description:
        "Propose a task. The user sees a card and must confirm before anything is saved. Use ISO 8601 for due_at.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: "string" },
          due_at: { type: "string", description: "ISO 8601 date-time, e.g. 2026-12-01T09:00:00Z" },
          priority: { type: "string", enum: [...PRIORITIES] },
          client_id: { type: "string", description: "Business workspaces only." },
        },
        required: ["title"],
      },
    },
    async run(args, ctx) {
      const a = parse(
        z.object({
          title: z.string().trim().min(1).max(300),
          notes: z.string().trim().max(5000).optional(),
          due_at: isoDate.optional(),
          priority: z.enum(PRIORITIES).optional(),
          client_id: uuid.optional(),
        }),
        args,
      );
      const client =
        a.client_id && ctx.workspaceType === "business"
          ? await requireClient(ctx, a.client_id)
          : null;
      const payload = {
        title: a.title,
        ...(a.notes ? { notes: a.notes } : {}),
        ...(a.due_at ? { due_at: a.due_at } : {}),
        priority: a.priority ?? "normal",
        ...(client ? { company_id: client.id, company_name: client.name } : {}),
      };
      const proposal = await createProposal(ctx, "task", payload, `Create task: ${a.title}`);
      return {
        label: "Prepared a task for your confirmation",
        proposal,
        result: { status: "awaiting_user_confirmation", proposal_id: proposal.id },
      };
    },
  },
  {
    scope: "business",
    definition: {
      name: "propose_activity_note",
      description:
        "Propose logging something that already happened with a client (a note, call, email, WhatsApp or meeting). The user must confirm. This never sends a message or places a call.",
      parameters: {
        type: "object",
        properties: {
          client_id: { type: "string" },
          type: { type: "string", enum: [...ACTIVITY_TYPES] },
          direction: { type: "string", enum: ["inbound", "outbound", "internal"] },
          summary: { type: "string" },
        },
        required: ["client_id", "type", "summary"],
      },
    },
    async run(args, ctx) {
      const a = parse(
        z.object({
          client_id: uuid,
          type: z.enum(ACTIVITY_TYPES),
          direction: z.enum(["inbound", "outbound", "internal"]).optional(),
          summary: z.string().trim().min(1).max(5000),
        }),
        args,
      );
      const client = await requireClient(ctx, a.client_id);
      const payload = {
        type: a.type,
        direction: a.type === "note" ? "internal" : (a.direction ?? "outbound"),
        summary: a.summary,
        company_id: client.id,
        company_name: client.name,
      };
      const proposal = await createProposal(
        ctx,
        "activity_note",
        payload,
        `Log ${a.type} with ${client.name}`,
      );
      return {
        label: "Prepared a note for your confirmation",
        proposal,
        result: { status: "awaiting_user_confirmation", proposal_id: proposal.id },
      };
    },
  },
];

/** Tools offered in a workspace of this type. */
export function toolsFor(workspaceType: ToolContext["workspaceType"]) {
  return TOOLS.filter((t) => t.scope === "any" || workspaceType === "business");
}

/**
 * Run one tool call. Never throws for model mistakes: bad input or unknown
 * tools come back as `{ error }` so the model can correct itself.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const tool = toolsFor(ctx.workspaceType).find((t) => t.definition.name === name);
  if (!tool)
    return { label: "Unknown tool", result: { error: `No tool named ${name} is available here.` } };
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    if (err instanceof ToolInputError)
      return { label: "Tool input rejected", result: { error: err.message } };
    throw err;
  }
}

/** Serialise a tool result for the model, bounded in size. */
export function serialiseResult(result: unknown): string {
  const text = JSON.stringify(result);
  if (text.length <= TOOL_RESULT_CHARS) return text;
  return JSON.stringify({
    truncated: true,
    note: "Result too large; ask for fewer items or filter.",
    preview: text.slice(0, TOOL_RESULT_CHARS - 200),
  });
}
