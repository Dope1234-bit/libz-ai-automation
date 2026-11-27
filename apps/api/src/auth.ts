import { AppError, ErrorCode } from "@jarvis/shared";
import type { MiddlewareHandler } from "hono";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { AppEnv } from "./context.js";

export interface AuthUser {
  id: string;
  email: string | null;
  /** Authenticator assurance level: `aal1` (password) or `aal2` (MFA verified). */
  aal: "aal1" | "aal2";
  sessionId: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

// Only asymmetric algorithms: a shared-secret (HS*) token is never accepted, which
// rules out algorithm-confusion attacks and means the API holds no signing secret.
const ALLOWED_ALGORITHMS = ["ES256", "RS256", "EdDSA"];

/**
 * Verify Supabase access tokens locally against the project's published JWKS.
 * Keys are fetched once and cached; unknown `kid`s trigger a (rate-limited) refetch,
 * so key rotation works without restarts.
 */
export function createSupabaseTokenVerifier(
  supabaseUrl: string,
  keys: JWTVerifyGetKey = createRemoteJWKSet(
    new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
  ),
): TokenVerifier {
  const issuer = `${supabaseUrl}/auth/v1`;

  return async (token) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: "authenticated",
        algorithms: ALLOWED_ALGORITHMS,
        requiredClaims: ["sub", "exp"],
      }));
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) {
        throw new AppError(ErrorCode.Unauthenticated, "Invalid or expired access token.");
      }
      throw err;
    }

    if (payload.role !== "authenticated" || typeof payload.sub !== "string") {
      throw new AppError(ErrorCode.Unauthenticated, "Invalid or expired access token.");
    }

    return {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      aal: payload.aal === "aal2" ? "aal2" : "aal1",
      sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
    };
  };
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/** Require a valid bearer token; exposes `user` and the raw `accessToken` on the context. */
export function requireAuth(verify: TokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = BEARER.exec(c.req.header("Authorization") ?? "");
    if (!match?.[1]) {
      throw new AppError(ErrorCode.Unauthenticated, "Authentication required.");
    }
    c.set("user", await verify(match[1]));
    c.set("accessToken", match[1]);
    await next();
  };
}
