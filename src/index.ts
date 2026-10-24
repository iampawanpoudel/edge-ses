export { createSESClient, SESClient } from "./client";
export {
  isRetryableError,
  SESCredentialsError,
  SESError,
  SESNetworkError,
  SESServiceError,
  SESTimeoutError,
  SESValidationError,
} from "./errors";
export { buildMimeMessage } from "./mime";
export { signRequest } from "./sigv4";

export type { SESErrorOptions } from "./errors";
export type { SignedRequest, SigV4Options } from "./sigv4";
export type {
  Attachment,
  AttachmentDisposition,
  AttachmentTransferEncoding,
  AwsCredentials,
  ConfigurationOverrides,
  CredentialsInput,
  CredentialsProvider,
  EmailAddressing,
  EmailHeader,
  EmailHeaders,
  EmailOptions,
  EmailTags,
  ListManagementOptions,
  MimeMessageOptions,
  RawEmail,
  RequestOptions,
  RetryOptions,
  SendEmailInput,
  SendEmailResult,
  SESClientConfig,
  SESResponse,
  SimpleEmail,
  TemplateDefinition,
  TemplateEmail,
} from "./types";
