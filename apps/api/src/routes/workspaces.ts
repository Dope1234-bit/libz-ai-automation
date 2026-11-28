import { AppError, ErrorCode } from "@jarvis/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { unwrap, unwrapMaybe } from "../db.js";
import { assignableRoleSchema, parseBody, uuidParam, workspaceNameSchema } from "../validation.js";

const WORKSPACE_COLUMNS = "id, type, name, owner_id, created_at, updated_at";

const notFound = () => new AppError(ErrorCode.NotFound, "Workspace not found.");

export const workspaceRoutes = new Hono<AppEnv>()
  // ---------------------------------------------------------------- workspaces
  .get("/", async (c) => {
    const rows = await c
      .get("db")
      .from("workspaces")
      .select(WORKSPACE_COLUMNS)
      .order("created_at")
      .then(unwrap);
    return c.json({ workspaces: rows });
  })
  .post("/", async (c) => {
    const { name } = await parseBody(c, z.object({ name: workspaceNameSchema }).strict());
    const workspace = await c
      .get("db")
      .rpc("create_business_workspace", { p_name: name })
      .single()
      .then(unwrap);
    return c.json({ workspace }, 201);
  })
  .get("/:workspaceId", async (c) => {
    const id = uuidParam(c, "workspaceId");
    const workspace = await c
      .get("db")
      .from("workspaces")
      .select(WORKSPACE_COLUMNS)
      .eq("id", id)
      .maybeSingle()
      .then(unwrapMaybe);
    if (!workspace) throw notFound();
    return c.json({ workspace });
  })
  .patch("/:workspaceId", async (c) => {
    const id = uuidParam(c, "workspaceId");
    const { name } = await parseBody(c, z.object({ name: workspaceNameSchema }).strict());
    // RLS limits updates to admins; zero rows means "not found or not allowed".
    const rows = await c
      .get("db")
      .from("workspaces")
      .update({ name })
      .eq("id", id)
      .select(WORKSPACE_COLUMNS)
      .then(unwrap);
    if (rows.length === 0) throw notFound();
    return c.json({ workspace: rows[0] });
  })
  .delete("/:workspaceId", async (c) => {
    const id = uuidParam(c, "workspaceId");
    const rows = await c
      .get("db")
      .from("workspaces")
      .delete()
      .eq("id", id)
      .select("id")
      .then(unwrap);
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  })

  // ------------------------------------------------------------------- members
  .get("/:workspaceId/members", async (c) => {
    const id = uuidParam(c, "workspaceId");
    const db = c.get("db");
    const members = await db
      .from("workspace_members")
      .select("user_id, role, created_at")
      .eq("workspace_id", id)
      .order("created_at")
      .then(unwrap);
    if (members.length === 0) throw notFound();

    const profiles = await db
      .from("profiles")
      .select("id, display_name, avatar_url")
      .in(
        "id",
        members.map((m) => m.user_id),
      )
      .then(unwrap);
    const byId = new Map(profiles.map((p) => [p.id, p]));

    return c.json({
      members: members.map((m) => ({
        userId: m.user_id,
        role: m.role,
        joinedAt: m.created_at,
        displayName: byId.get(m.user_id)?.display_name ?? null,
        avatarUrl: byId.get(m.user_id)?.avatar_url ?? null,
      })),
    });
  })
  .patch("/:workspaceId/members/:userId", async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const userId = uuidParam(c, "userId");
    const { role } = await parseBody(c, z.object({ role: assignableRoleSchema }).strict());
    await c
      .get("db")
      .rpc("set_workspace_member_role", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_role: role,
      })
      .then(unwrapMaybe);
    return c.json({ userId, role });
  })
  .delete("/:workspaceId/members/:userId", async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const userId = uuidParam(c, "userId");
    const rows = await c
      .get("db")
      .from("workspace_members")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .select("user_id")
      .then(unwrap);
    if (rows.length === 0) {
      throw new AppError(ErrorCode.NotFound, "Member not found or cannot be removed.");
    }
    return c.body(null, 204);
  })

  // --------------------------------------------------------------- invitations
  .get("/:workspaceId/invitations", async (c) => {
    const id = uuidParam(c, "workspaceId");
    const rows = await c
      .get("db")
      .from("workspace_invitations")
      .select("id, email, role, expires_at, accepted_at, revoked_at, created_at")
      .eq("workspace_id", id)
      .order("created_at", { ascending: false })
      .then(unwrap);
    return c.json({ invitations: rows });
  })
  .post("/:workspaceId/invitations", async (c) => {
    const id = uuidParam(c, "workspaceId");
    const { email, role } = await parseBody(
      c,
      z.object({ email: z.email().max(320), role: assignableRoleSchema }).strict(),
    );
    const invitation = await c
      .get("db")
      .rpc("create_workspace_invitation", { p_workspace_id: id, p_email: email, p_role: role })
      .single<{ invitation_id: string; token: string; expires_at: string }>()
      .then(unwrap);
    // The raw token is only ever returned here, once, to the inviting admin.
    c.header("Cache-Control", "no-store");
    return c.json(
      { id: invitation.invitation_id, token: invitation.token, expiresAt: invitation.expires_at },
      201,
    );
  })
  .delete("/:workspaceId/invitations/:invitationId", async (c) => {
    uuidParam(c, "workspaceId");
    const invitationId = uuidParam(c, "invitationId");
    await c
      .get("db")
      .rpc("revoke_workspace_invitation", { p_invitation_id: invitationId })
      .then(unwrapMaybe);
    return c.body(null, 204);
  })

  // ----------------------------------------------------------------- audit log
  .get("/:workspaceId/audit-logs", async (c) => {
    const id = uuidParam(c, "workspaceId");
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(c.req.query("limit"));
    const rows = await c
      .get("db")
      .from("audit_logs")
      .select("id, actor_id, action, target_type, target_id, metadata, created_at")
      .eq("workspace_id", id)
      .order("created_at", { ascending: false })
      .limit(limit)
      .then(unwrap);
    return c.json({ events: rows });
  });

export const invitationRoutes = new Hono<AppEnv>().post("/accept", async (c) => {
  const { token } = await parseBody(
    c,
    z.object({ token: z.string().regex(/^[0-9a-f]{64}$/, "invalid token") }).strict(),
  );
  const workspaceId = await c
    .get("db")
    .rpc("accept_workspace_invitation", { p_token: token })
    .then(unwrap);
  return c.json({ workspaceId });
});
