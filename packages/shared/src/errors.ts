/**
 * Stable, client-safe error codes. Clients branch on `code`; human-readable
 * messages may change. Internal details are never exposed through these.
 */
export const ErrorCode = {
  BadRequest: "bad_request",
  Unauthenticated: "unauthenticated",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  RateLimited: "rate_limited",
  QuotaExceeded: "quota_exceeded",
  Internal: "internal_error",
  Unavailable: "unavailable",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  internal_error: 500,
  unavailable: 503,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
  };
}

/** An expected, client-facing application error. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Convert any thrown value into a safe response body. Unknown errors collapse
 * to a generic internal error so stack traces and internals never leak.
 */
export function toErrorBody(err: unknown, requestId?: string): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        error: { code: err.code, message: err.message, ...(requestId ? { requestId } : {}) },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: ErrorCode.Internal,
        message: "An unexpected error occurred.",
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}
