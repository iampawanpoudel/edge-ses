import { SESCredentialsError, SESValidationError } from "./errors";
import type { AwsCredentials } from "./types";
import {
  bytesToHex,
  encodeRfc3986,
  hmacSha256,
  sha256Hex,
  toAmzDate,
  utf8Encode,
} from "./utils";

export interface SigV4Options {
  method: string;
  /** Absolute URL of the request. */
  url: string | URL;
  /** Headers to sign. Values are trimmed and whitespace is collapsed. */
  headers?: Record<string, string>;
  /** Request body. A string is hashed as UTF-8. */
  body?: string | Uint8Array | ArrayBuffer;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Signing date. Defaults to now; mainly useful for deterministic tests. */
  date?: Date;
}

export interface SignedRequest {
  /** Headers to send with fetch. Does not include `host`. */
  headers: Record<string, string>;
  authorization: string;
  signature: string;
  amzDate: string;
  canonicalRequest: string;
  stringToSign: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

/**
 * Signs an HTTP request with AWS Signature Version 4 using Web Crypto.
 *
 * This is the low-level building block behind {@link SESClient}. It is exported
 * so the package can be used with other AWS JSON APIs that accept SigV4.
 *
 * Pass the returned `headers` to fetch unchanged. The `host` header is signed
 * but omitted from the returned object because fetch derives it from the URL
 * (and some runtimes reject manually setting it).
 */
export async function signRequest(options: SigV4Options): Promise<SignedRequest> {
  const url = typeof options.url === "string" ? new URL(options.url) : options.url;
  const method = options.method.toUpperCase();
  const region = options.region.trim();
  const service = options.service.trim();

  if (!region) throw new SESValidationError("A signing region is required");
  if (!service) throw new SESValidationError("A signing service is required");
  if (!options.credentials.accessKeyId || !options.credentials.secretAccessKey) {
    throw new SESCredentialsError("accessKeyId and secretAccessKey are required");
  }

  const providedHeaders = normalizeHeaders(options.headers ?? {});
  const providedAmzDate = providedHeaders.get("x-amz-date");
  const { amzDate, dateStamp } = providedAmzDate
    ? { amzDate: providedAmzDate, dateStamp: providedAmzDate.slice(0, 8) }
    : toAmzDate(options.date ?? new Date());

  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) {
    throw new SESValidationError(`Invalid x-amz-date value: "${amzDate}"`);
  }

  providedHeaders.set("host", url.host);
  providedHeaders.set("x-amz-date", amzDate);
  if (options.credentials.sessionToken) {
    providedHeaders.set("x-amz-security-token", options.credentials.sessionToken.trim());
  }

  const signedHeaderNames = [...providedHeaders.keys()].sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${providedHeaders.get(name)!}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(toBodyBytes(options.body)),
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const dateKey = await hmacSha256(utf8Encode(`AWS4${options.credentials.secretAccessKey}`), dateStamp);
  const regionKey = await hmacSha256(dateKey, region);
  const serviceKey = await hmacSha256(regionKey, service);
  const signingKey = await hmacSha256(serviceKey, "aws4_request");
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));

  const authorization =
    `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {};
  for (const [name, value] of providedHeaders) {
    if (name !== "host") headers[name] = value;
  }
  headers.authorization = authorization;

  return {
    headers,
    authorization,
    signature,
    amzDate,
    canonicalRequest,
    stringToSign,
  };
}

function normalizeHeaders(headers: Record<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== "string") {
      throw new SESValidationError(`Header "${rawName}" must have a string value`);
    }
    const name = rawName.trim().toLowerCase();
    if (!name || name === "authorization") continue;
    normalized.set(name, rawValue.trim().replace(/\s+/g, " "));
  }
  return normalized;
}

function canonicalPath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep the original segment when it contains a malformed escape.
      }
      return encodeRfc3986(decoded);
    })
    .join("/");
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    pairs.push([name, value]);
  });
  pairs.sort(([nameA, valueA], [nameB, valueB]) => {
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    if (valueA === valueB) return 0;
    return valueA < valueB ? -1 : 1;
  });
  return pairs
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

function toBodyBytes(body: SigV4Options["body"]): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return utf8Encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new SESValidationError("SigV4 body must be a string, Uint8Array, or ArrayBuffer");
}
