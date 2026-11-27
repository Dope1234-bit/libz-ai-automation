/**
 * Test-only API server for browser end-to-end tests: the real app, wired to a
 * scripted model so tests are deterministic and need no AI provider key.
 * Lives outside src/ so it is never part of the production build.
 *
 *   SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… tsx test/e2e-server.ts
 */
import { serve } from "@hono/node-server";
import type { ModelProvider } from "@jarvis/ai";
import { createModelRouter } from "@jarvis/ai";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

/**
 * Deterministic stand-in model. Mentions of "pipeline" or "remind me to …"
 * trigger real tool calls (so browser tests exercise the tool loop); after tool
 * results it reports what the tools returned. Anything else is echoed.
 */
const scripted: ModelProvider = {
  id: "scripted",
  async *streamChat(model, request) {
    const last = request.messages.at(-1);
    const toolNames = new Set(request.tools?.map((t) => t.name) ?? []);
    yield { type: "start", provider: "scripted", model };

    if (last?.role === "user" && toolNames.size > 0) {
      const reminder = /remind me to (.+)/i.exec(last.content)?.[1];
      if (/pipeline/i.test(last.content) && toolNames.has("pipeline_summary")) {
        yield { type: "tool_call", call: { id: "c1", name: "pipeline_summary", args: {} } };
        yield {
          type: "finish",
          finishReason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 2 },
        };
        return;
      }
      if (reminder && toolNames.has("propose_task")) {
        yield {
          type: "tool_call",
          call: {
            id: "c1",
            name: "propose_task",
            args: { title: reminder.trim(), priority: "high" },
          },
        };
        yield {
          type: "finish",
          finishReason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 2 },
        };
        return;
      }
    }

    let reply: string;
    if (last?.role === "tool") {
      const result = JSON.parse(last.content) as {
        status?: string;
        pipeline?: { open: Record<string, number> };
      };
      reply = result.pipeline
        ? `Your open pipeline is ${
            Object.entries(result.pipeline.open)
              .map(([currency, value]) => `${currency} ${value}`)
              .join(", ") || "empty"
          }.`
        : "I've prepared that task. Please confirm it below; nothing is saved until you do.";
    } else {
      reply = `You said: "${last?.content ?? ""}". I'm **Sir Libz**, running on a scripted test model.`;
    }
    for (const word of reply.split(/(?<= )/)) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield { type: "text", delta: word };
    }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 10 } };
  },
};

const env = loadEnv();
const app = createApp(env, {
  chat: {
    router: createModelRouter({
      providers: [scripted],
      routes: { chat: [{ provider: "scripted", model: "scripted-test-model" }] },
    }),
    dailyTokenLimit: 1_000_000,
    maxOutputTokens: 512,
    historyChars: 20_000,
    requestsPerMinute: 120,
  },
});

serve({ fetch: app.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
  console.log(`e2e api listening on ${info.address}:${info.port}`);
});
