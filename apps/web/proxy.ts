import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { config as appConfig } from "./lib/config";

/**
 * Runs before every page request:
 * 1. Issues a fresh CSP nonce, so only scripts Next.js renders can execute.
 * 2. Refreshes the Supabase session cookie and verifies the user's JWT.
 * 3. Keeps signed-out users out of /app and signed-in users out of /login.
 */
export async function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Sir Libz's voice is played from in-memory audio (blob:) fetched from our API.
    "media-src 'self' blob: data:",
    // A relative API URL (same-origin /api) is already covered by 'self'.
    `connect-src 'self'${appConfig.apiUrl.startsWith("http") ? ` ${appConfig.apiUrl}` : ""} ${appConfig.supabaseUrl}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only meaningful (and only safe) when the site itself is served over HTTPS.
    ...(request.nextUrl.protocol === "https:" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(appConfig.supabaseUrl, appConfig.supabaseKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims() verifies the JWT signature (via the project's JWKS); never trust
  // an unverified session cookie for access decisions.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  let redirect: URL | null = null;
  if (!signedIn && pathname.startsWith("/app")) {
    redirect = new URL("/login", request.url);
    redirect.searchParams.set("next", `${pathname}${search}`);
  } else if (signedIn && pathname === "/login") {
    redirect = new URL("/app", request.url);
  }
  if (redirect) {
    const redirectResponse = NextResponse.redirect(redirect);
    for (const cookie of response.cookies.getAll()) redirectResponse.cookies.set(cookie);
    response = redirectResponse;
  }

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Pages only: not static assets, and not /api (the API checks its own auth).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
