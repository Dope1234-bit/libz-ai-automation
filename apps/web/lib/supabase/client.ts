"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

let client: SupabaseClient | undefined;

/** Browser Supabase client (auth only; data goes through the Jarvis API). */
export function getSupabase(): SupabaseClient {
  client ??= createBrowserClient(config.supabaseUrl, config.supabaseKey);
  return client;
}
