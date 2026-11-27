import { z } from "zod";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelRouter } from "./router.js";
import { createModelRouter } from "./router.js";
import type { ModelProvider, ModelRef, TaskType } from "./types.js";

/** Known free-tier-friendly providers, all reached through OpenAI-compatible APIs. */
export const PROVIDER_PRESETS = {
  gemini: {
    // Native API (see gemini.ts). Defaults use Google's auto-updating aliases,
    // because pinned free-tier model names are retired often.
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    defaults: {
      chat: "gemini-flash-latest,gemini-flash-lite-latest",
      fast: "gemini-flash-lite-latest,gemini-flash-latest",
    },
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    defaults: { chat: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant" },
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaults: {
      chat: "deepseek/deepseek-chat-v3-0324:free",
      fast: "deepseek/deepseek-chat-v3-0324:free",
    },
  },
  ollama: {
    baseURL: "http://127.0.0.1:11434/v1",
    keyEnv: null,
    defaults: { chat: "llama3.2", fast: "llama3.2" },
  },
} as const;

export type ProviderName = keyof typeof PROVIDER_PRESETS;

const providerName = z.enum(Object.keys(PROVIDER_PRESETS) as [ProviderName, ...ProviderName[]]);

const aiEnvSchema = z.object({
  /** Comma-separated, in preference order, e.g. "gemini,groq,openrouter". */
  AI_PROVIDERS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(providerName)),
  /**
   * When "true", provider keys are injected by an egress proxy (e.g. a managed
   * cloud environment) instead of being held by this process.
   */
  AI_KEYS_VIA_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OLLAMA_BASE_URL: z.url().optional(),
});

/**
 * Per-provider model overrides, e.g. GEMINI_CHAT_MODEL or GROQ_FAST_MODEL. A
 * comma-separated list gives fallbacks within the provider, tried in order.
 */
function modelsFor(source: Record<string, string | undefined>, name: ProviderName, task: TaskType) {
  const raw =
    source[`${name.toUpperCase()}_${task.toUpperCase()}_MODEL`]?.trim() ||
    PROVIDER_PRESETS[name].defaults[task];
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export interface AiConfig {
  router: ModelRouter;
  enabled: readonly ProviderName[];
}

export function buildAiFromEnv(
  source: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): AiConfig {
  const env = aiEnvSchema.parse(source);
  const providers: ModelProvider[] = [];

  for (const name of env.AI_PROVIDERS) {
    const preset = PROVIDER_PRESETS[name];
    const key = preset.keyEnv ? source[preset.keyEnv]?.trim() : undefined;
    if (preset.keyEnv && !key && !env.AI_KEYS_VIA_PROXY) {
      throw new Error(`AI provider "${name}" is enabled but ${preset.keyEnv} is not set.`);
    }
    const baseURL =
      name === "ollama" && env.OLLAMA_BASE_URL
        ? `${env.OLLAMA_BASE_URL.replace(/\/+$/, "")}/v1`
        : preset.baseURL;
    providers.push(
      name === "gemini"
        ? createGeminiProvider({
            baseURL,
            ...(key ? { apiKey: key } : {}),
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
          })
        : createOpenAICompatibleProvider({
            id: name,
            baseURL,
            ...(key ? { apiKey: key } : {}),
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
          }),
    );
  }

  const route = (task: TaskType): ModelRef[] =>
    env.AI_PROVIDERS.flatMap((name) =>
      modelsFor(source, name, task).map((model) => ({ provider: name, model })),
    );

  return {
    enabled: env.AI_PROVIDERS,
    router: createModelRouter({ providers, routes: { chat: route("chat"), fast: route("fast") } }),
  };
}
