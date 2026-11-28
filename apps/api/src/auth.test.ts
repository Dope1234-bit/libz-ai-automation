import { AppError } from "@jarvis/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CryptoKey, JWTPayload } from "jose";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createSupabaseTokenVerifier } from "./auth.js";
import { loadEnv } from "./env.js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const USER_ID = "11111111-1111-4111-8111-111111111111";

let signingKey: CryptoKey;
let verify: ReturnType<typeof createSupabaseTokenVerifier>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256" };
  verify = createSupabaseTokenVerifier(SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
});

function sign(claims: JWTPayload = {}, key: CryptoKey | Uint8Array = signingKey, alg = "ES256") {
  const now = Math.floor(Date.now() / 1000);
  // Claims are set in one object (not via builder methods) so tests can override any of them.
  return new SignJWT({
    iss: ISSUER,
    aud: "authenticated",
    sub: USER_ID,
    iat: now,
    exp: now + 300,
    role: "authenticated",
    email: "alice@example.com",
    aal: "aal1",
    ...claims,
  })
    .setProtectedHeader({ alg, kid: "test-key" })
    .sign(key);
}

describe("createSupabaseTokenVerifier", () => {
  it("accepts a valid Supabase access token", async () => {
    const user = await verify(await sign());
    expect(user).toEqual({ id: USER_ID, email: "alice@example.com", aal: "aal1", sessionId: null });
  });

  it("reports MFA-verified sessions", async () => {
    expect((await verify(await sign({ aal: "aal2" }))).aal).toBe("aal2");
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["wrong issuer", { iss: "https://evil.example/auth/v1" }],
    ["wrong audience", { aud: "anon" }],
    ["non-user role", { role: "service_role" }],
  ])("rejects a token with %s", async (_label, claims) => {
    await expect(verify(await sign(claims))).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a token signed by an unknown key", async () => {
    const other = await generateKeyPair("ES256");
    await expect(verify(await sign({}, other.privateKey))).rejects.toBeInstanceOf(AppError);
  });

  it("never verifies HS256 tokens locally (no shared secret, no algorithm confusion)", async () => {
    const secret = new TextEncoder().encode(
      "super-secret-jwt-token-with-at-least-32-characters-long",
    );
    await expect(verify(await sign({}, secret, "HS256"))).rejects.toBeInstanceOf(AppError);
  });

  it("validates legacy HS256 tokens with Supabase Auth when enabled", async () => {
    const secret = new TextEncoder().encode("legacy-project-secret-with-32-characters!!");
    const token = await sign({}, secret, "HS256");
    const calls: string[] = [];
    const legacy = createSupabaseTokenVerifier(SUPABASE_URL, createLocalJWKSet({ keys: [] }), {
      publishableKey: "pk",
      fetch: async (url, init) => {
        calls.push(String(url));
        const auth = new Headers(init?.headers).get("authorization");
        return auth === `Bearer ${token}`
          ? Response.json({ id: USER_ID })
          : new Response("{}", { status: 401 });
      },
    });
    expect((await legacy(token)).id).toBe(USER_ID);
    expect(calls).toEqual([`${ISSUER}/user`]);

    // A forged token is rejected by Supabase Auth.
    const forged = await sign(
      { sub: "22222222-2222-4222-8222-222222222222" },
      new TextEncoder().encode("x".repeat(32)),
      "HS256",
    );
    await expect(legacy(forged)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects HS256 tokens whose subject does not match the validated user", async () => {
    const token = await sign({}, new TextEncoder().encode("y".repeat(32)), "HS256");
    const legacy = createSupabaseTokenVerifier(SUPABASE_URL, createLocalJWKSet({ keys: [] }), {
      publishableKey: "pk",
      fetch: async () => Response.json({ id: "someone-else" }),
    });
    await expect(legacy(token)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects garbage", async () => {
    await expect(verify("not.a.jwt")).rejects.toBeInstanceOf(AppError);
  });
});

describe("authenticated routes", () => {
  const env = loadEnv({
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_000000",
  });

  function appWithStubDb() {
    return createApp(env, {
      verifyToken: (token) => verify(token),
      // No route should reach the database in these tests.
      createUserDb: () => {
        throw new Error("database must not be reached");
      },
    });
  }

  it("requires a bearer token", async () => {
    const res = await appWithStubDb().request("/v1/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthenticated");
  });

  it("rejects malformed authorization headers", async () => {
    const res = await appWithStubDb().request("/v1/me", {
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid tokens before touching the database", async () => {
    const other = await generateKeyPair("ES256");
    const res = await appWithStubDb().request("/v1/me", {
      headers: { Authorization: `Bearer ${await sign({}, other.privateKey)}` },
    });
    expect(res.status).toBe(401);
  });

  it("treats malformed IDs as not found", async () => {
    const app = createApp(env, {
      verifyToken: (token) => verify(token),
      createUserDb: () => ({}) as SupabaseClient,
    });
    const res = await app.request("/v1/workspaces/not-a-uuid", {
      headers: { Authorization: `Bearer ${await sign()}` },
    });
    expect(res.status).toBe(404);
  });

  it("validates request bodies", async () => {
    const app = createApp(env, {
      verifyToken: (token) => verify(token),
      createUserDb: () => ({}) as SupabaseClient,
    });
    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { Authorization: `Bearer ${await sign()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", extra: true }),
    });
    expect(res.status).toBe(400);
  });
});
