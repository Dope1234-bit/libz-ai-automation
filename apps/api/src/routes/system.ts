import { Hono } from "hono";
import { API_VERSION } from "../version.js";
import type { AppEnv } from "../context.js";
import { unwrap, unwrapMaybe } from "../db.js";
import type { ChatSettings } from "./conversations.js";

/** Start of the current UTC day, matching the database quota window. */
function startOfUtcDay(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/**
 * Real system state for the Command Centre. Every value comes from live
 * configuration or the caller's own data (RLS-scoped); provider keys are never
 * exposed, only provider and model names.
 */
export function systemRoutes(chat: ChatSettings) {
  return new Hono<AppEnv>()
    .get("/system/status", async (c) => {
      const db = c.get("db");
      const candidates = chat.router.candidates("chat");

      const providers = new Map<string, string[]>();
      for (const ref of candidates) {
        providers.set(ref.provider, [...(providers.get(ref.provider) ?? []), ref.model]);
      }

      // The caller's most recent assistant reply: real evidence of AI health.
      let databaseOk = true;
      let lastReply: {
        provider: string | null;
        model: string | null;
        status: string;
        at: string;
      } | null = null;
      try {
        const row = await db
          .from("messages")
          .select("provider, model, status, created_at")
          .eq("role", "assistant")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(unwrapMaybe);
        lastReply = row
          ? { provider: row.provider, model: row.model, status: row.status, at: row.created_at }
          : null;
      } catch {
        databaseOk = false;
      }

      return c.json({
        api: { version: API_VERSION, status: "online" },
        database: { status: databaseOk ? "online" : "degraded" },
        ai: {
          status: candidates.length === 0 ? "not_configured" : "configured",
          providers: [...providers].map(([provider, models]) => ({ provider, models })),
          lastReply,
        },
        limits: {
          dailyTokenLimit: chat.dailyTokenLimit,
          requestsPerMinute: chat.requestsPerMinute,
        },
      });
    })
    .get("/me/usage", async (c) => {
      const rows = await c
        .get("db")
        .from("ai_usage")
        .select("provider, model, input_tokens, output_tokens")
        .eq("user_id", c.get("user").id)
        .gte("created_at", startOfUtcDay())
        .limit(5000)
        .then(unwrap);

      const byModel = new Map<
        string,
        { provider: string; model: string; tokens: number; replies: number }
      >();
      let used = 0;
      for (const r of rows) {
        const tokens = r.input_tokens + r.output_tokens;
        used += tokens;
        const key = `${r.provider}/${r.model}`;
        const entry = byModel.get(key) ?? {
          provider: r.provider,
          model: r.model,
          tokens: 0,
          replies: 0,
        };
        entry.tokens += tokens;
        entry.replies += 1;
        byModel.set(key, entry);
      }

      return c.json({
        usedToday: used,
        dailyLimit: chat.dailyTokenLimit,
        resetsAt: new Date(Date.parse(startOfUtcDay()) + 86_400_000).toISOString(),
        byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
      });
    });
}
