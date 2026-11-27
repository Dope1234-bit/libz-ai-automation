import { buildAiFromEnv } from "@jarvis/ai";
import { AppError, ErrorCode, toErrorBody } from "@jarvis/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { TokenVerifier } from "./auth.js";
import { createSupabaseTokenVerifier, requireAuth } from "./auth.js";
import type { AppEnv } from "./context.js";
import type { UserDbFactory } from "./db.js";
import { createUserDbFactory } from "./db.js";
import type { Env } from "./env.js";
import type { ChatSettings } from "./routes/conversations.js";
import { conversationRoutes } from "./routes/conversations.js";
import { meRoutes } from "./routes/me.js";
import { invitationRoutes, workspaceRoutes } from "./routes/workspaces.js";

export const API_VERSION = "0.2.0";

export interface AppDeps {
  verifyToken: TokenVerifier;
  createUserDb: UserDbFactory;
  /** Defaults to providers configured via AI_* environment variables. */
  chat: ChatSettings;
}

/**
 * Build the HTTP application. Kept free of I/O (no `listen`) so it can be
 * exercised directly in tests via `app.request()`. Dependencies default to the
 * real Supabase-backed implementations and can be swapped in tests.
 */
export function createApp(env: Env, deps: Partial<AppDeps> = {}) {
  const verifyToken = deps.verifyToken ?? createSupabaseTokenVerifier(env.SUPABASE_URL);
  const createUserDb =
    deps.createUserDb ?? createUserDbFactory(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
  const chat: ChatSettings = deps.chat ?? {
    router: buildAiFromEnv(process.env).router,
    dailyTokenLimit: env.AI_DAILY_TOKEN_LIMIT,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    historyChars: env.AI_HISTORY_CHARS,
    requestsPerMinute: env.AI_REQUESTS_PER_MINUTE,
  };

  const app = new Hono<AppEnv>();

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

  // Everything under /v1 is authenticated and talks to Postgres as the user.
  const v1 = new Hono<AppEnv>();
  v1.use("*", requireAuth(verifyToken));
  v1.use("*", async (c, next) => {
    c.set("db", createUserDb(c.get("accessToken")));
    c.header("Cache-Control", "no-store");
    await next();
  });
  v1.route("/me", meRoutes);
  v1.route("/workspaces", workspaceRoutes);
  v1.route("/invitations", invitationRoutes);
  v1.route("/", conversationRoutes(chat));
  app.route("/v1", v1);

  app.notFound((c) => {
    const { status, body } = toErrorBody(
      new AppError(ErrorCode.NotFound, "Route not found."),
      c.get("requestId"),
    );
    return c.json(body, status as 404);
  });

  app.onError((err, c) => {
    const id = c.get("requestId");
    if (!(err instanceof AppError) || err.code === ErrorCode.Internal) {
      // Full detail stays server-side; the client receives a generic body.
      const cause = err instanceof AppError ? err.cause : err;
      console.error(
        JSON.stringify({
          level: "error",
          requestId: id,
          err: String(err),
          cause: safeCause(cause),
        }),
      );
    }
    const { status, body } = toErrorBody(err, id);
    return c.json(body, status as 500);
  });

  return app;
}

function safeCause(cause: unknown): unknown {
  if (cause && typeof cause === "object" && "code" in cause) {
    return { code: (cause as { code: unknown }).code };
  }
  return cause === undefined ? undefined : String(cause);
}
