import type { SESError } from "./errors";

/** Long-lived or temporary AWS credentials. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Required when using temporary credentials (STS, IAM role, OIDC, ...). */
  sessionToken?: string;
}

/**
 * Supplies credentials for each attempt. Use a function to support rotating or
 * expiring credentials without recreating the client.
 */
export type CredentialsProvider = () => AwsCredentials | Promise<AwsCredentials>;

export type CredentialsInput = AwsCredentials | CredentialsProvider;

/** Controls retries and exponential backoff. */
export interface RetryOptions {
  /** Total attempts, including the first one. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff. Defaults to 100 ms. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay, before jitter. Defaults to 5000 ms. */
  maxDelayMs?: number;
  /** Apply full jitter to backoff delays. Defaults to true. */
  jitter?: boolean;
  /**
   * Overrides the default retry decision. Return `true` to retry. The client
   * still enforces `maxAttempts`, and never retries an aborted request.
   */
  retryOn?: (error: SESError, attempt: number) => boolean;
}

/** Client configuration. */
export interface SESClientConfig {
  /** AWS region, e.g. `us-east-1`. */
  region: string;
  /** Static credentials or a provider called for every attempt. */
  credentials: CredentialsInput;
  /**
   * Overrides the SES endpoint. Useful for VPC endpoints, FIPS endpoints, or
   * local proxies. A base path is supported. Defaults to
   * `https://email.<region>.amazonaws.com` (`amazonaws.com.cn` in China).
   */
  endpoint?: string;
  /**
   * Custom fetch implementation, for tests, instrumentation, or runtimes with
   * a non-standard fetch. Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
  /** Per-attempt timeout in milliseconds. Defaults to 30000. Set to 0 to disable. */
  timeoutMs?: number;
  /** Retry policy. Defaults to three attempts with exponential backoff. */
  retry?: RetryOptions | false;
  /** Tags merged into every send. Per-message tags with the same name win. */
  defaultTags?: Record<string, string>;
  /** Configuration set applied to every send unless overridden per message. */
  defaultConfigurationSetName?: string;
}

