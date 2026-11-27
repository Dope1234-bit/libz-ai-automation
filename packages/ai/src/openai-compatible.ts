import { z } from "zod";
import { parseSseData } from "./sse.js";
import type { ChatRequest, ModelProvider, StreamEvent, TokenUsage } from "./types.js";
import { ProviderError } from "./types.js";

export interface OpenAICompatibleOptions {
  id: string;
  /** e.g. https://api.groq.com/openai/v1 — `/chat/completions` is appended. */
  baseURL: string;
  /** Sent as `Authorization: Bearer`. Omit when a proxy injects credentials. */
  apiKey?: string;
  /** Extra headers, e.g. a provider-specific key header. */
  headers?: Record<string, string>;
  /** Abort a request that has produced nothing for this long. */
  timeoutMs?: number;
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

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.min((date - Date.now()) / 1000, 3600));
}

/**
 * Streaming client for any OpenAI-compatible chat completions API. Covers Gemini
 * (OpenAI-compatible endpoint), Groq, OpenRouter and Ollama with one audited
 * implementation instead of a vendor SDK per provider.
 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): ModelProvider {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    id: options.id,
    async *streamChat(model: string, request: ChatRequest): AsyncGenerator<StreamEvent> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          signal,
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
        });
      } catch (err) {
        if (request.signal?.aborted) throw err;
        throw new ProviderError(options.id, "Network error contacting model provider.", {
          retryable: true,
          cause: err,
        });
      }

      if (!response.ok || !response.body) {
        const status = response.status;
        // Drain without surfacing the body: provider errors can echo request content.
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderError(options.id, `Model provider returned HTTP ${status}.`, {
          status,
          retryable: status === 408 || status === 429 || status >= 500,
          retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
        });
      }

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
