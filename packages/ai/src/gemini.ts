import { z } from "zod";
import type { Timeouts } from "./http.js";
import { DEFAULT_TIMEOUTS, fetchWithTimeouts, providerHttpError } from "./http.js";
import { parseSseData } from "./sse.js";
import type { ChatMessage, ChatRequest, ModelProvider, StreamEvent, TokenUsage } from "./types.js";
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
          .object({
            parts: z
              .array(
                z
                  .object({
                    text: z.string().optional(),
                    thought: z.boolean().optional(),
                    thoughtSignature: z.string().optional(),
                    functionCall: z
                      .object({
                        id: z.string().optional(),
                        name: z.string(),
                        args: z.record(z.string(), z.unknown()).default({}),
                      })
                      .optional(),
                  })
                  .loose(),
              )
              .default([]),
          })
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
      const contents = toGeminiContents(request.messages);
      const tools = request.tools?.length
        ? [
            {
              functionDeclarations: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ]
        : undefined;

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
            ...(tools ? { tools } : {}),
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
      let calls = 0;

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
            if (part.functionCall) {
              calls += 1;
              yield {
                type: "tool_call",
                call: {
                  id: part.functionCall.id ?? `call_${calls}`,
                  name: part.functionCall.name,
                  args: part.functionCall.args,
                  ...(part.thoughtSignature
                    ? { meta: { thoughtSignature: part.thoughtSignature } }
                    : {}),
                },
              };
            } else if (part.text && !part.thought) {
              yield { type: "text", delta: part.text };
            }
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

      yield { type: "finish", finishReason: calls > 0 ? "tool_calls" : finishReason, usage };
    },
  };
}

type GeminiPart = Record<string, unknown>;

/** Map chat messages to Gemini `contents`, merging consecutive turns of the same role. */
export function toGeminiContents(messages: readonly ChatMessage[]) {
  const contents: { role: "user" | "model"; parts: GeminiPart[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (m.role === "tool") {
      parts.push({
        functionResponse: { name: m.name, response: { result: parseJson(m.content) } },
      });
    } else {
      if (m.content) parts.push({ text: m.content });
      if (m.role === "assistant") {
        for (const call of m.toolCalls ?? []) {
          parts.push({
            functionCall: { name: call.name, args: call.args },
            ...(call.meta?.thoughtSignature
              ? { thoughtSignature: call.meta.thoughtSignature }
              : {}),
          });
        }
      }
    }
    if (parts.length === 0) continue;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
