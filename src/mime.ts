import {
  assertHeaderText,
  encodeHeaderText,
  formatMailbox,
  formatMailboxList,
  getAddressDomain,
} from "./address";
import { normalizeAttachment, type NormalizedAttachment } from "./attachment";
import { SESValidationError } from "./errors";
import type { EmailHeaders, MimeMessageOptions } from "./types";
import {
  bytesToBase64,
  encodeRfc3986,
  randomToken,
  stringToBase64,
  toRfc5322Date,
} from "./utils";

type Header = [name: string, value: string];
interface Part {
  headers: Header[];
  body: string;
}

const RESERVED_HEADERS = new Set([
  "bcc",
  "cc",
  "content-transfer-encoding",
  "content-type",
  "date",
  "from",
  "message-id",
  "mime-version",
  "reply-to",
  "subject",
  "to",
]);

/**
 * Builds a complete RFC 5322 / MIME message from simple inputs.
 *
 * The result is a `multipart/alternative` message when both text and HTML are
 * provided, a `multipart/related` message for inline images, and a
 * `multipart/mixed` message for attachments. Bcc is intentionally not accepted:
 * pass Bcc recipients to `sendEmail` so they stay out of the message headers.
 *
 * ```ts
 * const raw = buildMimeMessage({
 *   from: "Acme <hello@example.com>",
 *   to: "user@example.com",
 *   subject: "Invoice",
 *   text: "Attached.",
 *   attachments: [{ filename: "invoice.pdf", content: pdfBytes, contentType: "application/pdf" }],
 * });
 * await ses.sendEmail({ from: "hello@example.com", to: "user@example.com", raw });
 * ```
 */
export function buildMimeMessage(options: MimeMessageOptions): string {
  if (!options || typeof options !== "object") {
    throw new SESValidationError("buildMimeMessage requires an options object");
  }

  const from = formatMailbox(requiredString(options.from, "from"), "from");
  const to = formatMailboxList(options.to, "to");
  const cc = formatMailboxList(options.cc, "cc");
  const replyTo = formatMailboxList(options.replyTo, "replyTo");

  if (typeof options.subject !== "string") {
    throw new SESValidationError("subject is required and must be a string");
  }
  assertHeaderText(options.subject, "subject");

  const date = options.date ?? new Date();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new SESValidationError("date must be a valid Date");
  }

  const customHeaders = buildCustomHeaders(options.headers);
  if (options.attachments !== undefined && !Array.isArray(options.attachments)) {
    throw new SESValidationError("attachments must be an array");
  }
  const normalized = (options.attachments ?? []).map((attachment, index) =>
    normalizeAttachment(attachment, `attachments[${index}]`),
  );
  const inline = normalized.filter((attachment) => attachment.disposition === "inline");
  const regular = normalized.filter((attachment) => attachment.disposition !== "inline");

  let entity = buildBodyEntity(options);

  if (inline.length > 0) {
    entity = createMultipart("multipart/related", [entity, ...inline.map(attachmentPart)], {
      type: mediaType(entity),
    });
  }
  if (regular.length > 0) {
    entity = createMultipart("multipart/mixed", [entity, ...regular.map(attachmentPart)]);
  }

  const headers: Header[] = [["From", from]];
  if (to) headers.push(["To", to]);
  if (cc) headers.push(["Cc", cc]);
  if (replyTo) headers.push(["Reply-To", replyTo]);
  headers.push(["Subject", encodeHeaderText(options.subject, "subject")]);
  headers.push(["Date", toRfc5322Date(date)]);
  headers.push(["Message-ID", formatMessageId(options.messageId, options.from)]);
  headers.push(["MIME-Version", "1.0"]);
  headers.push(...customHeaders);
  headers.push(...entity.headers);

  const message = renderPart({ headers, body: entity.body });
  return message.endsWith("\r\n") ? message : `${message}\r\n`;
}

function buildBodyEntity(options: MimeMessageOptions): Part {
  const { text, html } = options;
  if (text === undefined && html === undefined) {
    throw new SESValidationError("A message requires text, html, or both");
  }
  if (text !== undefined && typeof text !== "string") {
    throw new SESValidationError("text must be a string");
  }
  if (html !== undefined && typeof html !== "string") {
    throw new SESValidationError("html must be a string");
  }

  if (text !== undefined && html !== undefined) {
    return createMultipart("multipart/alternative", [
      textPart(text, "plain"),
      textPart(html, "html"),
    ]);
  }
  if (html !== undefined) return textPart(html, "html");
  return textPart(text!, "plain");
}

function textPart(content: string, subtype: "plain" | "html"): Part {
  return {
    headers: [
      ["Content-Type", `text/${subtype}; charset=UTF-8`],
      ["Content-Transfer-Encoding", "base64"],
    ],
    body: wrapBase64(stringToBase64(content)),
  };
}

