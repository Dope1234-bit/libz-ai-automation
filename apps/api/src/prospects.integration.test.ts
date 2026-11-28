/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary JSON responses */
/** Google Maps prospecting against a real Supabase stack, with a stand-in Places client. */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import type { Place, PlacesClient } from "./integrations/google-places.js";
import { PlacesError } from "./integrations/google-places.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
if (!PUBLISHABLE_KEY || !SECRET_KEY) throw new Error("Supabase keys are required.");

const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });
const env = loadEnv({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, NODE_ENV: "test" });
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];

const place = (id: string, name: string, phone: string | null): Place => ({
  placeId: id,
  name,
  address: `${name} St, Harare, Zimbabwe`,
  phone,
  website: "https://example.com",
  googleMapsUri: `https://maps.google.com/?q=${id}`,
  rating: 4.5,
  ratingCount: 12,
  types: ["store"],
  businessStatus: "OPERATIONAL",
});
const CATALOGUE = [
  place(`ChIJmoyo${run}`, "Moyo Hardware", "077 212 3456"),
  place(`ChIJncube${run}`, "Ncube Logistics", "+263 71 234 5678"),
];
const queries: string[] = [];
let failWith: PlacesError | null = null;
const fakePlaces: PlacesClient = {
  async search(query) {
    queries.push(query);
    if (failWith) throw failWith;
    return { places: CATALOGUE, nextPageToken: null };
  },
  async details(id) {
    return CATALOGUE.find((p) => p.placeId === id) ?? null;
  },
};

const app = createApp(env, { prospects: { places: fakePlaces, dailyLimit: 6 } });
const offline = createApp(env, { prospects: { places: null, dailyLimit: 6 } });

interface User {
  token: string;
  email: string;
  personal: string;
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
  const me = (await (
    await app.request("/v1/me", {
      headers: { Authorization: `Bearer ${s.data.session.access_token}` },
    })
  ).json()) as any;
  return {
    token: s.data.session.access_token,
    email,
    personal: me.workspaces.find((w: any) => w.type === "personal").id,
  };
}
async function call(user: User, method: string, path: string, body?: unknown, target = app) {
  const res = await target.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

let owner: User;
let viewer: User;
let ws: string;
beforeAll(async () => {
  [owner, viewer] = await Promise.all([createUser("maps-owner"), createUser("maps-viewer")]);
  ws = (await call(owner, "POST", "/v1/workspaces", { name: "Libz Maps" })).body.workspace.id;
  const invite = await call(owner, "POST", `/v1/workspaces/${ws}/invitations`, {
    email: viewer.email,
    role: "viewer",
  });
  await call(viewer, "POST", "/v1/invitations/accept", { token: invite.body.token });
  // An existing client with the same phone as Ncube Logistics.
  await call(owner, "POST", `/v1/workspaces/${ws}/companies`, {
    name: "Ncube Ltd",
    phone: "0712 345 678",
  });
});
afterAll(async () => {
  await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe("Google Maps prospects", () => {
  it("reports when Google Maps is not connected", async () => {
    expect(
      (await call(owner, "GET", `/v1/workspaces/${ws}/prospects/status`, undefined, offline)).body,
    ).toEqual({
      configured: false,
      dailyLimit: 6,
    });
    const res = await call(
      owner,
      "POST",
      `/v1/workspaces/${ws}/prospects/search`,
      { what: "hardware" },
      offline,
    );
    expect(res.status).toBe(503);
  });

  it("searches and flags businesses that are already clients", async () => {
    const res = await call(owner, "POST", `/v1/workspaces/${ws}/prospects/search`, {
      what: "hardware store",
      where: "Harare",
    });
    expect(res.status).toBe(200);
    expect(queries.at(-1)).toBe("hardware store in Harare");
    expect(res.body.results.map((r: any) => [r.name, r.phoneE164, !!r.existingClientId])).toEqual([
      ["Moyo Hardware", "+263772123456", false],
      ["Ncube Logistics", "+263712345678", true],
    ]);
  });

  it("adds a place as a client and lead, once", async () => {
    const added = await call(owner, "POST", `/v1/workspaces/${ws}/prospects/add`, {
      placeId: CATALOGUE[0]!.placeId,
      createDeal: true,
    });
    expect(added.status).toBe(201);
    const company = (await call(owner, "GET", `/v1/companies/${added.body.company.id}`)).body.item;
    expect(company).toMatchObject({
      name: "Moyo Hardware",
      phone_e164: "+263772123456",
      source: "google_maps",
      attributes: { google_place_id: CATALOGUE[0]!.placeId },
    });
    const deal = (await call(owner, "GET", `/v1/deals/${added.body.dealId}`)).body.item;
    expect(deal).toMatchObject({ stage: "lead", title: "New lead: Moyo Hardware" });

    expect(
      (
        await call(owner, "POST", `/v1/workspaces/${ws}/prospects/add`, {
          placeId: CATALOGUE[0]!.placeId,
        })
      ).status,
    ).toBe(409);
    const again = await call(owner, "POST", `/v1/workspaces/${ws}/prospects/search`, {
      what: "hardware",
    });
    expect(again.body.results[0].existingClientId).toBe(added.body.company.id);
  });

  it("validates input and permissions", async () => {
    expect(
      (await call(owner, "POST", `/v1/workspaces/${ws}/prospects/add`, { placeId: "bad id!" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(owner, "POST", `/v1/workspaces/${ws}/prospects/add`, {
          placeId: "ChIJunknownxxx",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(viewer, "POST", `/v1/workspaces/${ws}/prospects/search`, { what: "hardware" }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(owner, "POST", `/v1/workspaces/${owner.personal}/prospects/search`, {
          what: "hardware",
        })
      ).status,
    ).toBe(400);
  });

  it("turns Google errors into a clear message", async () => {
    failWith = new PlacesError("Google Maps returned HTTP 403", 403);
    try {
      const res = await call(owner, "POST", `/v1/workspaces/${ws}/prospects/search`, {
        what: "hardware",
      });
      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain("rejected the API key");
    } finally {
      failWith = null;
    }
  });

  it("enforces the daily Google Maps limit", async () => {
    // 6 allowed per day; earlier tests used 6 (3 searches, 2 adds that reached Google, 1 failed search).
    const res = await call(owner, "POST", `/v1/workspaces/${ws}/prospects/search`, {
      what: "hardware",
    });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain("Daily Google Maps limit");
  });
});
