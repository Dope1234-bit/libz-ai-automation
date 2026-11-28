import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthUser } from "./auth.js";

/** Typed Hono context variables shared by all routes. */
export interface AppEnv {
  Variables: {
    requestId: string;
    user: AuthUser;
    accessToken: string;
    /** Supabase client acting as the signed-in user (RLS enforced). */
    db: SupabaseClient;
  };
}
