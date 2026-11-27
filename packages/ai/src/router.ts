import type { ChatRequest, ModelProvider, ModelRef, StreamEvent, TaskType } from "./types.js";
import { NoModelAvailableError, ProviderError } from "./types.js";

export interface ModelRouterOptions {
  providers: readonly ModelProvider[];
  /** Ordered candidates per task; the first available one wins. */
  routes: Partial<Record<TaskType, readonly ModelRef[]>>;
  /** Default pause for a provider after a rate limit or outage. */
  cooldownSeconds?: number;
  now?: () => number;
}

export interface ModelRouter {
  stream(task: TaskType, request: ChatRequest): AsyncGenerator<StreamEvent>;
  /** Candidates configured for a task (for diagnostics). */
  candidates(task: TaskType): readonly ModelRef[];
}

/**
 * Picks a model per task and falls back down the list when a provider fails
 * *before* producing output (rate limit, outage, bad config). Once text has
 * streamed to the user, errors propagate instead: switching models mid-answer
 * would produce a spliced, inconsistent response.
 */
export function createModelRouter(options: ModelRouterOptions): ModelRouter {
  const providers = new Map(options.providers.map((p) => [p.id, p]));
  const cooldownSeconds = options.cooldownSeconds ?? 30;
  const now = options.now ?? Date.now;
  const coolingUntil = new Map<string, number>();

  for (const [task, refs] of Object.entries(options.routes)) {
    for (const ref of refs ?? []) {
      if (!providers.has(ref.provider)) {
        throw new Error(`Route "${task}" references unknown provider "${ref.provider}".`);
      }
    }
  }

  const candidates = (task: TaskType) => options.routes[task] ?? options.routes.chat ?? [];

  return {
    candidates,
    async *stream(task, request) {
      const attempts: { provider: string; model: string; reason: string }[] = [];

      for (const ref of candidates(task)) {
        const until = coolingUntil.get(ref.provider) ?? 0;
        if (until > now()) {
          attempts.push({ ...ref, reason: "cooling down" });
          continue;
        }

        // Non-null: validated against `providers` at construction.
        const provider = providers.get(ref.provider)!;
        let produced = false;
        try {
          for await (const event of provider.streamChat(ref.model, request)) {
            if (event.type === "text") produced = true;
            yield event;
          }
          return;
        } catch (err) {
          if (produced || request.signal?.aborted) throw err;
          if (err instanceof ProviderError && err.retryable) {
            coolingUntil.set(
              ref.provider,
              now() + (err.retryAfterSeconds ?? cooldownSeconds) * 1000,
            );
          }
          attempts.push({ ...ref, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      throw new NoModelAvailableError(attempts);
    },
  };
}
