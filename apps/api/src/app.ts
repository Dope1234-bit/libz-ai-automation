import { buildAiFromEnv, createModelRouter } from "@jarvis/ai";
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
import { rateLimitPerUser } from "./rate-limit.js";
import type { Env } from "./env.js";
import type { ChatSettings } from "./routes/conversations.js";
import { conversationRoutes } from "./routes/conversations.js";
import { businessRoutes } from "./routes/business.js";
import { crmRoutes } from "./routes/crm.js";
import { memoryRoutes } from "./routes/memories.js";
import { meRoutes } from "./routes/me.js";
import { proposalRoutes } from "./routes/proposals.js";
import type { ProspectSettings } from "./routes/prospects.js";
import { prospectRoutes } from "./routes/prospects.js";
import { createGooglePlacesClient } from "./integrations/google-places.js";
import { systemRoutes } from "./routes/system.js";
import { invitationRoutes, workspaceRoutes } from "./routes/workspaces.js";

export { API_VERSION } from "./version.js";
import { API_VERSION } from "./version.js";

export interface AppDeps {
  verifyToken: TokenVerifier;
  createUserDb: UserDbFactory;
  /** Defaults to providers configured via AI_* environment variables. */
  chat: ChatSettings;
  /** Google Maps prospecting; defaults to GOOGLE_MAPS_API_KEY. */
  prospects: ProspectSettings;
}

/**
 * Build the HTTP application. Kept free of I/O (no `listen`) so it can be
 * exercised directly in tests via `app.request()`. Dependencies default to the
 * real Supabase-backed implementations and can be swapped in tests.
 */
export function createApp(env: Env, deps: Partial<AppDeps> = {}) {
  const verifyToken =
    deps.verifyToken ??
    createSupabaseTokenVerifier(env.SUPABASE_URL, undefined, {
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    });
  const createUserDb =
    deps.createUserDb ?? createUserDbFactory(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
  const chat: ChatSettings = deps.chat ?? {
    router: buildRouterOrDisableChat(),
    dailyTokenLimit: env.AI_DAILY_TOKEN_LIMIT,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    historyChars: env.AI_HISTORY_CHARS,
    requestsPerMinute: env.AI_REQUESTS_PER_MINUTE,
  };

  const prospects: ProspectSettings = deps.prospects ?? {
    places: env.GOOGLE_MAPS_API_KEY
      ? createGooglePlacesClient({ apiKey: env.GOOGLE_MAPS_API_KEY })
      : null,
    dailyLimit: env.GOOGLE_MAPS_DAILY_LIMIT,
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
  v1.use(
    "*",
    rateLimitPerUser({
      bucket: "writes",
      limit: env.WRITE_REQUESTS_PER_MINUTE,
      windowSeconds: 60,
      methods: ["POST", "PATCH", "PUT", "DELETE"],
    }),
  );
  v1.route("/me", meRoutes);
  v1.route("/workspaces", workspaceRoutes);
  v1.route("/invitations", invitationRoutes);
  v1.route("/", conversationRoutes(chat, prospects));
  v1.route("/", systemRoutes(chat));
  v1.route("/", memoryRoutes);
  v1.route("/", crmRoutes);
  v1.route("/", businessRoutes);
  v1.route("/", proposalRoutes);
  v1.route("/", prospectRoutes(prospects));
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

/**
 * A misconfigured AI provider (e.g. a missing key) disables chat (503) instead of
 * taking the whole API down; the reason is logged without any secret values.
 */
function buildRouterOrDisableChat() {
  try {
    return buildAiFromEnv(process.env).router;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "AI disabled: invalid AI configuration",
        err: String(err),
      }),
    );
    return createModelRouter({ providers: [], routes: {} });
  }
}

function safeCause(cause: unknown): unknown {
  if (cause && typeof cause === "object" && "code" in cause) {
    return { code: (cause as { code: unknown }).code };
  }
  return cause === undefined ? undefined : String(cause);
}
