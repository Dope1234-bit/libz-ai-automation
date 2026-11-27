import { AppError, ErrorCode } from "@jarvis/shared";
import type { Context } from "hono";
import { z } from "zod";

/** Parse and validate a JSON body; any failure is a 400 with field-level reasons. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(ErrorCode.BadRequest, "Request body must be valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new AppError(ErrorCode.BadRequest, `Invalid request: ${detail}`);
  }
  return result.data;
}

const uuid = z.uuid();

/** Read a path parameter that must be a UUID. Malformed IDs are treated as not found. */
export function uuidParam(c: Context, name: string): string {
  const result = uuid.safeParse(c.req.param(name));
  if (!result.success) {
    throw new AppError(ErrorCode.NotFound, "Not found.");
  }
  return result.data;
}

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(100, "must be at most 100 characters");

export const assignableRoleSchema = z.enum(["admin", "member", "viewer"]);
