import { AppError, ErrorCode } from "@jarvis/shared";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "./context.js";

export interface RateLimitOptions {
  /** Counter name, e.g. "chat" or "writes". */
  bucket: string;
  /** Requests allowed per window, per user. */
  limit: number;
  windowSeconds: number;
  /** Only count these HTTP methods (default: all). */
  methods?: readonly string[];
}

const resultSchema = z.object({
  allowed: z.boolean(),
  retry_after_seconds: z.number().int().positive(),
});

/**
 * Per-user fixed-window rate limit shared by every API instance (counters in
 * Postgres via `consume_rate_limit`). Must run after `requireAuth` and the db
 * middleware. If the counter cannot be read the request is allowed and the
 * failure logged: the daily AI token quota still bounds spend.
 */
export function rateLimitPerUser(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (options.methods && !options.methods.includes(c.req.method)) return next();
    // Promise.resolve().then also turns a synchronous throw into a fail-open result.
    const { data, error } = await Promise.resolve()
      .then(() =>
        c.get("db").rpc("consume_rate_limit", {
          p_bucket: options.bucket,
          p_limit: options.limit,
          p_window_seconds: options.windowSeconds,
        }),
      )
      .then(
        (r: { data: unknown; error: { code?: string } | null }) => r,
        () => ({ data: null, error: { code: "exception" } }),
      );
    const parsed = resultSchema.safeParse(data);
    if (error || !parsed.success) {
      console.error(
        JSON.stringify({
          level: "error",
          requestId: c.get("requestId"),
          msg: "rate limit check failed; allowing request",
          code: error?.code,
        }),
      );
      return next();
    }
    if (!parsed.data.allowed) {
      c.header("Retry-After", String(parsed.data.retry_after_seconds));
      throw new AppError(ErrorCode.RateLimited, "Too many requests. Please slow down.");
    }
    return next();
  };
}
