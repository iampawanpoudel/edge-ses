import {
  SESCredentialsError,
  SESError,
  SESNetworkError,
  SESServiceError,
  SESTimeoutError,
  SESValidationError,
} from "./errors";
import { buildSendEmailRequest } from "./request";
import { signRequest } from "./sigv4";
import type {
  AwsCredentials,
  CredentialsInput,
  RequestOptions,
  RetryOptions,
  SESClientConfig,
  SESResponse,
  SendEmailInput,
  SendEmailResult,
} from "./types";
import { abortError, sleep } from "./utils";

const SEND_EMAIL_PATH = "/v2/email/outbound-emails";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5_000;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "BadGatewayException",
  "GatewayTimeoutException",
  "InternalError",
  "InternalFailure",
  "RequestTimeout",
  "RequestTimeoutException",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
]);

interface ResolvedRetry {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  retryOn?: (error: SESError, attempt: number) => boolean;
}

/**
 * Minimal Amazon SES v2 client that runs anywhere with `fetch` and Web Crypto:
 * Cloudflare Workers, Deno, Bun, Vercel/Netlify Edge, and Node 20+.
 *
 * ```ts
 * const ses = new SESClient({
 *   region: "us-east-1",
 *   credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
 * });
 *
 * await ses.sendEmail({ from: "hello@example.com", to: "user@example.com", subject: "Hi", text: "Hello" });
 * ```
 */
export class SESClient {
  private readonly region: string;
  private readonly credentials: CredentialsInput;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: ResolvedRetry;
  private readonly defaultTags?: Record<string, string>;
  private readonly defaultConfigurationSetName?: string;

  constructor(config: SESClientConfig) {
    if (!config || typeof config !== "object") {
      throw new SESValidationError("SESClient requires a configuration object");
    }

    this.region = validateRegion(config.region);
    this.credentials = normalizeCredentialsInput(config.credentials);
    this.endpoint = resolveEndpoint(config.endpoint, this.region);
    this.timeoutMs = resolveTimeout(config.timeoutMs);
    this.retry = resolveRetry(config.retry);

    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new SESValidationError(
        "fetch is not available in this runtime; provide a fetch implementation through the fetch option",
      );
    }
    this.fetchImpl = (input, init) => fetchImpl(input, init);

