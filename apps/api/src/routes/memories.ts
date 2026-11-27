import { AppError, ErrorCode } from "@jarvis/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { unwrap } from "../db.js";
import { parseBody, uuidParam } from "../validation.js";

export const MEMORY_CATEGORIES = [
  "general",
  "preference",
  "fact",
  "goal",
  "person",
  "project",
] as const;

const COLUMNS =
  "id, workspace_id, content, category, pinned, source, source_message_id, created_at, updated_at";

const contentSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(1000, "must be at most 1000 characters");

const createSchema = z
  .object({
    content: contentSchema,
    category: z.enum(MEMORY_CATEGORIES).default("general"),
    pinned: z.boolean().default(false),
    sourceMessageId: z.uuid().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    content: contentSchema.optional(),
    category: z.enum(MEMORY_CATEGORIES).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "at least one field is required");

const notFound = () => new AppError(ErrorCode.NotFound, "Memory not found.");

/**
 * Memories: notes a user saves for Jarvis, private to them and scoped to one
 * workspace. Row-level security enforces ownership and membership.
 */
export const memoryRoutes = new Hono<AppEnv>()
  .get("/workspaces/:workspaceId/memories", async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const rows = await c
      .get("db")
      .from("memories")
      .select(COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(500)
      .then(unwrap);
    return c.json({ memories: rows });
  })
  .post("/workspaces/:workspaceId/memories", async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const body = await parseBody(c, createSchema);
    const memory = await c
      .get("db")
      .from("memories")
      .insert({
        workspace_id: workspaceId,
        content: body.content,
        category: body.category,
        pinned: body.pinned,
        source: body.sourceMessageId ? "message" : "manual",
        source_message_id: body.sourceMessageId ?? null,
      })
      .select(COLUMNS)
      .single()
      .then(unwrap);
    return c.json({ memory }, 201);
  })
  .patch("/memories/:memoryId", async (c) => {
    const id = uuidParam(c, "memoryId");
    const body = await parseBody(c, updateSchema);
    const rows = await c
      .get("db")
      .from("memories")
      .update(body)
      .eq("id", id)
      .select(COLUMNS)
      .then(unwrap);
    if (rows.length === 0) throw notFound();
    return c.json({ memory: rows[0] });
  })
  .delete("/memories/:memoryId", async (c) => {
    const id = uuidParam(c, "memoryId");
    const rows = await c.get("db").from("memories").delete().eq("id", id).select("id").then(unwrap);
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  });
