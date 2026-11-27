import type { ChatMessage, ModelRouter, TokenUsage } from "@jarvis/ai";
import { buildSystemPrompt, fitHistory, NoModelAvailableError } from "@jarvis/ai";
import { AppError, ErrorCode } from "@jarvis/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { unwrap, unwrapMaybe } from "../db.js";
import { rateLimitPerUser } from "../rate-limit.js";
import { parseBody, uuidParam } from "../validation.js";

export interface ChatSettings {
  router: ModelRouter;
  /** Tokens (input + output) a user may spend per UTC day across workspaces. */
  dailyTokenLimit: number;
  maxOutputTokens: number;
  /** Character budget for conversation history sent to the model. */
  historyChars: number;
  /** Chat requests per user per minute. */
  requestsPerMinute: number;
}

const titleSchema = z.string().trim().min(1).max(200);
const messageSchema = z.object({ content: z.string().trim().min(1).max(20_000) }).strict();

const notFound = () => new AppError(ErrorCode.NotFound, "Conversation not found.");

/** Rough token estimate (~4 chars/token) when a provider omits usage data. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function conversationRoutes(settings: ChatSettings) {
  const chatLimiter = rateLimitPerUser({ limit: settings.requestsPerMinute, windowMs: 60_000 });

  return (
    new Hono<AppEnv>()
      .get("/workspaces/:workspaceId/conversations", async (c) => {
        const workspaceId = uuidParam(c, "workspaceId");
        const rows = await c
          .get("db")
          .from("conversations")
          .select("id, title, last_message_at, created_at")
          .eq("workspace_id", workspaceId)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(100)
          .then(unwrap);
        return c.json({ conversations: rows });
      })
      .post("/workspaces/:workspaceId/conversations", async (c) => {
        const workspaceId = uuidParam(c, "workspaceId");
        const body = await parseBody(c, z.object({ title: titleSchema.optional() }).strict());
        const conversation = await c
          .get("db")
          .from("conversations")
          .insert({ workspace_id: workspaceId, title: body.title ?? null })
          .select("id, workspace_id, title, created_at")
          .single()
          .then(unwrap);
        return c.json({ conversation }, 201);
      })
      .get("/conversations/:conversationId", async (c) => {
        const id = uuidParam(c, "conversationId");
        const db = c.get("db");
        const conversation = await db
          .from("conversations")
          .select("id, workspace_id, title, last_message_at, created_at")
          .eq("id", id)
          .maybeSingle()
          .then(unwrapMaybe);
        if (!conversation) throw notFound();
        const messages = await db
          .from("messages")
          .select("id, role, content, status, provider, model, created_at")
          .eq("conversation_id", id)
          .order("created_at")
          .limit(500)
          .then(unwrap);
        return c.json({ conversation, messages });
      })
      .patch("/conversations/:conversationId", async (c) => {
        const id = uuidParam(c, "conversationId");
        const { title } = await parseBody(c, z.object({ title: titleSchema }).strict());
        const rows = await c
          .get("db")
          .from("conversations")
          .update({ title })
          .eq("id", id)
          .select("id, title")
          .then(unwrap);
        if (rows.length === 0) throw notFound();
        return c.json({ conversation: rows[0] });
      })
      .delete("/conversations/:conversationId", async (c) => {
        const id = uuidParam(c, "conversationId");
        const rows = await c
          .get("db")
          .from("conversations")
          .delete()
          .eq("id", id)
          .select("id")
          .then(unwrap);
        if (rows.length === 0) throw notFound();
        return c.body(null, 204);
      })

      // ------------------------------------------------------------ streaming chat
      .post("/conversations/:conversationId/messages", chatLimiter, async (c) => {
        const conversationId = uuidParam(c, "conversationId");
        const { content } = await parseBody(c, messageSchema);
        const db = c.get("db");

        if (settings.router.candidates("chat").length === 0) {
          throw new AppError(ErrorCode.Unavailable, "No AI provider is configured.");
        }

        const used = Number(await db.rpc("ai_tokens_used_today").then(unwrap));
        if (used >= settings.dailyTokenLimit) {
          throw new AppError(
            ErrorCode.QuotaExceeded,
            "Daily AI usage limit reached. It resets at 00:00 UTC.",
          );
        }

        const conversation = await db
          .from("conversations")
          .select("id, workspaces (name, type)")
          .eq("id", conversationId)
          .maybeSingle<{
            id: string;
            workspaces: { name: string; type: "personal" | "business" } | null;
          }>()
          .then(unwrapMaybe);
        if (!conversation?.workspaces) throw notFound();

        // Validates ownership and write access (members+) in the database.
        const userMessageId = await db
          .rpc("add_user_message", { p_conversation_id: conversationId, p_content: content })
          .then(unwrap);

        const [history, profile] = await Promise.all([
          db
            .from("messages")
            .select("role, content, status")
            .eq("conversation_id", conversationId)
            .neq("status", "error")
            .order("created_at", { ascending: false })
            .limit(60)
            .then(unwrap),
          db
            .from("profiles")
            .select("display_name")
            .eq("id", c.get("user").id)
            .maybeSingle()
            .then(unwrapMaybe),
        ]);

        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt({
              workspaceName: conversation.workspaces.name,
              workspaceType: conversation.workspaces.type,
              userDisplayName: profile?.display_name ?? null,
              now: new Date(),
            }),
          },
          ...fitHistory(
            history
              .reverse()
              .filter((m) => m.content.length > 0)
              .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            settings.historyChars,
          ),
        ];

        const requestSignal = c.req.raw.signal;

        return streamSSE(c, async (stream) => {
          let text = "";
          let provider: string | null = null;
          let model: string | null = null;
          let usage: TokenUsage | null = null;
          let status: "complete" | "partial" | "error" = "complete";
          let failure: { code: string; message: string } | null = null;

          await stream.writeSSE({ event: "start", data: JSON.stringify({ userMessageId }) });

          try {
            for await (const event of settings.router.stream("chat", {
              messages,
              maxOutputTokens: settings.maxOutputTokens,
              signal: requestSignal,
            })) {
              if (event.type === "start") {
                provider = event.provider;
                model = event.model;
                await stream.writeSSE({
                  event: "model",
                  data: JSON.stringify({ provider, model }),
                });
              } else if (event.type === "text") {
                text += event.delta;
                await stream.writeSSE({
                  event: "delta",
                  data: JSON.stringify({ text: event.delta }),
                });
              } else {
                usage = event.usage;
                if (event.finishReason === "length") status = "partial";
              }
            }
          } catch (err) {
            status = text ? "partial" : "error";
            if (requestSignal.aborted) {
              failure = null; // client went away; nothing to report to it
            } else if (err instanceof NoModelAvailableError) {
              failure = {
                code: ErrorCode.Unavailable,
                message: "No AI model is available right now. Please try again shortly.",
              };
            } else {
              failure = { code: ErrorCode.Internal, message: "The AI response failed." };
            }
            console.error(
              JSON.stringify({
                level: "error",
                requestId: c.get("requestId"),
                msg: "chat stream failed",
                err: String(err),
                attempts: err instanceof NoModelAvailableError ? err.attempts : undefined,
              }),
            );
          }

          // Count spend even when the provider omits usage, so limits still hold.
          const inputTokens =
            usage?.inputTokens ??
            (provider ? estimateTokens(messages.map((m) => m.content).join("")) : 0);
          const outputTokens = usage?.outputTokens ?? estimateTokens(text);

          let assistantMessageId: string | null = null;
          try {
            assistantMessageId = await db
              .rpc("add_assistant_message", {
                p_conversation_id: conversationId,
                p_content: text,
                p_status: status,
                p_provider: provider,
                p_model: model,
                p_input_tokens: provider ? inputTokens : null,
                p_output_tokens: provider ? outputTokens : null,
              })
              .then(unwrap);
          } catch (err) {
            console.error(
              JSON.stringify({
                level: "error",
                requestId: c.get("requestId"),
                msg: "saving reply failed",
                err: String(err),
              }),
            );
          }

          if (failure) {
            await stream.writeSSE({ event: "error", data: JSON.stringify(failure) });
          } else if (!requestSignal.aborted) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({
                messageId: assistantMessageId,
                status,
                usage: { inputTokens, outputTokens, estimated: usage === null },
              }),
            });
          }
        });
      })
  );
}
