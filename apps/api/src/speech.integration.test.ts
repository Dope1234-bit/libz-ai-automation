/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary JSON responses */
/** Sir Libz's voice endpoint against a real Supabase stack, with a stand-in ElevenLabs. */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
if (!PUBLISHABLE_KEY || !SECRET_KEY) throw new Error("Supabase keys are required.");

const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });
const env = loadEnv({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, NODE_ENV: "test" });
let userId = "";
let token = "";

const calls: { url: string; init: RequestInit }[] = [];
let upstreamStatus = 200;
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), init: init! });
  return upstreamStatus === 200
    ? new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      })
    : new Response("nope", { status: upstreamStatus });
}) as typeof fetch;

const voiced = createApp(env, {
  speech: {
    apiKey: "el-test-key-123",
    voiceId: "DT7zBOa8kCzTWHNN60AC",
    modelId: "eleven_flash_v2_5",
    dailyChars: 40,
    fetch: fakeFetch,
  },
});
const silent = createApp(env, {
  speech: {
    apiKey: null,
    voiceId: "DT7zBOa8kCzTWHNN60AC",
    modelId: "eleven_flash_v2_5",
    dailyChars: 40,
  },
});

const req = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  const email = `voice-${randomUUID().slice(0, 8)}@example.com`;
  const password = `Pw-${randomUUID()}!aA1`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user.id;
  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  token = s.data.session.access_token;
});
afterAll(async () => {
  await admin.auth.admin.deleteUser(userId);
});

describe("Sir Libz's voice", () => {
  it("reports whether the voice is connected", async () => {
    expect(await (await req(voiced, "GET", "/v1/speech/status")).json()).toEqual({
      configured: true,
    });
    expect(await (await req(silent, "GET", "/v1/speech/status")).json()).toEqual({
      configured: false,
    });
    expect((await req(silent, "POST", "/v1/speech", { text: "Hello" })).status).toBe(503);
  });

  it("streams audio from ElevenLabs with the server-side key and chosen voice", async () => {
    const res = await req(voiced, "POST", "/v1/speech", { text: "Good morning, sir." });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([0x49, 0x44, 0x33]),
    );
    const call = calls.at(-1)!;
    expect(call.url).toContain("/v1/text-to-speech/DT7zBOa8kCzTWHNN60AC/stream");
    expect((call.init.headers as Record<string, string>)["xi-api-key"]).toBe("el-test-key-123");
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      text: "Good morning, sir.",
      model_id: "eleven_flash_v2_5",
    });
  });

  it("validates input and enforces the daily character allowance", async () => {
    expect((await req(voiced, "POST", "/v1/speech", { text: "" })).status).toBe(400);
    // 18 characters used above; 40 allowed per day.
    expect((await req(voiced, "POST", "/v1/speech", { text: "x".repeat(20) })).status).toBe(200);
    const over = await req(voiced, "POST", "/v1/speech", { text: "This one is too long" });
    expect(over.status).toBe(429);
    expect(((await over.json()) as any).error.message).toContain("voice allowance");
  });

  it("explains upstream failures without leaking details", async () => {
    upstreamStatus = 401;
    try {
      const fresh = createApp(env, {
        speech: {
          apiKey: "el-bad",
          voiceId: "DT7zBOa8kCzTWHNN60AC",
          modelId: "eleven_flash_v2_5",
          dailyChars: 1000,
          fetch: fakeFetch,
        },
      });
      const res = await req(fresh, "POST", "/v1/speech", { text: "Hi" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.message).toContain("rejected the API key");
    } finally {
      upstreamStatus = 200;
    }
  });
});
