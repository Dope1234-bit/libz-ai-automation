/**
 * End-to-end tests against a real Supabase stack (`pnpm db:start`).
 * Run with `pnpm --filter @jarvis/api test:integration`.
 *
 * Users are created through the Auth admin API with confirmed emails, sign in
 * with a password like a real client, and call the API with their own access
 * tokens — so JWT verification, PostgREST and row-level security are all real.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = requireEnv("SUPABASE_PUBLISHABLE_KEY");
const SECRET_KEY = requireEnv("SUPABASE_SECRET_KEY");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required for integration tests (see \`pnpm db:status\`).`);
  return value;
}

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = createApp(
  loadEnv({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, NODE_ENV: "test" }),
);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

const run = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];

async function createUser(name: string): Promise<TestUser> {
  const email = `${name}-${run}@example.com`;
  const password = `Pw-${randomUUID()}!aA1`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });
  if (error) throw error;
  createdUserIds.push(data.user.id);

  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const session = await client.auth.signInWithPassword({ email, password });
  if (session.error) throw session.error;
  return { id: data.user.id, email, token: session.data.session.access_token };
}

async function call(user: TestUser | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (user) headers.Authorization = `Bearer ${user.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads arbitrary JSON
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

let alice: TestUser;
let bob: TestUser;
let mallory: TestUser;
let acmeId: string;

beforeAll(async () => {
  [alice, bob, mallory] = await Promise.all([
    createUser("alice"),
    createUser("bob"),
    createUser("mallory"),
  ]);
});

afterAll(async () => {
  await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe("profile and personal workspace", () => {
  it("returns the signed-in user with their personal workspace", async () => {
    const res = await call(alice, "GET", "/v1/me");
    expect(res.status).toBe(200);
    expect(res.body?.user.id).toBe(alice.id);
    expect(res.body?.profile.displayName).toBe("alice");
    expect(res.body?.workspaces).toEqual([
      expect.objectContaining({ type: "personal", name: "Personal", role: "owner" }),
    ]);
  });

  it("updates the profile", async () => {
    const res = await call(alice, "PATCH", "/v1/me", { displayName: "Alice A." });
    expect(res.status).toBe(200);
    expect(res.body?.displayName).toBe("Alice A.");
  });

  it("rejects unauthenticated requests", async () => {
    expect((await call(null, "GET", "/v1/me")).status).toBe(401);
  });
});

describe("business workspace lifecycle", () => {
  it("creates a business workspace owned by the caller", async () => {
    const res = await call(alice, "POST", "/v1/workspaces", { name: "  Acme Ltd  " });
    expect(res.status).toBe(201);
    expect(res.body?.workspace).toMatchObject({
      type: "business",
      name: "Acme Ltd",
      owner_id: alice.id,
    });
    acmeId = res.body?.workspace.id;
  });

  it("hides the workspace from non-members", async () => {
    expect((await call(mallory, "GET", `/v1/workspaces/${acmeId}`)).status).toBe(404);
    expect((await call(mallory, "GET", `/v1/workspaces/${acmeId}/members`)).status).toBe(404);
    expect(
      (await call(mallory, "PATCH", `/v1/workspaces/${acmeId}`, { name: "Pwned" })).status,
    ).toBe(404);
    expect((await call(mallory, "DELETE", `/v1/workspaces/${acmeId}`)).status).toBe(404);
    const list = await call(mallory, "GET", "/v1/workspaces");
    expect(list.body?.workspaces.map((w: { id: string }) => w.id)).not.toContain(acmeId);
  });

  it("does not let non-members invite", async () => {
    const res = await call(mallory, "POST", `/v1/workspaces/${acmeId}/invitations`, {
      email: mallory.email,
      role: "admin",
    });
    expect(res.status).toBe(403);
  });

  it("invites and adds a member", async () => {
    const invite = await call(alice, "POST", `/v1/workspaces/${acmeId}/invitations`, {
      email: bob.email.toUpperCase(),
      role: "member",
    });
    expect(invite.status).toBe(201);
    expect(invite.body?.token).toMatch(/^[0-9a-f]{64}$/);

    // Mallory intercepts the token but it is bound to Bob's verified email.
    const stolen = await call(mallory, "POST", "/v1/invitations/accept", {
      token: invite.body?.token,
    });
    expect(stolen.status).toBe(404);

    const accepted = await call(bob, "POST", "/v1/invitations/accept", {
      token: invite.body?.token,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body?.workspaceId).toBe(acmeId);

    const members = await call(bob, "GET", `/v1/workspaces/${acmeId}/members`);
    expect(members.status).toBe(200);
    expect(members.body?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: alice.id, role: "owner", displayName: "Alice A." }),
        expect.objectContaining({ userId: bob.id, role: "member", displayName: "bob" }),
      ]),
    );
  });

  it("enforces member permissions", async () => {
    expect(
      (await call(bob, "PATCH", `/v1/workspaces/${acmeId}`, { name: "Bob's now" })).status,
    ).toBe(404);
    expect(
      (await call(bob, "GET", `/v1/workspaces/${acmeId}/invitations`)).body?.invitations,
    ).toEqual([]);
    expect(
      (await call(bob, "PATCH", `/v1/workspaces/${acmeId}/members/${bob.id}`, { role: "admin" }))
        .status,
    ).toBe(403);
    expect((await call(bob, "DELETE", `/v1/workspaces/${acmeId}/members/${alice.id}`)).status).toBe(
      404,
    );
  });

  it("lets the owner change roles and records an audit trail", async () => {
    const promoted = await call(alice, "PATCH", `/v1/workspaces/${acmeId}/members/${bob.id}`, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);

    const renamed = await call(bob, "PATCH", `/v1/workspaces/${acmeId}`, { name: "Acme Group" });
    expect(renamed.status).toBe(200);

    const audit = await call(alice, "GET", `/v1/workspaces/${acmeId}/audit-logs`);
    expect(audit.status).toBe(200);
    const actions = audit.body?.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "workspace.created",
        "invitation.created",
        "invitation.accepted",
        "member.role_changed",
        "workspace.updated",
      ]),
    );
    // Invitation tokens never appear in the audit trail.
    expect(JSON.stringify(audit.body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("lets a member leave and the owner delete the workspace", async () => {
    expect((await call(bob, "DELETE", `/v1/workspaces/${acmeId}/members/${bob.id}`)).status).toBe(
      204,
    );
    expect((await call(bob, "GET", `/v1/workspaces/${acmeId}`)).status).toBe(404);
    expect((await call(alice, "DELETE", `/v1/workspaces/${acmeId}`)).status).toBe(204);
    expect((await call(alice, "GET", `/v1/workspaces/${acmeId}`)).status).toBe(404);
  });

  it("never allows deleting a personal workspace", async () => {
    const me = await call(alice, "GET", "/v1/me");
    const personal = me.body?.workspaces.find((w: { type: string }) => w.type === "personal");
    expect((await call(alice, "DELETE", `/v1/workspaces/${personal.id}`)).status).toBe(404);
  });
});
