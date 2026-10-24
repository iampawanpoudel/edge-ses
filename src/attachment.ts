import { assertHeaderText } from "./address";
import { SESValidationError } from "./errors";
import type { Attachment, AttachmentDisposition, AttachmentTransferEncoding } from "./types";
import { toBytes } from "./utils";

export interface NormalizedAttachment {
  filename: string;
  bytes: Uint8Array;
  contentType?: string;
  contentId?: string;
  disposition: AttachmentDisposition;
  description?: string;
  transferEncoding?: AttachmentTransferEncoding;
}

const TRANSFER_ENCODINGS = new Set<AttachmentTransferEncoding>([
  "base64",
  "quoted-printable",
  "7bit",
]);

/** Validates and normalizes one attachment. `field` is used in error messages. */
export function normalizeAttachment(attachment: Attachment, field: string): NormalizedAttachment {
  if (!attachment || typeof attachment !== "object") {
    throw new SESValidationError(`${field} must be an object`);
  }

  if (typeof attachment.filename !== "string") {
    throw new SESValidationError(`${field}.filename must be a string`);
  }
  assertHeaderText(attachment.filename, `${field}.filename`);
  if (attachment.filename.length === 0 || attachment.filename.length > 255) {
    throw new SESValidationError(`${field}.filename must be 1-255 characters`);
  }

  let bytes: Uint8Array;
  try {
    bytes = toBytes(attachment.content);
  } catch {
    throw new SESValidationError(
      `${field}.content must be a string, Uint8Array, or ArrayBuffer`,
    );
  }

  let contentType: string | undefined;
  if (attachment.contentType !== undefined) {
    if (typeof attachment.contentType !== "string") {
      throw new SESValidationError(`${field}.contentType must be a string`);
    }
    assertHeaderText(attachment.contentType, `${field}.contentType`);
    contentType = attachment.contentType.trim();
    if (contentType.length === 0 || contentType.length > 78) {
      throw new SESValidationError(`${field}.contentType must be 1-78 characters`);
    }
    if (!/^[\x20-\x7E]+$/.test(contentType)) {
      throw new SESValidationError(`${field}.contentType must be printable ASCII`);
    }
  }

  let contentId: string | undefined;
  if (attachment.contentId !== undefined) {
    if (typeof attachment.contentId !== "string") {
      throw new SESValidationError(`${field}.contentId must be a string`);
    }
    assertHeaderText(attachment.contentId, `${field}.contentId`);
    contentId = attachment.contentId.trim();
    if (contentId.startsWith("<") && contentId.endsWith(">")) {
      contentId = contentId.slice(1, -1);
    }
    if (contentId.length === 0 || contentId.length > 78) {
      throw new SESValidationError(`${field}.contentId must be 1-78 characters`);
    }
    if (/[\s<>]/.test(contentId)) {
      throw new SESValidationError(`${field}.contentId must not contain whitespace or angle brackets`);
    }
  }

  let disposition: AttachmentDisposition;
  if (attachment.disposition !== undefined) {
    if (typeof attachment.disposition !== "string") {
      throw new SESValidationError(`${field}.disposition must be "attachment" or "inline"`);
    }
    const normalized = attachment.disposition.toLowerCase();
    if (normalized !== "attachment" && normalized !== "inline") {
      throw new SESValidationError(`${field}.disposition must be "attachment" or "inline"`);
    }
    disposition = normalized;
  } else {
    disposition = contentId !== undefined ? "inline" : "attachment";
  }

  let description: string | undefined;
  if (attachment.description !== undefined) {
    if (
      typeof attachment.description !== "string" ||
      attachment.description.length === 0 ||
      attachment.description.length > 1000
    ) {
      throw new SESValidationError(`${field}.description must be 1-1000 characters`);
    }
    assertHeaderText(attachment.description, `${field}.description`);
    description = attachment.description;
  }

  let transferEncoding: AttachmentTransferEncoding | undefined;
  if (attachment.transferEncoding !== undefined) {
    if (
      typeof attachment.transferEncoding !== "string" ||
      !TRANSFER_ENCODINGS.has(attachment.transferEncoding.toLowerCase() as AttachmentTransferEncoding)
    ) {
      throw new SESValidationError(
        `${field}.transferEncoding must be base64, quoted-printable, or 7bit`,
      );
    }
    transferEncoding = attachment.transferEncoding.toLowerCase() as AttachmentTransferEncoding;
  }

  const normalized: NormalizedAttachment = {
    filename: attachment.filename,
    bytes,
    disposition,
  };
  if (contentType !== undefined) normalized.contentType = contentType;
  if (contentId !== undefined) normalized.contentId = contentId;
  if (description !== undefined) normalized.description = description;
  if (transferEncoding !== undefined) normalized.transferEncoding = transferEncoding;
  return normalized;
}
