import { AppError, ErrorCode } from "@jarvis/shared";
import type { MiddlewareHandler } from "hono";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import type { AppEnv } from "./context.js";

export interface AuthUser {
  id: string;
  email: string | null;
  /** Authenticator assurance level: `aal1` (password) or `aal2` (MFA verified). */
  aal: "aal1" | "aal2";
  sessionId: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

// Tokens signed with asymmetric keys are verified locally against the JWKS. We
// never verify an HS* token ourselves (no shared secret is held, which also rules
// out algorithm-confusion attacks); projects still on a legacy shared secret are
// validated by asking Supabase Auth instead.
const ASYMMETRIC_ALGORITHMS = ["ES256", "RS256", "EdDSA"];

export interface TokenVerifierOptions {
  /** Enables server-side validation of legacy HS256 tokens via Supabase Auth. */
  publishableKey?: string;
  fetch?: typeof fetch;
}

const unauthenticated = () =>
  new AppError(ErrorCode.Unauthenticated, "Invalid or expired access token.");

function toAuthUser(payload: JWTPayload): AuthUser {
  if (payload.role !== "authenticated" || typeof payload.sub !== "string") {
    throw unauthenticated();
  }
  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    aal: payload.aal === "aal2" ? "aal2" : "aal1",
    sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
  };
}

/**
 * Verify Supabase access tokens. Asymmetric tokens are checked locally against
 * the project's published JWKS (keys cached; unknown `kid`s trigger a
 * rate-limited refetch, so key rotation works without restarts).
 */
export function createSupabaseTokenVerifier(
  supabaseUrl: string,
  keys: JWTVerifyGetKey = createRemoteJWKSet(
    new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
  ),
  options: TokenVerifierOptions = {},
): TokenVerifier {
  const issuer = `${supabaseUrl}/auth/v1`;
  const doFetch = options.fetch ?? fetch;

  return async (token) => {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw unauthenticated();
    }

    if (alg && ASYMMETRIC_ALGORITHMS.includes(alg)) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer,
          audience: "authenticated",
          algorithms: ASYMMETRIC_ALGORITHMS,
          requiredClaims: ["sub", "exp"],
        });
        return toAuthUser(payload);
      } catch (err) {
        if (err instanceof joseErrors.JOSEError) throw unauthenticated();
        throw err;
      }
    }

    if (alg === "HS256" && options.publishableKey) {
      // Supabase Auth checks the signature, expiry and session for us.
      const res = await doFetch(`${issuer}/user`, {
        headers: { apikey: options.publishableKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!res?.ok) throw unauthenticated();
      const user = (await res.json().catch(() => null)) as { id?: unknown } | null;
      // Safe to read the claims now that Auth has validated the token.
      const payload = decodeJwt(token);
      if (!user || user.id !== payload.sub) throw unauthenticated();
      return toAuthUser(payload);
    }

    throw unauthenticated();
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
