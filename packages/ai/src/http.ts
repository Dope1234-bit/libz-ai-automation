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

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