    this.defaultTags = config.defaultTags ? { ...config.defaultTags } : undefined;
    this.defaultConfigurationSetName = config.defaultConfigurationSetName;
  }

  /**
   * Sends a simple, raw, or templated email through `SendEmail`.
   *
   * Client-side validation runs before any network request. Retries are
   * enabled by default for throttling, transient 5xx responses, network
   * failures, and timeouts.
   */
  async sendEmail(input: SendEmailInput, options: RequestOptions = {}): Promise<SendEmailResult> {
    const body = buildSendEmailRequest(input, {
      defaultTags: this.defaultTags,
      defaultConfigurationSetName: this.defaultConfigurationSetName,
    });

    const response = await this.request<{ MessageId?: unknown }>(SEND_EMAIL_PATH, body, {
      ...options,
      method: "POST",
    });

    const messageId = response.data?.MessageId;
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new SESError("SES returned a successful response without a MessageId", {
        code: "InvalidResponse",
        statusCode: response.statusCode,
        requestId: response.requestId,
      });
    }

    return {
      messageId,
      requestId: response.requestId,
      statusCode: response.statusCode,
    };
  }

  /**
   * Escape hatch for any SES v2 REST operation, signed with the same
   * credentials, retries, timeout, and error handling.
   *
   * ```ts
   * const { data } = await ses.request("/v2/email/account", undefined, { method: "GET" });
   * const bulk = await ses.request("/v2/email/outbound-bulk-emails", { ... });
   * ```
   */
  async request<T = unknown>(
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<SESResponse<T>> {
    const requestPath = normalizeRequestPath(path);
    const method = (options.method ?? "POST").toUpperCase();
    if (method === "GET" && body !== undefined) {
      throw new SESValidationError("GET requests must not include a body");
    }
    const payload = method === "GET" ? "" : serializeBody(body);
    const maxAttempts = this.retry.maxAttempts;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this.execute<T>(requestPath, method, payload, options);
      } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        if (isAbortError(error)) throw error;

        const sesError = toSESError(error);
        if (attempt >= maxAttempts) throw sesError;

        const shouldRetry = this.retry.retryOn
          ? this.retry.retryOn(sesError, attempt)
          : sesError.retryable;
        if (!shouldRetry) throw sesError;

        const delay = computeDelay(attempt, this.retry, sesError.retryAfterMs);
        await sleep(delay, options.signal);
      }
    }
  }

  private async execute<T>(
    path: string,
    method: string,
    payload: string,
    options: RequestOptions,
  ): Promise<SESResponse<T>> {
    if (options.signal?.aborted) throw abortReason(options.signal);

    const timeoutMs = resolveTimeout(options.timeoutMs ?? this.timeoutMs);
    const url = `${this.endpoint}${path}`;
    const credentials = await this.resolveCredentials();

    const signed = await signRequest({
      method,
      url,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: payload,
      region: this.region,
      service: "ses",
      credentials,
    });

    const controller = new AbortController();
    const callerSignal = options.signal;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: signed.headers,
        body: method === "GET" ? undefined : payload,
        signal: controller.signal,
      });

      const text = await response.text();
      const requestId = getRequestId(response);

      if (!response.ok) {
        throw createServiceError(response, text, requestId);
      }

      return {
        data: parseSuccessBody<T>(text, response, requestId),
        statusCode: response.status,
        requestId,
      };
    } catch (error) {
      if (error instanceof SESError) throw error;
      if (timedOut) {
        throw new SESTimeoutError(`SES request timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      if (callerSignal?.aborted) throw abortReason(callerSignal);
      if (isAbortError(error)) throw error;
      throw new SESNetworkError(`Unable to reach SES: ${errorMessage(error)}`, {
        cause: error,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
  }

  private async resolveCredentials(): Promise<AwsCredentials> {
    if (typeof this.credentials !== "function") return this.credentials;

    let value: unknown;
    try {
      value = await this.credentials();
    } catch (error) {
      throw new SESCredentialsError("The credentials provider failed", { cause: error });
    }
    return normalizeCredentials(value);
  }
}

/** Convenience factory; equivalent to `new SESClient(config)`. */
export function createSESClient(config: SESClientConfig): SESClient {
  return new SESClient(config);
}

function validateRegion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SESValidationError("region is required");
  }
  const region = value.trim();
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new SESValidationError(`Invalid region: "${region}"`);
  }
  return region;
}

function normalizeCredentialsInput(value: unknown): CredentialsInput {
  if (typeof value === "function") return value as CredentialsInput;
  return normalizeCredentials(value);
}

function normalizeCredentials(value: unknown): AwsCredentials {
  if (!value || typeof value !== "object") {
    throw new SESCredentialsError(
      "Credentials must be an object with accessKeyId and secretAccessKey",
    );
  }
  const credentials = value as Partial<AwsCredentials>;
  if (typeof credentials.accessKeyId !== "string" || credentials.accessKeyId.trim().length === 0) {
    throw new SESCredentialsError("accessKeyId must be a non-empty string");
  }
  if (
    typeof credentials.secretAccessKey !== "string" ||
    credentials.secretAccessKey.length === 0
  ) {
    throw new SESCredentialsError("secretAccessKey must be a non-empty string");
  }
  if (
    credentials.sessionToken !== undefined &&
    (typeof credentials.sessionToken !== "string" || credentials.sessionToken.trim().length === 0)
  ) {
    throw new SESCredentialsError("sessionToken must be a non-empty string when provided");
  }

  const normalized: AwsCredentials = {
    accessKeyId: credentials.accessKeyId.trim(),
    secretAccessKey: credentials.secretAccessKey,
  };
  if (credentials.sessionToken !== undefined) {
    normalized.sessionToken = credentials.sessionToken.trim();
  }
  return normalized;
}

function resolveEndpoint(endpoint: string | undefined, region: string): string {
  const defaultSuffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  const value = endpoint?.trim() || `https://email.${region}.${defaultSuffix}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SESValidationError(`Invalid endpoint URL: "${value}"`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SESValidationError("endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new SESValidationError("endpoint must not include credentials");
  }
  if (url.search || url.hash) {
    throw new SESValidationError("endpoint must not include a query string or fragment");
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${basePath}`;
}

function resolveTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SESValidationError("timeoutMs must be a non-negative number");
  }
  return value;
}

function resolveRetry(retry: RetryOptions | false | undefined): ResolvedRetry {
  if (retry === false) {
    return {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    };
  }

  const maxAttempts = retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new SESValidationError("retry.maxAttempts must be an integer greater than 0");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new SESValidationError("retry.baseDelayMs must be a non-negative number");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new SESValidationError("retry.maxDelayMs must be a non-negative number");
  }
  if (retry?.retryOn !== undefined && typeof retry.retryOn !== "function") {
    throw new SESValidationError("retry.retryOn must be a function");
  }

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitter: retry?.jitter ?? true,
    retryOn: retry?.retryOn,
  };
}

function normalizeRequestPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new SESValidationError("request path is required");
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new SESValidationError("request path must start with a single forward slash");
  }
  if (/[\u0000-\u001F\u007F]/.test(path)) {
    throw new SESValidationError("request path must not contain control characters");
  }
  if (path.includes("#")) {
    throw new SESValidationError("request path must not contain a fragment");
  }
  return path;
}

function serializeBody(body: unknown): string {
  if (body === undefined) return "";
  try {
    const json = JSON.stringify(body);
    if (json === undefined) {
      throw new TypeError("value is not JSON-serializable");
    }
    return json;
  } catch (error) {
    throw new SESValidationError("Request body is not JSON-serializable", { cause: error });
  }
}

function parseSuccessBody<T>(text: string, response: Response, requestId?: string): T {
  if (text.trim().length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SESError("SES returned an invalid JSON response", {
      code: "InvalidResponse",
      statusCode: response.status,
      requestId,
      cause: error,
    });
  }
}

function createServiceError(
  response: Response,
  text: string,
  requestId?: string,
): SESServiceError {
  let details: unknown;
  if (text.trim().length > 0) {
    try {
      details = JSON.parse(text);
    } catch {
      details = undefined;
    }
  }

  const record = isRecord(details) ? details : undefined;
  const code =
    normalizeErrorCode(record?.__type ?? record?.code ?? record?.Code) ?? `HTTP_${response.status}`;
  const rawMessage = record?.message ?? record?.Message;
  const message =
    typeof rawMessage === "string" && rawMessage.length > 0
      ? rawMessage
      : text.trim().length > 0
        ? text.trim()
        : response.statusText || `SES request failed with status ${response.status}`;

  const retryable =
    RETRYABLE_STATUS_CODES.has(response.status) || RETRYABLE_ERROR_CODES.has(code);
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

  return new SESServiceError(`SES ${code}: ${message}`, {
    code,
    statusCode: response.status,
    requestId,
    retryable,
    retryAfterMs,
    details,
  });
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  let code = value.trim();
  const hashIndex = code.lastIndexOf("#");
  if (hashIndex !== -1) code = code.slice(hashIndex + 1);
  const colonIndex = code.lastIndexOf(":");
  if (colonIndex !== -1) code = code.slice(colonIndex + 1);
  return code || undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function computeDelay(
  attempt: number,
  retry: ResolvedRetry,
  retryAfterMs: number | undefined,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retry.maxDelayMs, retryAfterMs);
  }
  const exponential = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return retry.jitter ? Math.random() * exponential : exponential;
}

function getRequestId(response: Response): string | undefined {
  return (
    response.headers.get("x-amzn-requestid") ??
    response.headers.get("x-amz-request-id") ??
    undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSESError(error: unknown): SESError {
  if (error instanceof SESError) return error;
  return new SESNetworkError(errorMessage(error), { cause: error });
}
