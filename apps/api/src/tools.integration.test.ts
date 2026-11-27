/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary JSON responses */
/**
 * Jarvis tool use end-to-end against a real Supabase stack: tools read real
 * rows under the user's RLS, results reach the model, proposals need explicit
 * confirmation, and the tool loop always terminates.
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRequest, ModelProvider, StreamEvent } from "@jarvis/ai";
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

/**
 * Scripted model. A user message chooses tool calls via a directive like
 * `#call search_clients {"query":"Moyo"}`; after tool results it replies with
 * the raw results so tests can see exactly what the model was given.
 */
const requests: ChatRequest[] = [];
let loopForever = false;
const scripted: ModelProvider = {
  id: "scripted",
  async *streamChat(model, request): AsyncGenerator<StreamEvent> {
    requests.push(request);
    yield { type: "start", provider: "scripted", model };
    const last = request.messages.at(-1) as ChatMessage;
    if (loopForever && request.tools?.length) {
      yield { type: "tool_call", call: { id: randomUUID(), name: "list_tasks", args: {} } };
    } else if (last.role === "user") {
      const calls = [...last.content.matchAll(/#call (\w+) (\{.*?\})(?=\s#call|$)/g)];
      if (calls.length === 0) {
        yield { type: "text", delta: "No tools needed." };
      }
      for (const [, name, args] of calls) {
        yield {
          type: "tool_call",
          call: { id: randomUUID(), name: name!, args: JSON.parse(args!) },
        };
      }
    } else {
      const results = request.messages.filter((m) => m.role === "tool").map((m) => m.content);
      yield { type: "text", delta: `RESULTS ${results.join(" || ")}` };
    }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } };
  },
};

const app = createApp(env, {
  chat: {
    router: createModelRouter({
      providers: [scripted],
      routes: { chat: [{ provider: "scripted", model: "scripted-1" }] },
    }),
    dailyTokenLimit: 1_000_000,
    maxOutputTokens: 256,
    historyChars: 20_000,
    requestsPerMinute: 1000,
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
  ).json()) as { workspaces: { id: string; type: string }[] };
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

/** Send a chat message and return the parsed SSE events. */
async function chat(user: User, conversationId: string, content: string) {
  const res = await call(user, "POST", `/v1/conversations/${conversationId}/messages`, { content });
  expect(res.status).toBe(200);
  return (res.body as string)
    .split("\n\n")
    .filter(Boolean)
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null"),
    }));
}

const text = (events: Awaited<ReturnType<typeof chat>>) =>
  events
    .filter((e) => e.event === "delta")
    .map((e) => e.data.text)
    .join("");

let owner: User;
let outsider: User;
let ws: string;
let otherWs: string;
let companyId: string;

beforeAll(async () => {
  [owner, outsider] = await Promise.all([createUser("tools-owner"), createUser("tools-outsider")]);
  ws = (await call(owner, "POST", "/v1/workspaces", { name: "Libz Tools" })).body.workspace.id;
  otherWs = (await call(outsider, "POST", "/v1/workspaces", { name: "Rival" })).body.workspace.id;
  companyId = (
    await call(owner, "POST", `/v1/workspaces/${ws}/companies`, {
      name: "Moyo Hardware",
      city: "Harare",
    })
  ).body.item.id;
  await call(owner, "POST", `/v1/workspaces/${ws}/deals`, {
    companyId,
    title: "Booking bot",
    value: 1200,
  });
});

afterAll(async () => {
  await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
});

async function conversation(user: User, workspaceId: string) {
  return (await call(user, "POST", `/v1/workspaces/${workspaceId}/conversations`, {})).body
    .conversation.id as string;
}

