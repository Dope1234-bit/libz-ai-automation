import { createApp, loadEnv } from "@jarvis/api";

/**
 * Serves the Sir Libz API from the web app under /api (e.g. /api/v1/me), so a
 * single deployment hosts both on one origin. The API itself is unchanged; this
 * only strips the /api prefix. Created lazily so builds need no server config.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Streaming chat replies can take a while.
export const maxDuration = 60;

let app: ReturnType<typeof createApp> | undefined;

async function handle(request: Request): Promise<Response> {
  app ??= createApp(loadEnv());
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return app.fetch(
    new Request(url, {
      method: request.method,
      headers: request.headers,
      // Not forwarding request.signal: Next aborts it once the handler returns,
      // which would cut every streamed reply short. Client disconnects still
      // cancel the response stream.
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
    } as RequestInit),
  );
}

export { handle as DELETE, handle as GET, handle as OPTIONS, handle as PATCH, handle as POST };
