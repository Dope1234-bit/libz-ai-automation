import { AppError, ErrorCode } from "@jarvis/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";

export type UserDbFactory = (accessToken: string) => SupabaseClient;

/**
 * Build a per-request Supabase client that acts as the signed-in user. Postgres
 * row-level security therefore enforces tenant isolation on every query, in
 * addition to the API's own checks.
 */
export function createUserDbFactory(supabaseUrl: string, publishableKey: string): UserDbFactory {
  return (accessToken) =>
    createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

/**
 * Translate database errors into client-safe application errors. Messages from
 * our own functions (raised with known SQLSTATEs) are safe to surface; anything
 * else becomes a generic internal error.
 */
export function toAppError(error: PostgrestLikeError): AppError {
  switch (error.code) {
    case "42501": // insufficient_privilege (RLS / function guard)
      return new AppError(ErrorCode.Forbidden, "You do not have permission to do that.");
    case "28000": // invalid_authorization_specification
    case "PGRST301":
    case "PGRST303":
      return new AppError(ErrorCode.Unauthenticated, "Authentication required.");
    case "P0002": // no_data_found (e.g. invalid invitation)
      return new AppError(ErrorCode.NotFound, error.message ?? "Not found.");
    case "P0001": // raise_exception: business-rule violation from our functions
      return new AppError(ErrorCode.BadRequest, error.message ?? "Request not allowed.");
    case "23505": // unique_violation
      return new AppError(ErrorCode.Conflict, "That already exists.");
    case "23514": // check_violation
    case "22P02": // invalid_text_representation
      return new AppError(ErrorCode.BadRequest, "Invalid input.");
    default:
      return new AppError(ErrorCode.Internal, "Database request failed.", { cause: error });
  }
}

/** Unwrap a Supabase response, throwing a mapped AppError on failure. */
export function unwrap<T>(result: { data: T | null; error: PostgrestLikeError | null }): T {
  if (result.error) throw toAppError(result.error);
  if (result.data === null) {
    throw new AppError(ErrorCode.Internal, "Database returned no data.");
  }
  return result.data;
}

/** Like `unwrap`, for queries where "no row" is a valid answer (e.g. `maybeSingle`). */
export function unwrapMaybe<T>(result: {
  data: T | null;
  error: PostgrestLikeError | null;
}): T | null {
  if (result.error) throw toAppError(result.error);
  return result.data;
}
