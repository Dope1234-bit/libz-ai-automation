"use client";

import { config } from "./config";
import { getSupabase } from "./supabase/client";

export interface Workspace {
  id: string;
  type: "personal" | "business";
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export interface Me {
  user: { id: string; email: string | null; mfa: boolean };
  profile: { displayName: string | null; avatarUrl: string | null };
  workspaces: Workspace[];
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "partial" | "error";
  provider: string | null;
  model: string | null;
  created_at: string;
}

export interface SystemStatus {
  api: { version: string; status: "online" };
  database: { status: "online" | "degraded" };
  ai: {
    status: "configured" | "not_configured";
    providers: { provider: string; models: string[] }[];
    lastReply: { provider: string | null; model: string | null; status: string; at: string } | null;
  };
  limits: { dailyTokenLimit: number; requestsPerMinute: number };
}

export interface Usage {
  usedToday: number;
  dailyLimit: number;
  resetsAt: string;
  byModel: { provider: string; model: string; tokens: number; replies: number }[];
}

export interface Member {
  userId: string;
  role: Workspace["role"];
  joinedAt: string;
  displayName: string | null;
}

export interface AuditEvent {
  id: number;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, "unauthenticated", "Please sign in again.");
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      ...(await authHeader()),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as
    (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.error?.code ?? "error",
      json?.error?.message ?? `Request failed (${res.status}).`,
    );
  }
  return json as T;
}

export const api = {
  me: () => request<Me>("GET", "/v1/me"),
  createWorkspace: (name: string) =>
    request<{ workspace: Workspace }>("POST", "/v1/workspaces", { name }),
  conversations: (workspaceId: string) =>
    request<{ conversations: ConversationSummary[] }>(
      "GET",
      `/v1/workspaces/${workspaceId}/conversations`,
    ),
  createConversation: (workspaceId: string) =>
    request<{ conversation: { id: string } }>(
      "POST",
      `/v1/workspaces/${workspaceId}/conversations`,
      {},
    ),
  conversation: (id: string) =>
    request<{ conversation: ConversationSummary; messages: Message[] }>(
      "GET",
      `/v1/conversations/${id}`,
    ),
  deleteConversation: (id: string) => request<void>("DELETE", `/v1/conversations/${id}`),
  status: () => request<SystemStatus>("GET", "/v1/system/status"),
  usage: () => request<Usage>("GET", "/v1/me/usage"),
  members: (workspaceId: string) =>
    request<{ members: Member[] }>("GET", `/v1/workspaces/${workspaceId}/members`),
  auditLogs: (workspaceId: string, limit = 8) =>
    request<{ events: AuditEvent[] }>(
      "GET",
      `/v1/workspaces/${workspaceId}/audit-logs?limit=${limit}`,
    ),
};

export type ChatStreamEvent =
  | { event: "start"; data: { userMessageId: string } }
  | { event: "model"; data: { provider: string; model: string } }
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { messageId: string | null; status: string } }
  | { event: "error"; data: { code: string; message: string } };

/** Send a message and yield the streamed reply events. */
export async function* sendMessage(
  conversationId: string,
  content: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`${config.apiUrl}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    const json = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    throw new ApiError(
      res.status,
      json?.error?.code ?? "error",
      json?.error?.message ?? `Request failed (${res.status}).`,
    );
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) } as ChatStreamEvent;
    }
  }
}
