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

const scripted: ModelProvider = {
  id: "scripted",
  async *streamChat(model, request) {
    const last = request.messages.at(-1)?.content ?? "";
    const reply = `You said: "${last}". I'm Jarvis, running on a scripted test model.`;
    yield { type: "start", provider: "scripted", model };
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
