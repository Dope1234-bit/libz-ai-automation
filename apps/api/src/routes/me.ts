import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { unwrap, unwrapMaybe } from "../db.js";
import { parseBody } from "../validation.js";

const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).nullable().optional(),
    avatarUrl: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "at least one field is required");

export const meRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = c.get("db");
    const user = c.get("user");

    const [profile, memberships] = await Promise.all([
      db
        .from("profiles")
        .select("display_name, avatar_url")
        .eq("id", user.id)
        .maybeSingle()
        .then(unwrapMaybe),
      db
        .from("workspace_members")
        .select("role, workspaces (id, type, name)")
        .eq("user_id", user.id)
        .then(unwrap),
    ]);

    return c.json({
      user: { id: user.id, email: user.email, mfa: user.aal === "aal2" },
      profile: {
        displayName: profile?.display_name ?? null,
        avatarUrl: profile?.avatar_url ?? null,
      },
      workspaces: (memberships as unknown as MembershipRow[])
        .flatMap((m) => (m.workspaces ? [{ ...m.workspaces, role: m.role }] : []))
        .sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === "personal" ? -1 : 1,
        ),
    });
  })
  .patch("/", async (c) => {
    const body = await parseBody(c, updateProfileSchema);
    const patch: Record<string, string | null> = {};
    if (body.displayName !== undefined) patch.display_name = body.displayName;
    if (body.avatarUrl !== undefined) patch.avatar_url = body.avatarUrl;

    const profile = await c
      .get("db")
      .from("profiles")
      .update(patch)
      .eq("id", c.get("user").id)
      .select("display_name, avatar_url")
      .single()
      .then(unwrap);

    return c.json({ displayName: profile.display_name, avatarUrl: profile.avatar_url });
  });

interface MembershipRow {
  role: string;
  workspaces: { id: string; type: "personal" | "business"; name: string } | null;
}