/** Per-request options for {@link SESClient.request}. */
export interface RequestOptions {
  /** Cancels waiting for a retry and aborts the in-flight request. */
  signal?: AbortSignal;
  /** Overrides the client timeout for this request. */
  timeoutMs?: number;
  /** HTTP method. Defaults to `POST`. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

/** A single custom message header. */
export interface EmailHeader {
  name: string;
  value: string;
}

/** Headers as an object or an ordered array (the array form allows duplicates). */
export type EmailHeaders = Record<string, string> | ReadonlyArray<EmailHeader>;

/** Tag values, either as an object or an ordered array. */
export type EmailTags = Record<string, string> | ReadonlyArray<{ name: string; value: string }>;

export type AttachmentDisposition = "attachment" | "inline";
export type AttachmentTransferEncoding = "base64" | "quoted-printable" | "7bit";

/**
 * An attachment. String content is UTF-8 text; binary content must be a
 * `Uint8Array` or `ArrayBuffer`. Inline attachments referenced by
 * `Content-ID` should set `contentId` and `disposition: "inline"`.
 */
export interface Attachment {
  /** File name shown by the mail client. Maximum 255 characters. */
  filename: string;
  content: string | Uint8Array | ArrayBuffer;
  /**
   * MIME type, e.g. `application/pdf`. When omitted, SES derives it from the
   * file name for native attachments; the MIME builder uses
   * `application/octet-stream`.
   */
  contentType?: string;
  /** Content-ID used by `cid:` URLs in HTML. Maximum 78 characters. */
  contentId?: string;
  /** Defaults to `attachment` (or `inline` when `contentId` is present). */
  disposition?: AttachmentDisposition;
  /** Human-readable description. Maximum 1000 characters. */
  description?: string;
  /**
   * How SES should encode the attachment in the final email. Defaults to
   * `base64`, which is safe for binary content. `7bit` requires ASCII content.
   */
  transferEncoding?: AttachmentTransferEncoding;
}

/** SES contact-list unsubscribe options. */
export interface ListManagementOptions {
  contactListName: string;
  topicName?: string;
}

/** Per-message configuration set overrides. */
export interface ConfigurationOverrides {
  tracking?: {
    /** `ENABLED` forces click tracking on; `DISABLED` turns it off for this message. */
    clickTrackingEnabled?: "ENABLED" | "DISABLED";
    /** `ENABLED` forces open tracking on; `DISABLED` turns it off for this message. */
    openTrackingEnabled?: "ENABLED" | "DISABLED";
  };
}

/** Fields shared by simple, raw, and templated messages. */
export interface EmailAddressing {
  /** Sender, e.g. `"Acme <hello@acme.com>"`. Must be a verified identity. */
  from: string;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  /** Maps to SES `ReplyToAddresses`. */
  replyTo?: string | string[];
  /** ARN of the identity authorizing use of the From address. */
  fromIdentityArn?: string;
  /** Address that receives bounce and complaint notifications. */
  feedbackForwarding?: string;
  /** ARN of the identity authorizing the feedback forwarding address. */
  feedbackForwardingIdentityArn?: string;
}

/** Options shared by all message kinds. */
export interface EmailOptions {
  configurationSetName?: string;
  tags?: EmailTags;
  listManagement?: ListManagementOptions;
  configurationOverrides?: ConfigurationOverrides;
  /** SES tenant name. */
  tenantName?: string;
  /** Multi-region endpoint id. */
  endpointId?: string;
}

/** A message that SES assembles from subject, body, and optional attachments. */
export interface SimpleEmail extends EmailAddressing, EmailOptions {
  subject: string;
  text?: string;
  html?: string;
  /** Charset for subject, text, and HTML. Defaults to `UTF-8`. */
  charset?: string;
  /** Up to 15 custom headers. Names and values must be printable ASCII. */
  headers?: EmailHeaders;
  attachments?: Attachment[];
  raw?: never;
  template?: never;
}

/** A pre-built MIME message. Use {@link buildMimeMessage} to create one. */
export interface RawEmail extends EmailAddressing, EmailOptions {
  /**
   * The complete MIME message. Strings are sent as UTF-8. `Bcc` must not be in
   * the MIME headers; pass it in `bcc` so SES adds it to the envelope only.
   */
  raw: string | Uint8Array | ArrayBuffer;
  subject?: never;
  text?: never;
  html?: never;
  charset?: never;
  headers?: never;
  attachments?: never;
  template?: never;
}

/** A stored or inline SES template. */
export interface TemplateDefinition {
  /** Name of a stored template. Cannot be combined with `arn` or `content`. */
  name?: string;
  /** ARN of a stored template. Cannot be combined with `name` or `content`. */
  arn?: string;
  /** Inline template content. Cannot be combined with `name` or `arn`. */
  content?: {
    subject: string;
    text?: string;
    html?: string;
  };
  /** Template variables as an object, or a pre-serialized JSON string. */
  data?: Record<string, unknown> | string;
  attachments?: Attachment[];
  /** Up to 15 custom headers. */
  headers?: EmailHeaders;
}

/** A templated message. */
export interface TemplateEmail extends EmailAddressing, EmailOptions {
  /** A stored template name, or a template definition. */
  template: string | TemplateDefinition;
  subject?: never;
  text?: never;
  html?: never;
  charset?: never;
  headers?: never;
  attachments?: never;
  raw?: never;
}

/** Any message accepted by {@link SESClient.sendEmail}. */
export type SendEmailInput = SimpleEmail | RawEmail | TemplateEmail;

/** Result of a successful `SendEmail` call. */
export interface SendEmailResult {
  /** SES message id. Keep it for event correlation and support requests. */
  messageId: string;
  /** SES request id, when returned. */
  requestId?: string;
  statusCode: number;
}

/** Raw result of a low-level SES API call. */
export interface SESResponse<T> {
  data: T;
  statusCode: number;
  requestId?: string;
}

/** Options for the raw MIME builder. */
export interface MimeMessageOptions {
  from: string;
  to?: string | string[];
  cc?: string | string[];
  replyTo?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Additional message headers. Bcc is intentionally not supported. */
  headers?: EmailHeaders;
  attachments?: Attachment[];
  /** Defaults to now. */
  date?: Date;
  /** Overrides the generated Message-ID. */
  messageId?: string;
}
