/**
 * Public runtime configuration. These values are safe to expose to the browser:
 * the publishable key only grants what row-level security allows.
 */
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value.replace(/\/+$/, "");
}

export const config = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseKey: required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  apiUrl: required("NEXT_PUBLIC_API_URL", process.env.NEXT_PUBLIC_API_URL),
};
