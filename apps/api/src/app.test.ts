import { EnvValidationError } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv({
  NODE_ENV: "test",
  WEB_ORIGINS: "http://localhost:3000",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_000000",
});
const app = createApp(env);

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("sets security headers and a request id", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("CORS", () => {
  it("allows configured origins", async () => {
    const res = await app.request("/health", { headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("rejects unknown origins", async () => {
    const res = await app.request("/health", { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("errors", () => {
  it("returns a structured 404", async () => {
    const res = await app.request("/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBeTruthy();
  });

  it("rejects oversized bodies", async () => {
    const res = await app.request("/health", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
      headers: { "Content-Type": "text/plain" },
    });
    expect(res.status).toBe(400);
  });
});

describe("loadEnv", () => {
  it("rejects invalid origins", () => {
    expect(() =>
      loadEnv({
        WEB_ORIGINS: "not a url",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_000000",
      }),
    ).toThrow(EnvValidationError);
  });

  it("requires Supabase configuration", () => {
    expect(() => loadEnv({})).toThrow(/SUPABASE_URL/);
  });
});

describe("AI configuration", () => {
  it("keeps the API up and disables chat when a provider key is missing", async () => {
    const previous = process.env.AI_PROVIDERS;
    process.env.AI_PROVIDERS = "groq"; // no GROQ_API_KEY set
    try {
      const degraded = createApp(env);
      expect((await degraded.request("/health")).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDERS;
      else process.env.AI_PROVIDERS = previous;
    }
  });
});