describe("Jarvis tools", () => {
  it("offers CRM tools in business workspaces and only task tools in personal ones", async () => {
    requests.length = 0;
    await chat(owner, await conversation(owner, ws), "hello");
    expect(requests[0]!.tools!.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "search_clients",
        "get_client",
        "pipeline_summary",
        "propose_task",
        "propose_activity_note",
      ]),
    );
    expect(requests[0]!.messages[0]!.content).toContain("never invent clients");

    requests.length = 0;
    await chat(owner, await conversation(owner, owner.personal), "hello");
    expect(requests[0]!.tools!.map((t) => t.name).sort()).toEqual(["list_tasks", "propose_task"]);
  });

  it("answers from real records via tools", async () => {
    const events = await chat(
      owner,
      await conversation(owner, ws),
      '#call search_clients {"query":"moyo"} #call pipeline_summary {}',
    );
    expect(
      events.filter((e) => e.event === "tool").map((e) => `${e.data.name}:${e.data.status}`),
    ).toEqual([
      "search_clients:running",
      "search_clients:done",
      "pipeline_summary:running",
      "pipeline_summary:done",
    ]);
    const reply = text(events);
    expect(reply).toContain("Moyo Hardware");
    expect(reply).toContain('"open":{"USD":1200}');
    const done = events.find((e) => e.event === "done")!;
    expect(done.data.usage).toMatchObject({ inputTokens: 20, outputTokens: 10, estimated: false });
  });

  it("tools only see the caller's workspace", async () => {
    const events = await chat(
      outsider,
      await conversation(outsider, otherWs),
      '#call search_clients {"query":"Moyo"}',
    );
    expect(text(events)).toContain('{"clients":[],"contacts":[]}');
    const direct = await chat(
      outsider,
      await conversation(outsider, otherWs),
      `#call get_client {"client_id":"${companyId}"}`,
    );
    expect(text(direct)).toContain("No client with that id.");
  });

  it("returns input errors to the model instead of failing", async () => {
    const events = await chat(
      owner,
      await conversation(owner, ws),
      '#call list_deals {"stage":"bogus"}',
    );
    expect(text(events)).toContain('"error"');
    expect(events.at(-1)!.event).toBe("done");
  });

  it("creates nothing until the user confirms a proposal", async () => {
    const convo = await conversation(owner, ws);
    const events = await chat(
      owner,
      convo,
      `#call propose_task {"title":"Send quote to Moyo","priority":"high","due_at":"2026-12-01T09:00:00Z","client_id":"${companyId}"}`,
    );
    const proposal = events.find((e) => e.event === "proposal")!.data;
    expect(proposal).toMatchObject({
      kind: "task",
      status: "pending",
      payload: { title: "Send quote to Moyo", company_name: "Moyo Hardware", priority: "high" },
    });
    expect(text(events)).toContain("awaiting_user_confirmation");
    const before = await call(owner, "GET", `/v1/workspaces/${ws}/tasks?q=quote`);
    expect(before.body.items).toEqual([]);

    const confirmed = await call(owner, "POST", `/v1/proposals/${proposal.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.proposal.status).toBe("confirmed");
    const task = (await call(owner, "GET", `/v1/tasks/${confirmed.body.proposal.result_id}`)).body
      .item;
    expect(task).toMatchObject({
      title: "Send quote to Moyo",
      priority: "high",
      company_id: companyId,
    });

    expect((await call(owner, "POST", `/v1/proposals/${proposal.id}/confirm`)).status).toBe(400);
    expect((await call(outsider, "POST", `/v1/proposals/${proposal.id}/dismiss`)).status).toBe(404);

    const history = await call(owner, "GET", `/v1/conversations/${convo}`);
    expect(history.body.proposals).toEqual([
      expect.objectContaining({ id: proposal.id, status: "confirmed" }),
    ]);
  });

  it("rejects proposals about another workspace's client", async () => {
    const events = await chat(
      outsider,
      await conversation(outsider, otherWs),
      `#call propose_activity_note {"client_id":"${companyId}","type":"call","summary":"x"}`,
    );
    expect(events.some((e) => e.event === "proposal")).toBe(false);
    expect(text(events)).toContain("does not match a client");
  });

  it("dismissing creates nothing", async () => {
    const events = await chat(
      owner,
      await conversation(owner, ws),
      `#call propose_activity_note {"client_id":"${companyId}","type":"call","direction":"inbound","summary":"Asked about pricing"}`,
    );
    const proposal = events.find((e) => e.event === "proposal")!.data;
    const dismissed = await call(owner, "POST", `/v1/proposals/${proposal.id}/dismiss`);
    expect(dismissed.body.proposal).toMatchObject({ status: "dismissed", result_id: null });
    const activities = await call(
      owner,
      "GET",
      `/v1/workspaces/${ws}/activities?company_id=${companyId}`,
    );
    expect(activities.body.items).toEqual([]);
  });

  it("always stops: the last round has no tools", async () => {
    requests.length = 0;
    loopForever = true;
    try {
      const events = await chat(owner, await conversation(owner, ws), "loop");
      expect(events.at(-1)!.event).toBe("done");
    } finally {
      loopForever = false;
    }
    expect(requests).toHaveLength(6);
    expect(requests.at(-1)!.tools).toBeUndefined();
  });
});
