const textEncoder = new TextEncoder();
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const HEX_BYTES: string[] = Array.from({ length: 256 }, (_, index) =>
  index.toString(16).padStart(2, "0"),
);

/** UTF-8 encodes a string. */
export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** Encodes a string or binary value as bytes. Strings are treated as UTF-8 text. */
export function toBytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === "string") return utf8Encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a string, Uint8Array, or ArrayBuffer");
}

/**
 * Base64-encodes bytes. Uses `btoa` when available (Workers, browsers, Node,
 * Deno, Bun) and falls back to a small pure-JS implementation otherwise.
 * Chunking avoids argument-count limits for large attachments.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  return bytesToBase64Manual(bytes);
}

function bytesToBase64Manual(bytes: Uint8Array): string {
  let result = "";
  let offset = 0;

  for (; offset + 2 < bytes.length; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1]!;
    const third = bytes[offset + 2]!;
    const triple = (first << 16) | (second << 8) | third;
    result +=
      BASE64_ALPHABET[(triple >>> 18) & 63]! +
      BASE64_ALPHABET[(triple >>> 12) & 63]! +
      BASE64_ALPHABET[(triple >>> 6) & 63]! +
      BASE64_ALPHABET[triple & 63]!;
  }

  const remaining = bytes.length - offset;
  if (remaining === 1) {
    const first = bytes[offset]!;
    result += BASE64_ALPHABET[(first >>> 2) & 63]! + BASE64_ALPHABET[(first << 4) & 63]! + "==";
  } else if (remaining === 2) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1]!;
    result +=
      BASE64_ALPHABET[(first >>> 2) & 63]! +
      BASE64_ALPHABET[((first << 4) | (second >>> 4)) & 63]! +
      BASE64_ALPHABET[(second << 2) & 63]! +
      "=";
  }

  return result;
}

/** Encodes a string as base64-encoded UTF-8. */
export function stringToBase64(value: string): string {
  return bytesToBase64(utf8Encode(value));
}

/** Lowercase hex representation of bytes. */
export function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    result += HEX_BYTES[bytes[index]!]!;
  }
  return result;
}

/** Lowercase hex representation of a digest. */
export function toHex(buffer: ArrayBuffer): string {
  return bytesToHex(new Uint8Array(buffer));
}

/** SHA-256 digest as lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return toHex(digest);
}

/**
 * HMAC-SHA256. Accepts binary keys so SigV4 key derivation can be chained
 * without converting to text.
 */
export async function hmacSha256(
  key: Uint8Array,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = typeof data === "string" ? utf8Encode(data) : data;
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    payload as unknown as BufferSource,
  );
  return new Uint8Array(signature);
}

/** RFC 3986 percent-encoding, as required by SigV4. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

/** Formats a date as `YYYYMMDD'T'HHMMSS'Z'` and `YYYYMMDD`. */
export function toAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  const dateStamp = `${year}${month}${day}`;
  return { amzDate: `${dateStamp}T${hours}${minutes}${seconds}Z`, dateStamp };
}

/** RFC 5322 date, e.g. `Fri, 24 Oct 2026 12:00:00 +0000`. */
export function toRfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
}

/** A random hexadecimal token, used for boundaries and Message-IDs. */
export function randomToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    result += HEX_BYTES[bytes[index]!]!;
  }
  return result;
}

/** Sleeps for `milliseconds`, rejecting early if `signal` aborts. */
export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? abortError());
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(signal.reason ?? abortError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Creates a DOMException with the standard abort name. */
export function abortError(message = "The operation was aborted"): Error {
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
