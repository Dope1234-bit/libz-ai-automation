import { parseEnv } from "@jarvis/shared";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Comma-separated list of browser origins allowed to call the API. */
  WEB_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
  /** Base URL of the Supabase project, e.g. http://127.0.0.1:54321 locally. */
  SUPABASE_URL: z.url().transform((value) => value.replace(/\/+$/, "")),
  /**
   * Publishable (anon) key. The API calls Supabase *as the signed-in user* with
   * this key plus the user's JWT, so Postgres row-level security applies to
   * every query. The service-role/secret key is deliberately not used here.
   */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  /** Tokens (input + output) each user may spend per UTC day. */
  AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(200_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(32_000).default(2048),
  /** Characters of conversation history sent to the model per request. */
  AI_HISTORY_CHARS: z.coerce.number().int().min(1000).max(500_000).default(24_000),
  AI_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return parseEnv(envSchema, source);
}
