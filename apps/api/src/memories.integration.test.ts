/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary JSON responses */
/**
 * Memory end-to-end tests against a real Supabase stack: CRUD, privacy,
 * Personal/Business isolation, and that Sir Libz actually receives the memories.
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

/** Records the system prompt Sir Libz was given. */
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
  const session = await client.auth.signInWithPassword({ email, password });
  if (session.error) throw session.error;
  const token = session.data.session.access_token;
  const me = (await (
    await app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as {
    workspaces: { id: string; type: string }[];
  };
  return { token, personal: me.workspaces.find((w) => w.type === "personal")!.id };
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

let owner: User;
let other: User;
let business: string;

beforeAll(async () => {
  [owner, other] = await Promise.all([createUser("mem-owner"), createUser("mem-other")]);
  business = (await call(owner, "POST", "/v1/workspaces", { name: "Libz Test" })).body.workspace.id;
});

afterAll(async () => {
  await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe("memories", () => {
  let personalMemoryId: string;

  it("creates, lists, pins and edits memories", async () => {
    const created = await call(owner, "POST", `/v1/workspaces/${owner.personal}/memories`, {
      content: "  I prefer meetings after 10am  ",
      category: "preference",
    });
    expect(created.status).toBe(201);
    expect(created.body.memory).toMatchObject({
      content: "I prefer meetings after 10am",
      pinned: false,
      source: "manual",
    });
    personalMemoryId = created.body.memory.id;

    const pinned = await call(owner, "PATCH", `/v1/memories/${personalMemoryId}`, { pinned: true });
    expect(pinned.body.memory.pinned).toBe(true);

    const list = await call(owner, "GET", `/v1/workspaces/${owner.personal}/memories`);
    expect(list.body.memories).toHaveLength(1);
  });

  it("validates input", async () => {
    for (const body of [
      { content: "" },
      { content: "x".repeat(1001) },
      { content: "ok", category: "secret" },
      { content: "ok", extra: 1 },
    ]) {
      expect(
        (await call(owner, "POST", `/v1/workspaces/${owner.personal}/memories`, body)).status,
      ).toBe(400);
    }
  });

  it("keeps memories private to their owner", async () => {
    expect(
      (await call(other, "GET", `/v1/workspaces/${owner.personal}/memories`)).body.memories,
    ).toEqual([]);
    expect(
      (await call(other, "PATCH", `/v1/memories/${personalMemoryId}`, { content: "hacked" }))
        .status,
    ).toBe(404);
    expect((await call(other, "DELETE", `/v1/memories/${personalMemoryId}`)).status).toBe(404);
    expect(
      (
        await call(other, "POST", `/v1/workspaces/${owner.personal}/memories`, {
          content: "intrusion",
        })
      ).status,
    ).toBe(403);
  });

  it("gives Sir Libz only the current workspace's memories", async () => {
    await call(owner, "POST", `/v1/workspaces/${business}/memories`, {
      content: "Our main client is Acme Corp",
      category: "fact",
    });

    const personalChat = (
      await call(owner, "POST", `/v1/workspaces/${owner.personal}/conversations`, {})
    ).body.conversation.id;
    await call(owner, "POST", `/v1/conversations/${personalChat}/messages`, {
      content: "When do I like meetings?",
    });
    const personalPrompt = seenPrompts.at(-1)![0]!.content;
    expect(personalPrompt).toContain("I prefer meetings after 10am");
    expect(personalPrompt).not.toContain("Acme Corp");

    const businessChat = (await call(owner, "POST", `/v1/workspaces/${business}/conversations`, {}))
      .body.conversation.id;
    await call(owner, "POST", `/v1/conversations/${businessChat}/messages`, {
      content: "Who is our main client?",
    });
    const businessPrompt = seenPrompts.at(-1)![0]!.content;
    expect(businessPrompt).toContain("Acme Corp");
    expect(businessPrompt).not.toContain("10am");
  });

  it("can save a memory from the author's own message, and deletes it", async () => {
    const convo = (await call(owner, "POST", `/v1/workspaces/${owner.personal}/conversations`, {}))
      .body.conversation.id;
    await call(owner, "POST", `/v1/conversations/${convo}/messages`, {
      content: "My sister's name is Rudo",
    });
    const messages = (await call(owner, "GET", `/v1/conversations/${convo}`)).body.messages as {
      id: string;
      role: string;
    }[];
    const userMessage = messages.find((m) => m.role === "user")!;

    const saved = await call(owner, "POST", `/v1/workspaces/${owner.personal}/memories`, {
      content: "My sister's name is Rudo",
      category: "person",
      sourceMessageId: userMessage.id,
    });
    expect(saved.status).toBe(201);
    expect(saved.body.memory.source).toBe("message");

    // Another user cannot cite that message.
    const stolen = await call(other, "POST", `/v1/workspaces/${other.personal}/memories`, {
      content: "x",
      sourceMessageId: userMessage.id,
    });
    expect(stolen.status).toBe(404);

    expect((await call(owner, "DELETE", `/v1/memories/${saved.body.memory.id}`)).status).toBe(204);
    expect((await call(owner, "DELETE", `/v1/memories/${saved.body.memory.id}`)).status).toBe(404);
  });
});
