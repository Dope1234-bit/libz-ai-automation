import { z } from "zod";
import { parseSseData } from "./sse.js";
import type { ChatRequest, ModelProvider, StreamEvent, TokenUsage } from "./types.js";
import { ProviderError } from "./types.js";
import type { Timeouts } from "./http.js";
import { DEFAULT_TIMEOUTS, fetchWithTimeouts, providerHttpError } from "./http.js";

export interface OpenAICompatibleOptions {
  id: string;
  /** e.g. https://api.groq.com/openai/v1 — `/chat/completions` is appended. */
  baseURL: string;
  /** Sent as `Authorization: Bearer`. Omit when a proxy injects credentials. */
  apiKey?: string;
  /** Extra headers, e.g. a provider-specific key header. */
  headers?: Record<string, string>;
  timeouts?: Partial<Timeouts>;
  fetch?: typeof fetch;
}

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullish() }).partial().nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .nullish(),
});

/**
 * Streaming client for any OpenAI-compatible chat completions API. Covers Gemini
 * (OpenAI-compatible endpoint), Groq, OpenRouter and Ollama with one audited
 * implementation instead of a vendor SDK per provider.
 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): ModelProvider {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

  return {
    id: options.id,
    async *streamChat(model: string, request: ChatRequest): AsyncGenerator<StreamEvent> {
      const response = await fetchWithTimeouts(
        options.id,
        doFetch,
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
            ...options.headers,
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          }),
        },
        request.signal,
        timeouts,
      );

      if (!response.ok || !response.body) throw await providerHttpError(options.id, response);

      yield { type: "start", provider: options.id, model };

      let finishReason = "stop";
      let usage: TokenUsage | null = null;

      for await (const data of parseSseData(response.body)) {
        if (data === "[DONE]") break;
        let parsed;
        try {
          parsed = chunkSchema.parse(JSON.parse(data));
        } catch (err) {
          throw new ProviderError(options.id, "Malformed stream from model provider.", {
            retryable: false,
            cause: err,
          });
        }
        for (const choice of parsed.choices) {
          const delta = choice.delta?.content;
          if (delta) yield { type: "text", delta };
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
          };
        }
      }

      yield { type: "finish", finishReason, usage };
    },
  };
}