function attachmentPart(attachment: NormalizedAttachment): Part {
  const contentType = attachment.contentType ?? "application/octet-stream";
  const headers: Header[] = [
    ["Content-Type", `${contentType}; ${formatParameter("name", attachment.filename)}`],
    [
      "Content-Disposition",
      `${attachment.disposition}; ${formatParameter("filename", attachment.filename)}`,
    ],
  ];

  const encoding = attachment.transferEncoding ?? "base64";
  headers.push(["Content-Transfer-Encoding", encoding]);
  if (attachment.contentId !== undefined) {
    headers.push(["Content-ID", `<${attachment.contentId}>`]);
  }
  if (attachment.description !== undefined) {
    headers.push(["Content-Description", attachment.description]);
  }

  let body: string;
  if (encoding === "7bit") {
    body = encodeSevenBit(attachment.bytes);
  } else if (encoding === "quoted-printable") {
    body = encodeQuotedPrintable(attachment.bytes);
  } else {
    body = wrapBase64(bytesToBase64(attachment.bytes));
  }

  return { headers, body };
}

function createMultipart(
  contentType: string,
  parts: Part[],
  parameters: Record<string, string> = {},
): Part {
  const boundary = `----=_edge_ses_${randomToken(12)}`;
  const parameterString = Object.entries(parameters)
    .map(([name, value]) => `; ${name}="${value}"`)
    .join("");
  const body = renderMultipartBody(boundary, parts);

  return {
    headers: [[`Content-Type`, `${contentType}; boundary="${boundary}"${parameterString}`]],
    body,
  };
}

function renderMultipartBody(boundary: string, parts: Part[]): string {
  let body = "";
  for (const part of parts) {
    body += `--${boundary}\r\n`;
    body += renderPart(part);
    if (!body.endsWith("\r\n")) body += "\r\n";
  }
  body += `--${boundary}--\r\n`;
  return body;
}

function renderPart(part: Part): string {
  let result = "";
  for (const [name, value] of part.headers) {
    result += `${name}: ${value}\r\n`;
  }
  result += "\r\n";
  result += part.body;
  return result;
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += 76) {
    lines.push(value.slice(offset, offset + 76));
  }
  return lines.join("\r\n");
}

function mediaType(part: Part): string {
  const contentType = part.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
  return contentType?.split(";")[0]?.trim() || "text/plain";
}

function formatParameter(name: string, value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) {
    return `${name}="${escapeQuoted(value)}"`;
  }
  const fallback = value
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `${name}="${fallback}"; ${name}*=UTF-8''${encodeRfc3986(value)}`;
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildCustomHeaders(input: EmailHeaders | undefined): Header[] {
  if (input === undefined) return [];

  const entries: Array<{ name: unknown; value: unknown }> = Array.isArray(input)
    ? input.map((header) => ({ name: header?.name, value: header?.value }))
    : Object.entries(input as Record<string, string>).map(([name, value]) => ({ name, value }));

  return entries.map(({ name, value }, index): Header => {
    if (typeof name !== "string") {
      throw new SESValidationError(`headers[${index}].name must be a string`);
    }
    const headerName = name.trim();
    if (!/^[\x21-\x39\x3B-\x7E]+$/.test(headerName)) {
      throw new SESValidationError(
        `headers[${index}].name must be printable ASCII characters other than ":"`,
      );
    }
    if (RESERVED_HEADERS.has(headerName.toLowerCase())) {
      throw new SESValidationError(
        `headers[${index}].name "${headerName}" is managed by buildMimeMessage and cannot be overridden`,
      );
    }
    if (typeof value !== "string") {
      throw new SESValidationError(`headers[${index}].value must be a string`);
    }
    if (!/^[ -~]*$/.test(value) || value.length > 998) {
      throw new SESValidationError(
        `headers[${index}].value must be printable ASCII and at most 998 characters`,
      );
    }
    return [headerName, value];
  });
}

function formatMessageId(input: string | undefined, from: string): string {
  if (input === undefined) {
    return `<${randomToken(16)}@${getAddressDomain(from)}>`;
  }
  if (typeof input !== "string") {
    throw new SESValidationError("messageId must be a string");
  }
  assertHeaderText(input, "messageId");
  let value = input.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1);
  }
  if (!/^[^\s<>@]+@[^\s<>]+$/.test(value)) {
    throw new SESValidationError(`Invalid Message-ID: "${input}"`);
  }
  return `<${value}>`;
}

function encodeSevenBit(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    for (const byte of chunk) {
      if (byte > 0x7f) {
        throw new SESValidationError("7bit attachment content must contain only ASCII");
      }
    }
    result += String.fromCharCode(...chunk);
  }
  return result;
}

const QP_HEX = Array.from({ length: 256 }, (_, value) =>
  `=${value.toString(16).toUpperCase().padStart(2, "0")}`,
);

function encodeQuotedPrintable(bytes: Uint8Array): string {
  let result = "";
  let lineLength = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    let token: string;

    if (byte === 32) {
      token = "=20";
    } else if (byte === 9) {
      token = "=09";
    } else if ((byte >= 33 && byte <= 60) || (byte >= 62 && byte <= 126)) {
      token = String.fromCharCode(byte);
    } else {
      token = QP_HEX[byte]!;
    }

    if (lineLength + token.length > 72) {
      result += "=\r\n";
      lineLength = 0;
    }
    result += token;
    lineLength += token.length;
  }

  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SESValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}
