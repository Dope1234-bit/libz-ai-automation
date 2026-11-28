import { NextResponse } from "next/server";
import { safeNextPath } from "@/lib/safe-redirect";
import { getServerSupabase } from "@/lib/supabase/server";

/** Completes email confirmation / magic links (PKCE code exchange). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  if (code) {
    const supabase = await getServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }

  const failed = new URL("/login", url.origin);
  failed.searchParams.set("error", "That link is invalid or has expired. Please sign in.");
  return NextResponse.redirect(failed);
}
