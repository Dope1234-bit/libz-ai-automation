/**
 * End-to-end chat tests against a real Supabase stack (`pnpm db:start`).
 * The model provider is a stand-in so tests are deterministic and free; the
 * router, API, database functions and row-level security are all real.
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage, ModelProvider, StreamEvent } from "@jarvis/ai";
import { createModelRouter, ProviderError } from "@jarvis/ai";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import type { ChatSettings } from "./routes/conversations.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
if (!PUBLISHABLE_KEY || !SECRET_KEY) {
  throw new Error(
    "SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY are required (see `pnpm db:status`).",
  );
}

const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });
const env = loadEnv({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, NODE_ENV: "test" });
const run = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];

interface TestUser {
  id: string;
  token: string;
  personalWorkspaceId: string;
}

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
  const token = session.data.session.access_token;
  // Look the personal workspace up as the user (the admin key has no table grants by design).
  const me = await createApp(env, { chat: chatSettings([]) }).request("/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const workspaces = ((await me.json()) as { workspaces: { id: string; type: string }[] })
    .workspaces;
  const personal = workspaces.find((w) => w.type === "personal");
  if (!personal) throw new Error("personal workspace missing");
  return { id: data.user.id, token, personalWorkspaceId: personal.id };
}

/** A scripted model: records what it was sent and streams a fixed reply. */
function scriptedProvider(
  id: string,
  reply: string | Error,
  usage = { inputTokens: 40, outputTokens: 10 },
) {
  const received: ChatMessage[][] = [];
  const provider: ModelProvider = {
    id,
    async *streamChat(model, request): AsyncGenerator<StreamEvent> {
      received.push(request.messages);
      if (reply instanceof Error) throw reply;
      yield { type: "start", provider: id, model };
      for (const word of reply.split(/(?<= )/)) yield { type: "text", delta: word };
      yield { type: "finish", finishReason: "stop", usage };
    },
  };
  return { provider, received };
}

function chatSettings(
  providers: ModelProvider[],
  overrides: Partial<ChatSettings> = {},
): ChatSettings {
  return {
    router: createModelRouter({
      providers,
      routes: { chat: providers.map((p) => ({ provider: p.id, model: `${p.id}-model` })) },
    }),
    dailyTokenLimit: 1_000_000,
    maxOutputTokens: 256,
    historyChars: 10_000,
    requestsPerMinute: 100,
    ...overrides,
  };
}

async function call(
  app: ReturnType<typeof createApp>,
  user: TestUser,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

/** Parse an SSE response body into [{event, data}]. */
async function sseEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function startConversation(app: ReturnType<typeof createApp>, user: TestUser) {
  const res = await call(
    app,
    user,
    "POST",
    `/v1/workspaces/${user.personalWorkspaceId}/conversations`,
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { conversation: { id: string } }).conversation.id;
}

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  [alice, bob] = await Promise.all([createUser("alice"), createUser("bob")]);
});

afterAll(async () => {
  await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe("streaming chat", () => {
  it("streams a reply, stores both messages and records usage", async () => {
    const model = scriptedProvider("primary", "Hello Alice, how can I help?");
    const app = createApp(env, { chat: chatSettings([model.provider]) });
    const conversationId = await startConversation(app, alice);

    const res = await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
      content: "Hi Jarvis",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await sseEvents(res);
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["start", "model", "delta", "done"]),
    );
    const streamed = events
      .filter((e) => e.event === "delta")
      .map((e) => e.data.text)
      .join("");
    expect(streamed).toBe("Hello Alice, how can I help?");
    expect(events.at(-1)).toMatchObject({
      event: "done",
      data: { status: "complete", usage: { inputTokens: 40, outputTokens: 10, estimated: false } },
    });

    // The model received Jarvis's system prompt with the user's name, then the message.
    const sent = model.received[0]!;
    expect(sent[0]?.role).toBe("system");
    expect(sent[0]?.content).toContain('"alice"');
    expect(sent.at(-1)).toEqual({ role: "user", content: "Hi Jarvis" });

    const stored = await call(app, alice, "GET", `/v1/conversations/${conversationId}`);
    const body = (await stored.json()) as {
      conversation: { title: string };
      messages: { role: string; content: string; status: string; provider: string | null }[];
    };
    expect(body.conversation.title).toBe("Hi Jarvis");
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hi Jarvis" }),
      expect.objectContaining({
        role: "assistant",
        content: "Hello Alice, how can I help?",
        status: "complete",
        provider: "primary",
      }),
    ]);
  });

  it("sends previous turns as context", async () => {
    const model = scriptedProvider("primary", "Noted.");
    const app = createApp(env, { chat: chatSettings([model.provider]) });
    const conversationId = await startConversation(app, alice);

    await sseEvents(
      await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content: "My favourite colour is green.",
      }),
    );
    await sseEvents(
      await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content: "What is my favourite colour?",
      }),
    );

    const second = model.received[1]!.filter((m) => m.role !== "system");
    expect(second).toEqual([
      { role: "user", content: "My favourite colour is green." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "What is my favourite colour?" },
    ]);
  });

  it("falls back to the next provider when the first is rate limited", async () => {
    const limited = scriptedProvider(
      "limited",
      new ProviderError("limited", "429", { status: 429, retryable: true }),
    );
    const backup = scriptedProvider("backup", "From the backup model.");
    const app = createApp(env, { chat: chatSettings([limited.provider, backup.provider]) });
    const conversationId = await startConversation(app, alice);

    const events = await sseEvents(
      await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content: "Hello?",
      }),
    );
    expect(events.find((e) => e.event === "model")?.data).toEqual({
      provider: "backup",
      model: "backup-model",
    });
    expect(events.at(-1)?.event).toBe("done");
  });

  it("reports a clean error when no model is available and stores the failure", async () => {
    const down = scriptedProvider(
      "down",
      new ProviderError("down", "503", { status: 503, retryable: true }),
    );
    const app = createApp(env, { chat: chatSettings([down.provider]) });
    const conversationId = await startConversation(app, alice);

    const events = await sseEvents(
      await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content: "Anyone there?",
      }),
    );
    expect(events.at(-1)).toEqual({
      event: "error",
      data: { code: "unavailable", message: expect.any(String) },
    });

    const stored = (await (
      await call(app, alice, "GET", `/v1/conversations/${conversationId}`)
    ).json()) as {
      messages: { role: string; status: string }[];
    };
    expect(stored.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "error"],
    ]);
  });

  it("returns 503 when no provider is configured", async () => {
    const app = createApp(env, { chat: chatSettings([]) });
    const conversationId = await startConversation(app, alice);
    const res = await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
      content: "hi",
    });
    expect(res.status).toBe(503);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary JSON */
