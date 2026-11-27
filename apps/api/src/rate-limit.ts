import { AppError, ErrorCode } from "@jarvis/shared";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context.js";

export interface RateLimitOptions {
  /** Requests allowed per window, per user. */
  limit: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Per-user fixed-window rate limiter (in memory). Suitable for a single API
 * instance; Milestone 1.6 moves this to a shared store for horizontal scaling.
 * Must run after `requireAuth`.
 */
export function rateLimitPerUser(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  return async (c, next) => {
    const key = c.get("user").id;
    const t = now();
    let entry = windows.get(key);
    if (!entry || t - entry.start >= options.windowMs) {
      entry = { start: t, count: 0 };
      windows.set(key, entry);
      // Opportunistic cleanup so the map cannot grow without bound.
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (t - v.start >= options.windowMs) windows.delete(k);
      }
    }
    entry.count += 1;
    if (entry.count > options.limit) {
      c.header("Retry-After", String(Math.ceil((entry.start + options.windowMs - t) / 1000)));
      throw new AppError(ErrorCode.RateLimited, "Too many requests. Please slow down.");
    }
    await next();
  };
}
