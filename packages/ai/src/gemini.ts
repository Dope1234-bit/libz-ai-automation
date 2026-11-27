import { z } from "zod";
import type { Timeouts } from "./http.js";
import { DEFAULT_TIMEOUTS, fetchWithTimeouts, providerHttpError } from "./http.js";
import { parseSseData } from "./sse.js";
import type { ChatRequest, ModelProvider, StreamEvent, TokenUsage } from "./types.js";
import { ProviderError } from "./types.js";

export interface GeminiOptions {
  id?: string;
  baseURL?: string;
  /** Sent as `x-goog-api-key`. Omit when a proxy injects it. */
  apiKey?: string;
  timeouts?: Partial<Timeouts>;
  fetch?: typeof fetch;
}

const chunkSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional() }).loose()).default([]) })
          .loose()
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .default([]),
  promptFeedback: z.object({ blockReason: z.string().optional() }).loose().optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().default(0),
      candidatesTokenCount: z.number().int().nonnegative().default(0),
      thoughtsTokenCount: z.number().int().nonnegative().default(0),
    })
    .loose()
    .optional(),
});

const FINISH_REASONS: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
};

/**
 * Streaming client for Google's native Gemini API (`streamGenerateContent`).
 * Used instead of Gemini's OpenAI-compatible endpoint because that endpoint
 * only accepts keys via `Authorization: Bearer`, while the native API takes the
 * standard `x-goog-api-key` header (which managed egress proxies inject).
 */
export function createGeminiProvider(options: GeminiOptions = {}): ModelProvider {
  const id = options.id ?? "gemini";
  const baseURL = (options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  const doFetch = options.fetch ?? fetch;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

  return {
    id,
    async *streamChat(model: string, request: ChatRequest): AsyncGenerator<StreamEvent> {
      const system = request.messages.filter((m) => m.role === "system").map((m) => m.content);
      const contents = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      const url = `${baseURL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const response = await fetchWithTimeouts(
        id,
        doFetch,
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(options.apiKey ? { "x-goog-api-key": options.apiKey } : {}),
          },
          body: JSON.stringify({
            ...(system.length
              ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } }
              : {}),
            contents,
            generationConfig: {
              ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
          }),
        },
        request.signal,
        timeouts,
      );

      if (!response.ok || !response.body) throw await providerHttpError(id, response);

      yield { type: "start", provider: id, model };

      let finishReason = "stop";
      let usage: TokenUsage | null = null;

      for await (const data of parseSseData(response.body)) {
        let chunk;
        try {
          chunk = chunkSchema.parse(JSON.parse(data));
        } catch (err) {
          throw new ProviderError(id, "Malformed stream from model provider.", {
            retryable: false,
            cause: err,
          });
        }
        if (chunk.promptFeedback?.blockReason) finishReason = "content_filter";
        for (const candidate of chunk.candidates) {
          for (const part of candidate.content?.parts ?? []) {
            if (part.text) yield { type: "text", delta: part.text };
          }
          if (candidate.finishReason) {
            finishReason =
              FINISH_REASONS[candidate.finishReason] ?? candidate.finishReason.toLowerCase();
          }
        }
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount,
            // Thinking tokens are billed as output.
            outputTokens:
              chunk.usageMetadata.candidatesTokenCount + chunk.usageMetadata.thoughtsTokenCount,
          };
        }
      }

      yield { type: "finish", finishReason, usage };
    },
  };
}
