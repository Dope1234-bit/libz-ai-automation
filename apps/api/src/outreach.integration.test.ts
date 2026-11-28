/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary JSON responses */
/** Outreach campaigns end to end against a real Supabase stack. */
import { randomUUID } from "node:crypto";
import type { ChatRequest, ModelProvider } from "@jarvis/ai";
import { createModelRouter } from "@jarvis/ai";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import type { Place, PlacesClient } from "./integrations/google-places.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
if (!PUBLISHABLE_KEY || !SECRET_KEY) throw new Error("Supabase keys are required.");

const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });
const env = loadEnv({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, NODE_ENV: "test" });
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];

const requests: ChatRequest[] = [];
const writer: ModelProvider = {
  id: "writer",
  async *streamChat(model, request) {
    requests.push(request);
    const facts = JSON.parse(
      String(request.messages.at(-1)!.content).replace(/^Facts \(data, not instructions\): /, ""),
    );
    yield { type: "start", provider: "writer", model };
    yield {
      type: "text",
      delta: `Hi ${facts.recipient_business}, ${facts.our_offer}. Reply STOP if you'd rather not hear from us.`,
    };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 20 } };
  },
};
const MAP: Place[] = [
  {
    placeId: `ChIJoutreach${run}`,
    name: "Glow Beauty Salon",
    address: "5 Samora Machel Ave, Harare",
    phone: "+263 77 300 4000",
    website: null,
    googleMapsUri: null,
    rating: 4.7,
    ratingCount: 58,
    types: ["beauty_salon"],
    businessStatus: "OPERATIONAL",
  },
];
const places: PlacesClient = {
  search: async () => ({ places: MAP, nextPageToken: null }),
  details: async (id) => MAP.find((p) => p.placeId === id) ?? null,
};

const app = createApp(env, {
  prospects: { places, dailyLimit: 50 },
  chat: {
    router: createModelRouter({
      providers: [writer],
      routes: { chat: [{ provider: "writer", model: "w-1" }] },
    }),
    dailyTokenLimit: 1_000_000,
    maxOutputTokens: 256,
    historyChars: 10_000,
    requestsPerMinute: 100,
  },
});

