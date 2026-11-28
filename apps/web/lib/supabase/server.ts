import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { config } from "../config";

/** Server-side Supabase client bound to the request's auth cookies. */
export async function getServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(config.supabaseUrl, config.supabaseKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only; the
          // proxy refreshes sessions, so this is safe to ignore.
        }
      },
    },
  });
}
