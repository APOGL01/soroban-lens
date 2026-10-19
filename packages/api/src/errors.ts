/** Every non-2xx response carries this body. */
export interface ApiErrorBody {
  error: {
    /** Stable machine-readable code, e.g. "invalid_parameter". */
    code: string;
    message: string;
    /** Present when one specific query parameter is at fault. */
    parameter?: string;
    /**
     * Matches X-Request-Id and every structured log record for this request
     * (#46) — quote it in a bug report and it finds the whole story server-side.
     */
    requestId?: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly parameter: string | undefined;
  /** Methods to advertise in `Allow`, which RFC 9110 requires on a 405. */
  readonly allow: string | undefined;
  /** Seconds to advertise in `Retry-After` on a 429 or 503. */
  retryAfterSeconds: number | undefined;
  /** Challenge to advertise in `WWW-Authenticate`, which RFC 9110 requires on a 401. */
  wwwAuthenticate: string | undefined;

  constructor(status: number, code: string, message: string, parameter?: string, allow?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.parameter = parameter;
    this.allow = allow;
    this.retryAfterSeconds = undefined;
    this.wwwAuthenticate = undefined;
  }

  static badRequest(message: string, parameter?: string): ApiError {
    return new ApiError(400, 'invalid_parameter', message, parameter);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  /** No valid API key was presented. */
  static unauthorized(message: string): ApiError {
    const error = new ApiError(401, 'unauthorized', message);
    error.wwwAuthenticate = 'Bearer realm="soroban-lens"';
    return error;
  }

  /** The client exhausted its token bucket, with the wait before one token is available. */
  static tooManyRequests(message: string, retryAfterSeconds: number): ApiError {
    const error = new ApiError(429, 'rate_limited', message);
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
  }

  /** Temporarily unable to serve, with the wait a client should honour. */
  static unavailable(message: string, retryAfterSeconds: number): ApiError {
    const error = new ApiError(503, 'unavailable', message);
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.parameter ? { parameter: this.parameter } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}
