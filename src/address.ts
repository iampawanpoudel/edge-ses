import { SESValidationError } from "./errors";
import { bytesToBase64, utf8Encode } from "./utils";

const EMAIL_PATTERN = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export interface Mailbox {
  /** Display name without surrounding quotes, if one was provided. */
  name?: string;
  email: string;
}

/**
 * Splits a comma-separated address list without breaking quoted display names
 * or angle-bracket addresses. Empty entries are dropped.
 */
export function splitAddressList(
  value: string | readonly string[] | undefined,
  field = "recipients",
): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string" && !Array.isArray(value)) {
    throw new SESValidationError(`${field} must be a string or an array of strings`);
  }

  const rawValues = typeof value === "string" ? [value] : value;
  const result: string[] = [];

  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      throw new SESValidationError(`${field} must contain only strings`);
    }

    let current = "";
    let inQuotes = false;
    let angleDepth = 0;
    let escaped = false;

    for (const character of rawValue) {
      if (escaped) {
        current += character;
        escaped = false;
        continue;
      }
      if (character === "\\" && inQuotes) {
        current += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        inQuotes = !inQuotes;
        current += character;
        continue;
      }
      if (!inQuotes && character === "<") angleDepth += 1;
      if (!inQuotes && character === ">" && angleDepth > 0) angleDepth -= 1;
      if (character === "," && !inQuotes && angleDepth === 0) {
        addAddress(result, current);
        current = "";
        continue;
      }
      current += character;
    }

    if (inQuotes) {
      throw new SESValidationError(`${field} contains an unterminated quoted display name`);
    }
    if (angleDepth !== 0) {
      throw new SESValidationError(`${field} contains an unterminated angle-bracket address`);
    }
    addAddress(result, current);
  }

  return result;
}

function addAddress(result: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed) result.push(trimmed);
}

/**
 * Parses `Name <email>` or a bare address. Throws a validation error for
 * malformed input, header-injection attempts, or unsupported address syntax.
 */
export function parseMailbox(value: string, field = "address"): Mailbox {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SESValidationError(`${field} must not be empty`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new SESValidationError(`${field} must not contain control characters`);
  }

  let name: string | undefined;
  let email = trimmed;
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");

  if (open !== -1 || close !== -1) {
    if (open === -1 || close === -1 || close < open) {
      throw new SESValidationError(`${field} contains an invalid angle-bracket address: "${value}"`);
    }
    if (trimmed.slice(close + 1).trim() !== "") {
      throw new SESValidationError(`${field} contains unexpected text after ">": "${value}"`);
    }
    const displayName = trimmed.slice(0, open).trim();
    email = trimmed.slice(open + 1, close).trim();
    if (displayName) name = unquoteDisplayName(displayName);
  }

  if (!EMAIL_PATTERN.test(email)) {
    throw new SESValidationError(`${field} must be a valid email address, received "${value}"`);
  }

  return name === undefined ? { email } : { name, email };
}

function unquoteDisplayName(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([\\"])/g, "$1");
  }
  return value;
}

/** Validates every address in a list and returns the trimmed originals. */
export function validateAddressList(
  value: string | readonly string[] | undefined,
  field = "recipients",
): string[] {
  return splitAddressList(value, field).map((address) => {
    parseMailbox(address, field);
    return address;
  });
}

/** Formats one address with an RFC 2047-encoded display name when needed. */
export function formatMailbox(value: string, field = "address"): string {
  const { name, email } = parseMailbox(value, field);
  if (!name) return email;
  return `${encodeDisplayName(name)} <${email}>`;
}

/** Formats a list of addresses for a MIME header. */
export function formatMailboxList(
  value: string | readonly string[] | undefined,
  field = "recipients",
): string {
  return splitAddressList(value, field)
    .map((address) => formatMailbox(address, field))
    .join(", ");
}

/**
 * Encodes a subject or other unstructured header. ASCII values pass through;
 * non-ASCII values become RFC 2047 encoded words folded onto continuation lines.
 */
export function encodeHeaderText(value: string, field = "header"): string {
  assertHeaderText(value, field);
  if (isAscii(value)) return value;
  return encodeWords(value).join("\r\n ");
}

/**
 * Encodes a display name. ASCII names are quoted, non-ASCII names use RFC 2047
 * encoded words.
 */
export function encodeDisplayName(value: string): string {
  assertHeaderText(value, "display name");
  if (!isAscii(value)) return encodeWords(value).join(" ");
  if (!/[()<>[\]\\:;@,."]/.test(value) && value.trim() === value && !value.includes("=?")) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Returns the domain used for a generated Message-ID. */
export function getAddressDomain(value: string): string {
  const { email } = parseMailbox(value);
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1);
  return /^[A-Za-z0-9.-]+$/.test(domain) ? domain : "localhost";
}

/** Rejects newlines and other control characters in a header value. */
export function assertHeaderText(value: string, field = "header"): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new SESValidationError(`${field} must not contain control characters`);
  }
}

function isAscii(value: string): boolean {
  return /^[\x00-\x7F]*$/.test(value);
}

function encodeWords(value: string): string[] {
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;

  for (const character of value) {
    const characterBytes = utf8Encode(character).length;
    if (chunkBytes + characterBytes > 45 && chunk.length > 0) {
      words.push(encodeWord(chunk));
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }

  if (chunk.length > 0) words.push(encodeWord(chunk));
  return words;
}

function encodeWord(value: string): string {
  return `=?UTF-8?B?${bytesToBase64(utf8Encode(value))}?=`;
}
