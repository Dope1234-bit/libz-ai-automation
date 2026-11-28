import { ProviderError } from "./types.js";

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.min((date - Date.now()) / 1000, 3600));
}

/**
 * Turn a failed provider response into a ProviderError. The body is drained but
 * never surfaced: provider errors can echo request content.
 */
export async function providerHttpError(
  provider: string,
  response: Response,
): Promise<ProviderError> {
  const status = response.status;
  await response.body?.cancel().catch(() => undefined);
  return new ProviderError(provider, `Model provider returned HTTP ${status}.`, {
    status,
    // 404: model retired or not offered to this account; another model may work.
    retryable: status === 404 || status === 408 || status === 429 || status >= 500,
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
  });
}

export interface Timeouts {
  /** Give up if the provider has not started responding by then (overloaded models often stall). */
  firstByteMs: number;
  /** Hard cap for the whole streamed response. */
  totalMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = { firstByteMs: 20_000, totalMs: 120_000 };

/**
 * fetch() with a first-byte timeout and an overall timeout. A stall before the
 * response headers arrive becomes a retryable ProviderError, so the router can
 * move on to the next model quickly.
 */
export async function fetchWithTimeouts(
  provider: string,
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeouts: Timeouts,
): Promise<Response> {
  const firstByte = new AbortController();
  const timer = setTimeout(() => firstByte.abort(), timeouts.firstByteMs);
  const signals = [AbortSignal.timeout(timeouts.totalMs), firstByte.signal];
  if (callerSignal) signals.push(callerSignal);
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (err) {
    if (callerSignal?.aborted) throw err;
    const stalled = firstByte.signal.aborted;
    throw new ProviderError(
      provider,
      stalled
        ? "Model provider did not respond in time."
        : "Network error contacting model provider.",
      { retryable: true, cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}
