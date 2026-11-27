/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary JSON responses */
/**
 * CRM end-to-end tests against a real Supabase stack: CRUD, validation, roles,
 * workspace isolation, CSV import de-duplication and report aggregates.
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage, ModelProvider } from "@jarvis/ai";
import { createModelRouter } from "@jarvis/ai";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
if (!PUBLISHABLE_KEY || !SECRET_KEY) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY are required.");
}

const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });
const env = loadEnv({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, NODE_ENV: "test" });
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];

/** Records the system prompt Jarvis was given. */
const seenPrompts: ChatMessage[][] = [];
const recorder: ModelProvider = {
  id: "recorder",
  async *streamChat(model, request) {
    seenPrompts.push(request.messages);
    yield { type: "start", provider: "recorder", model };
    yield { type: "text", delta: "Noted." };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 2 } };
  },
};

const app = createApp(env, {
  chat: {
    router: createModelRouter({
      providers: [recorder],
      routes: { chat: [{ provider: "recorder", model: "recorder-1" }] },
    }),
    dailyTokenLimit: 1_000_000,
    maxOutputTokens: 256,
    historyChars: 10_000,
    requestsPerMinute: 100,
  },
});

interface User {
  token: string;
  personal: string;
}

async function createUser(name: string): Promise<User & { email: string }> {
  const email = `${name}-${run}@example.com`;
  const password = `Pw-${randomUUID()}!aA1`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  userIds.push(data.user.id);
  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const session = await client.auth.signInWithPassword({ email, password });
  if (session.error) throw session.error;
  const token = session.data.session.access_token;
  const me = (await (
    await app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as {
    workspaces: { id: string; type: string }[];
  };
  return { token, email, personal: me.workspaces.find((w) => w.type === "personal")!.id };
}

async function call(user: User, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text && !text.startsWith("event:") ? (JSON.parse(text) as any) : text,
  };
}

let owner: User & { email: string };
let viewer: User & { email: string };
let outsider: User & { email: string };
let ws: string;

beforeAll(async () => {
  [owner, viewer, outsider] = await Promise.all([
    createUser("crm-owner"),
    createUser("crm-viewer"),
    createUser("crm-outsider"),
  ]);
  ws = (await call(owner, "POST", "/v1/workspaces", { name: "Libz CRM Test" })).body.workspace.id;
  const invite = await call(owner, "POST", `/v1/workspaces/${ws}/invitations`, {
    email: viewer.email,
    role: "viewer",
  });
  expect(invite.status).toBe(201);
  expect(
    (await call(viewer, "POST", "/v1/invitations/accept", { token: invite.body.token })).status,
  ).toBe(200);
});

afterAll(async () => {
  await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe("CRM CRUD", () => {
  let companyId: string;
  let contactId: string;
  let dealId: string;

  it("creates a company and normalises phone and email", async () => {
    const res = await call(owner, "POST", `/v1/workspaces/${ws}/companies`, {
      name: "  Moyo Hardware  ",
      phone: "0772 123 456",
      email: " Info@MoyoHardware.co.zw ",
      city: "Harare",
    });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      name: "Moyo Hardware",
      phone_e164: "+263772123456",
      email: "info@moyohardware.co.zw",
    });
    companyId = res.body.item.id;
  });

  it("rejects invalid input", async () => {
    for (const body of [
      { name: "" },
      { name: "X", phone: "abc" },
      { name: "X", email: "nope" },
      { name: "X", website: "javascript:alert(1)" },
      { name: "X", workspaceId: ws },
    ]) {
      expect((await call(owner, "POST", `/v1/workspaces/${ws}/companies`, body)).status).toBe(400);
    }
  });

  it("creates contacts, rejects duplicates and enforces consent evidence", async () => {
    const created = await call(owner, "POST", `/v1/workspaces/${ws}/contacts`, {
      companyId,
      fullName: "Tendai Moyo",
      phone: "+263 77 212 3456",
      email: "tendai@example.com",
    });
    expect(created.status).toBe(201);
    expect(created.body.item.marketing_consent).toBe("unknown");
    contactId = created.body.item.id;

    const dup = await call(owner, "POST", `/v1/workspaces/${ws}/contacts`, {
      fullName: "Someone Else",
      email: "TENDAI@example.com",
    });
    expect(dup.status).toBe(409);

    const noEvidence = await call(owner, "POST", `/v1/workspaces/${ws}/contacts`, {
      fullName: "Rudo",
      marketingConsent: "granted",
    });
    expect(noEvidence.status).toBe(400);
  });

  it("tracks deal stages and reports real aggregates", async () => {
    const deal = await call(owner, "POST", `/v1/workspaces/${ws}/deals`, {
      companyId,
      contactId,
      title: "Website + WhatsApp bot",
      value: 1200,
    });
    expect(deal.status).toBe(201);
    expect(deal.body.item).toMatchObject({
      stage: "lead",
      currency: "USD",
      companies: { name: "Moyo Hardware" },
    });
    dealId = deal.body.item.id;

    await call(owner, "POST", `/v1/workspaces/${ws}/deals`, {
      companyId,
      title: "Automation retainer",
      value: 300.5,
      stage: "proposal",
    });

    const won = await call(owner, "PATCH", `/v1/deals/${dealId}`, { stage: "won" });
    expect(won.status).toBe(200);
    expect(won.body.item.closed_at).toBeTruthy();

    const filtered = await call(owner, "GET", `/v1/workspaces/${ws}/deals?stage=proposal`);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.total).toBe(1);

    const summary = await call(owner, "GET", `/v1/workspaces/${ws}/reports/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.pipeline.open).toEqual({ USD: 300.5 });
    expect(summary.body.wonThisMonth).toEqual({ count: 1, value: { USD: 1200 } });
    expect(summary.body.counts).toMatchObject({ companies: 1, contacts: 1 });
  });

  it("lists tasks by view and searches with literal wildcards", async () => {
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await call(owner, "POST", `/v1/workspaces/${ws}/tasks`, {
      title: "Send 100% quote",
      dueAt: yesterday,
      dealId,
    });
    await call(owner, "POST", `/v1/workspaces/${ws}/tasks`, { title: "Plan kickoff" });

    const overdue = await call(owner, "GET", `/v1/workspaces/${ws}/tasks?view=overdue`);
    expect(overdue.body.items.map((t: any) => t.title)).toEqual(["Send 100% quote"]);
    const search = await call(
      owner,
      "GET",
      `/v1/workspaces/${ws}/tasks?q=${encodeURIComponent("0%")}`,
    );
    expect(search.body.items).toHaveLength(1);
    const wildcard = await call(
      owner,
      "GET",
      `/v1/workspaces/${ws}/tasks?q=${encodeURIComponent("%")}`,
    );
    expect(wildcard.body.items).toHaveLength(1);

    const summary = await call(owner, "GET", `/v1/workspaces/${ws}/reports/summary`);
    expect(summary.body.tasks).toMatchObject({ open: 2, overdue: 1 });
  });

  it("logs activities and paginates", async () => {
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await call(owner, "POST", `/v1/workspaces/${ws}/activities`, {
            type: "call",
            direction: "outbound",
            summary: `Call ${i}`,
            companyId,
          })
        ).status,
      ).toBe(201);
    }
    const page = await call(
      owner,
      "GET",
      `/v1/workspaces/${ws}/activities?limit=2&company_id=${companyId}`,
    );
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(3);
  });

  it("lets viewers read but not write", async () => {
    expect((await call(viewer, "GET", `/v1/companies/${companyId}`)).status).toBe(200);
    expect(
      (await call(viewer, "POST", `/v1/workspaces/${ws}/companies`, { name: "Nope" })).status,
    ).toBe(403);
    expect(
      (await call(viewer, "PATCH", `/v1/companies/${companyId}`, { name: "Hacked" })).status,
    ).toBe(404);
    expect((await call(viewer, "DELETE", `/v1/companies/${companyId}`)).status).toBe(404);
  });

  it("hides everything from outsiders", async () => {
    expect((await call(outsider, "GET", `/v1/companies/${companyId}`)).status).toBe(404);
    const list = await call(outsider, "GET", `/v1/workspaces/${ws}/contacts`);
    expect(list.body.items).toEqual([]);
    expect(
      (await call(outsider, "GET", `/v1/workspaces/${ws}/reports/summary`)).body.counts.contacts,
    ).toBe(0);
    expect(
      (await call(outsider, "POST", `/v1/workspaces/${ws}/companies`, { name: "X" })).status,
    ).toBe(403);
  });

  it("rejects references to another workspace", async () => {
    const otherWs = (await call(outsider, "POST", "/v1/workspaces", { name: "Other" })).body
      .workspace.id;
    const res = await call(outsider, "POST", `/v1/workspaces/${otherWs}/deals`, {
      companyId,
      title: "Steal",
    });
    expect(res.status).toBe(404);
  });

  it("keeps CRM out of personal workspaces but allows personal tasks", async () => {
    expect(
      (await call(owner, "POST", `/v1/workspaces/${owner.personal}/companies`, { name: "X" }))
        .status,
    ).toBe(400);
    expect(
      (await call(owner, "POST", `/v1/workspaces/${owner.personal}/tasks`, { title: "Gym" }))
        .status,
    ).toBe(201);
  });
});

describe("contact import", () => {
  const csv = [
    "Name,Company,Phone,Email,Role",
    "Chipo Ncube,Ncube Logistics,0712 345 678,chipo@ncube.co.zw,Director",
    '"Banda, Farai",ncube logistics,,farai@ncube.co.zw,',
    "Duplicate Chipo,,+263712345678,,",
    "Bad Phone,,12,,",
    ",No name,,,",
    "Tendai Again,,,tendai@example.com,",
  ].join("\n");

  it("previews without writing", async () => {
    const res = await call(owner, "POST", `/v1/workspaces/${ws}/import/contacts`, { csv });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: true,
      totalRows: 6,
      toCreate: 2,
      newCompanies: ["Ncube Logistics"],
    });
    expect(res.body.skipped.map((s: any) => s.reason)).toEqual([
      "duplicate (same email or phone)",
      "invalid phone number",
      "missing name",
      "duplicate (same email or phone)",
    ]);
    const contacts = await call(owner, "GET", `/v1/workspaces/${ws}/contacts?q=Chipo`);
    expect(contacts.body.items).toEqual([]);
  });

  it("imports, links companies and is idempotent", async () => {
    const res = await call(owner, "POST", `/v1/workspaces/${ws}/import/contacts`, {
      csv,
      dryRun: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ createdContacts: 2, createdCompanies: 1 });

    const chipo = (await call(owner, "GET", `/v1/workspaces/${ws}/contacts?q=Chipo`)).body.items[0];
    expect(chipo).toMatchObject({
      phone_e164: "+263712345678",
      marketing_consent: "unknown",
      role_title: "Director",
    });
    const farai = (await call(owner, "GET", `/v1/workspaces/${ws}/contacts?q=Farai`)).body.items[0];
    expect(farai.company_id).toBe(chipo.company_id);

    const again = await call(owner, "POST", `/v1/workspaces/${ws}/import/contacts`, {
      csv,
      dryRun: false,
    });
    expect(again.body).toMatchObject({ createdContacts: 0, createdCompanies: 0 });
  });

  it("refuses viewers and files without a name column", async () => {
    expect(
      (await call(viewer, "POST", `/v1/workspaces/${ws}/import/contacts`, { csv, dryRun: false }))
        .status,
    ).toBe(403);
    expect(
      (await call(owner, "POST", `/v1/workspaces/${ws}/import/contacts`, { csv: "email\na@b.co" }))
        .status,
    ).toBe(400);
  });
});
