import { z } from "zod";
import { parseSseData } from "./sse.js";
import type { ChatMessage, ChatRequest, ModelProvider, StreamEvent, TokenUsage } from "./types.js";
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
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().default(0),
                  id: z.string().nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .partial()
          .nullish(),
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
            messages: toOpenAIMessages(request.messages),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((t) => ({
                    type: "function",
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters,
                    },
                  })),
                }
              : {}),
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
      // Tool calls arrive as fragments keyed by index; assemble them before emitting.
      const pending = new Map<number, { id: string; name: string; args: string }>();

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
          for (const fragment of choice.delta?.tool_calls ?? []) {
            const call = pending.get(fragment.index) ?? { id: "", name: "", args: "" };
            if (fragment.id) call.id = fragment.id;
            if (fragment.function?.name) call.name += fragment.function.name;
            if (fragment.function?.arguments) call.args += fragment.function.arguments;
            pending.set(fragment.index, call);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
          };
        }
      }

      for (const [index, call] of [...pending.entries()].sort(([a], [b]) => a - b)) {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = call.args ? JSON.parse(call.args) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed arguments: pass an empty object; tool validation reports the problem.
        }
        yield {
          type: "tool_call",
          call: { id: call.id || `call_${index + 1}`, name: call.name, args },
        };
      }

      yield { type: "finish", finishReason: pending.size > 0 ? "tool_calls" : finishReason, usage };
    },
  };
}

/** Map chat messages to the OpenAI chat-completions message format. */
export function toOpenAIMessages(messages: readonly ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}