describe("system status and usage", () => {
  it("reports real configuration, last reply and today's usage", async () => {
    const model = scriptedProvider("primary", "Status check.", {
      inputTokens: 30,
      outputTokens: 12,
    });
    const app = createApp(env, {
      chat: chatSettings([model.provider], { dailyTokenLimit: 50_000 }),
    });
    const conversationId = await startConversation(app, alice);
    await sseEvents(
      await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content: "ping",
      }),
    );

    const status = (await (await call(app, alice, "GET", "/v1/system/status")).json()) as Record<
      string,
      any
    >;
    expect(status.api.status).toBe("online");
    expect(status.database.status).toBe("online");
    expect(status.ai).toMatchObject({
      status: "configured",
      providers: [{ provider: "primary", models: ["primary-model"] }],
      lastReply: { provider: "primary", model: "primary-model", status: "complete" },
    });
    expect(JSON.stringify(status)).not.toMatch(/api_?key|secret|AIza|sk-|Bearer/i);

    const usage = (await (await call(app, alice, "GET", "/v1/me/usage")).json()) as Record<
      string,
      any
    >;
    expect(usage.dailyLimit).toBe(50_000);
    expect(usage.usedToday).toBeGreaterThanOrEqual(42);
    expect(usage.byModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "primary", model: "primary-model" }),
      ]),
    );
  });

  it("reports when no AI provider is configured", async () => {
    const app = createApp(env, { chat: chatSettings([]) });
    const status = (await (await call(app, bob, "GET", "/v1/system/status")).json()) as Record<
      string,
      any
    >;
    expect(status.ai.status).toBe("not_configured");
  });
});

describe("privacy and limits", () => {
  it("keeps conversations private, even from other users", async () => {
    const model = scriptedProvider("primary", "Secret plan.");
    const app = createApp(env, { chat: chatSettings([model.provider]) });
    const conversationId = await startConversation(app, alice);
    await sseEvents(
      await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content: "Private",
      }),
    );

    expect((await call(app, bob, "GET", `/v1/conversations/${conversationId}`)).status).toBe(404);
    expect(
      (
        await call(app, bob, "POST", `/v1/conversations/${conversationId}/messages`, {
          content: "Let me in",
        })
      ).status,
    ).toBe(404);
    expect((await call(app, bob, "DELETE", `/v1/conversations/${conversationId}`)).status).toBe(
      404,
    );
    expect(
      (
        await call(
          app,
          bob,
          "POST",
          `/v1/workspaces/${alice.personalWorkspaceId}/conversations`,
          {},
        )
      ).status,
    ).toBe(403);
    expect(model.received).toHaveLength(1); // Bob's attempt never reached the model
  });

  it("enforces the daily token limit", async () => {
    const model = scriptedProvider("primary", "ok", { inputTokens: 900, outputTokens: 200 });
    // Bob has used nothing yet; the limit is below one reply's cost.
    const app = createApp(env, { chat: chatSettings([model.provider], { dailyTokenLimit: 1000 }) });
    const conversationId = await startConversation(app, bob);

    const first = await call(app, bob, "POST", `/v1/conversations/${conversationId}/messages`, {
      content: "one",
    });
    expect(first.status).toBe(200);
    await sseEvents(first);

    const second = await call(app, bob, "POST", `/v1/conversations/${conversationId}/messages`, {
      content: "two",
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "quota_exceeded",
    );
  });

  it("rate-limits bursts of chat requests per user", async () => {
    const model = scriptedProvider("primary", "ok", { inputTokens: 1, outputTokens: 1 });
    const app = createApp(env, { chat: chatSettings([model.provider], { requestsPerMinute: 2 }) });
    const conversationId = await startConversation(app, alice);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content: `n${i}`,
      });
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("validates message content", async () => {
    const app = createApp(env, { chat: chatSettings([scriptedProvider("p", "x").provider]) });
    const conversationId = await startConversation(app, alice);
    for (const content of ["", "   ", "x".repeat(20_001)]) {
      const res = await call(app, alice, "POST", `/v1/conversations/${conversationId}/messages`, {
        content,
      });
      expect(res.status).toBe(400);
    }
  });
});
