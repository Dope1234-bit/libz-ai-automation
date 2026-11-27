export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type StreamEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "text"; delta: string }
  | { type: "finish"; finishReason: string; usage: TokenUsage | null };

/** A chat-capable model provider (one API account). */
export interface ModelProvider {
  readonly id: string;
  streamChat(model: string, request: ChatRequest): AsyncGenerator<StreamEvent>;
}

/** What a request is for; the router picks models per task. */
export type TaskType = "chat" | "fast";

export interface ModelRef {
  provider: string;
  model: string;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;
  /** True for rate limits, timeouts and server errors — worth trying another model. */
  readonly retryable: boolean;
  /** Seconds the provider asked us to wait (from Retry-After), if any. */
  readonly retryAfterSeconds: number | null;

  constructor(
    provider: string,
    message: string,
    options: {
      status?: number | null;
      retryable: boolean;
      retryAfterSeconds?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.status = options.status ?? null;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** Thrown when every candidate model failed or is cooling down. */
export class NoModelAvailableError extends Error {
  readonly attempts: readonly { provider: string; model: string; reason: string }[];

  constructor(attempts: readonly { provider: string; model: string; reason: string }[]) {
    super("No AI model is currently available.");
    this.name = "NoModelAvailableError";
    this.attempts = attempts;
  }
}