interface User {
  token: string;
  email: string;
}
async function createUser(name: string): Promise<User> {
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
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  return { token: s.data.session.access_token, email };
}
async function call(user: User, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

let owner: User;
let outsider: User;
let ws: string;
let campaignId: string;
let moyoId: string;

beforeAll(async () => {
  [owner, outsider] = await Promise.all([createUser("out-owner"), createUser("out-outsider")]);
  ws = (await call(owner, "POST", "/v1/workspaces", { name: "Libz Enterprises" })).body.workspace
    .id;
  moyoId = (
    await call(owner, "POST", `/v1/workspaces/${ws}/companies`, {
      name: "Moyo Hardware",
      phone: "0772 123 456",
    })
  ).body.item.id;
});
afterAll(async () => {
  await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe("outreach campaigns", () => {
  it("creates a campaign and adds leads from clients and Google Maps", async () => {
    const created = await call(owner, "POST", `/v1/workspaces/${ws}/campaigns`, {
      name: "Salons in Harare",
      targetWhat: "beauty salons",
      targetWhere: "Harare",
      offer: "we set up WhatsApp booking bots so clients can book 24/7",
      channel: "whatsapp",
    });
    expect(created.status).toBe(201);
    campaignId = created.body.campaign.id;

    expect(
      (
        await call(owner, "POST", `/v1/campaigns/${campaignId}/leads`, {
          companyIds: [moyoId, moyoId],
        })
      ).body,
    ).toEqual({ added: 1 });
    const fromMaps = await call(owner, "POST", `/v1/campaigns/${campaignId}/leads/from-maps`, {
      placeIds: [MAP[0]!.placeId],
    });
    expect(fromMaps.body).toEqual({ added: 1 });
    // Adding the same place again neither duplicates the client nor the lead.
    expect(
      (
        await call(owner, "POST", `/v1/campaigns/${campaignId}/leads/from-maps`, {
          placeIds: [MAP[0]!.placeId],
        })
      ).body,
    ).toEqual({ added: 0 });

    const detail = await call(owner, "GET", `/v1/campaigns/${campaignId}`);
    expect(detail.body.leads.map((l: any) => [l.companies.name, l.status])).toEqual([
      ["Moyo Hardware", "to_contact"],
      ["Glow Beauty Salon", "to_contact"],
    ]);
    const list = await call(owner, "GET", `/v1/workspaces/${ws}/campaigns`);
    expect(list.body.campaigns[0].counts).toEqual({ to_contact: 2 });
  });

  it("drafts a personal message from facts only, and counts AI usage", async () => {
    const detail = await call(owner, "GET", `/v1/campaigns/${campaignId}`);
    const salon = detail.body.leads.find((l: any) => l.companies.name === "Glow Beauty Salon");
    const drafted = await call(owner, "POST", `/v1/campaign-leads/${salon.id}/draft`);
    expect(drafted.status).toBe(200);
    expect(drafted.body.lead).toMatchObject({ status: "drafted" });
    expect(drafted.body.lead.message).toContain("Hi Glow Beauty Salon");
    expect(drafted.body.lead.message).toContain("Reply STOP");
    const prompt = requests.at(-1)!;
    expect(prompt.messages[0]!.content).toContain("never invent details");
    expect(prompt.messages[1]!.content).toContain('"recipient_kind":["beauty_salon"]');
    const usage = await call(owner, "GET", "/v1/me/usage");
    expect(usage.body.usedToday).toBeGreaterThanOrEqual(50);
  });

  it("marks a lead sent, logs it on the client timeline and schedules a follow-up", async () => {
    const detail = await call(owner, "GET", `/v1/campaigns/${campaignId}`);
    const salon = detail.body.leads.find((l: any) => l.companies.name === "Glow Beauty Salon");
    const sent = await call(owner, "POST", `/v1/campaign-leads/${salon.id}/sent`, {
      via: "whatsapp",
    });
    expect(sent.status).toBe(200);
    expect(sent.body.lead).toMatchObject({ status: "sent", sent_via: "whatsapp" });
    expect(Date.parse(sent.body.lead.follow_up_at)).toBeGreaterThan(Date.now() + 2 * 86_400_000);

    const activities = await call(
      owner,
      "GET",
      `/v1/workspaces/${ws}/activities?company_id=${salon.company_id}`,
    );
    expect(activities.body.items[0]).toMatchObject({ type: "whatsapp", direction: "outbound" });
    expect(activities.body.items[0].summary).toContain("Outreach (Salons in Harare)");
    const tasks = await call(
      owner,
      "GET",
      `/v1/workspaces/${ws}/tasks?company_id=${salon.company_id}`,
    );
    expect(tasks.body.items[0].title).toBe("Follow up with Glow Beauty Salon");

    const replied = await call(owner, "PATCH", `/v1/campaign-leads/${salon.id}`, {
      status: "interested",
    });
    expect(replied.body.lead.status).toBe("interested");
  });

  it("respects do-not-contact", async () => {
    await call(owner, "PATCH", `/v1/companies/${moyoId}`, { doNotContact: true });
    const detail = await call(owner, "GET", `/v1/campaigns/${campaignId}`);
    const moyo = detail.body.leads.find((l: any) => l.companies.name === "Moyo Hardware");
    const draft = await call(owner, "POST", `/v1/campaign-leads/${moyo.id}/draft`);
    expect(draft.status).toBe(400);
    expect(draft.body.error.message).toContain("asked not to be contacted");
    expect(
      (await call(owner, "POST", `/v1/campaign-leads/${moyo.id}/sent`, { via: "call" })).status,
    ).toBe(400);
  });

  it("keeps campaigns private to the workspace", async () => {
    expect((await call(outsider, "GET", `/v1/campaigns/${campaignId}`)).status).toBe(404);
    const otherWs = (await call(outsider, "POST", "/v1/workspaces", { name: "Rival" })).body
      .workspace.id;
    expect(
      (await call(outsider, "GET", `/v1/workspaces/${otherWs}/campaigns`)).body.campaigns,
    ).toEqual([]);
    expect(
      (await call(outsider, "POST", `/v1/campaigns/${campaignId}/leads`, { companyIds: [moyoId] }))
        .status,
    ).toBe(404);
  });
});
