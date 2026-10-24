/** Options shared by every error thrown by edge-ses. */
export interface SESErrorOptions {
  /** Machine-readable error code, e.g. `MessageRejected` or `ValidationError`. */
  code?: string;
  /** HTTP status returned by SES, when available. */
  statusCode?: number;
  /** SES request id, useful when contacting AWS support. */
  requestId?: string;
  /** Whether the operation can safely be attempted again. */
  retryable?: boolean;
  /** Delay requested by SES through the `Retry-After` header. */
  retryAfterMs?: number;
  /** Parsed error payload from SES, when the response was JSON. */
  details?: unknown;
  /** Original error, for network failures and wrapped provider errors. */
  cause?: unknown;
}

/**
 * Base class for every error thrown by this package.
 *
 * Service errors are instances of {@link SESServiceError}; client-side
 * validation failures use {@link SESValidationError}.
 */
export class SESError extends Error {
  /** Machine-readable error code. */
  readonly code: string;
  /** HTTP status returned by SES, when available. */
  readonly statusCode?: number;
  /** SES request id, useful when contacting AWS support. */
  readonly requestId?: string;
  /** Whether the operation can safely be attempted again. */
  readonly retryable: boolean;
  /** Delay requested by SES through the `Retry-After` header. */
  readonly retryAfterMs?: number;
  /** Parsed error payload from SES, when the response was JSON. */
  readonly details?: unknown;

  constructor(message: string, options: SESErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SESError";
    this.code = options.code ?? "SESError";
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

/** Thrown before a request is sent when the input is invalid. */
export class SESValidationError extends SESError {
  constructor(message: string, options: SESErrorOptions = {}) {
    super(message, {
      code: "ValidationError",
      retryable: false,
      ...options,
    });
    this.name = "SESValidationError";
  }
}

/** Thrown when SES answers with a non-2xx response. */
export class SESServiceError extends SESError {
  constructor(message: string, options: SESErrorOptions = {}) {
    super(message, {
      retryable: false,
      ...options,
    });
    this.name = "SESServiceError";
  }
}

/** Thrown when the request could not reach SES (DNS, TLS, connection reset, ...). */
export class SESNetworkError extends SESError {
  constructor(message: string, options: SESErrorOptions = {}) {
    super(message, {
      code: "NetworkError",
      retryable: true,
      ...options,
    });
    this.name = "SESNetworkError";
  }
}

/** Thrown when the request exceeded the configured timeout. */
export class SESTimeoutError extends SESError {
  constructor(message: string, options: SESErrorOptions = {}) {
    super(message, {
      code: "TimeoutError",
      retryable: true,
      ...options,
    });
    this.name = "SESTimeoutError";
  }
}

/** Thrown when credentials are missing, malformed, or the provider fails. */
export class SESCredentialsError extends SESError {
  constructor(message: string, options: SESErrorOptions = {}) {
    super(message, {
      code: "CredentialsError",
      retryable: false,
      ...options,
    });
    this.name = "SESCredentialsError";
  }
}

/** Narrows an unknown thrown value to a retryable edge-ses error. */
export function isRetryableError(error: unknown): error is SESError {
  return error instanceof SESError && error.retryable;
}
