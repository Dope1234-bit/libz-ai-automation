import { AppError, ErrorCode, toErrorBody } from "@jarvis/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./env.js";

export const API_VERSION = "0.0.0";

/**
 * Build the HTTP application. Kept free of I/O (no `listen`) so it can be
 * exercised directly in tests via `app.request()`.
 */
export function createApp(env: Env) {
  const app = new Hono();

  app.use("*", requestId());
  app.use(
    "*",
    secureHeaders({
      // The API serves JSON only, so lock the CSP down completely.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      xFrameOptions: "DENY",
    }),
  );
  app.use(
    "*",
    cors({
      origin: (origin) => (env.WEB_ORIGINS.includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024, // 1 MiB; file uploads go direct to storage, not through the API.
      onError: () => {
        throw new AppError(ErrorCode.BadRequest, "Request body too large.");
      },
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok", version: API_VERSION }));

  app.notFound((c) => {
    const { status, body } = toErrorBody(
      new AppError(ErrorCode.NotFound, "Route not found."),
      c.get("requestId"),
    );
    return c.json(body, status as 404);
  });

  app.onError((err, c) => {
    const id = c.get("requestId");
    if (!(err instanceof AppError)) {
      // Log full detail server-side only; the client receives a generic body.
      console.error(JSON.stringify({ level: "error", requestId: id, err: String(err) }));
    }
    const { status, body } = toErrorBody(err, id);
    return c.json(body, status as 500);
  });

  return app;
}
