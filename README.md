# edge-ses

Send email with **Amazon SES** from **Cloudflare Workers**, Deno, Bun, Vercel Edge, Netlify Edge, and Node.js — without the AWS SDK.

`edge-ses` talks to the SES v2 HTTP API directly and signs requests with Web Crypto. It has **zero runtime dependencies**, uses only standard Web APIs (`fetch`, `crypto.subtle`, `TextEncoder`, `btoa`), and includes a MIME builder for raw email with attachments and inline images.

```ts
import { SESClient } from "edge-ses";

const ses = new SESClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

const { messageId } = await ses.sendEmail({
  from: "Acme <hello@example.com>",
  to: "customer@example.com",
  subject: "Your receipt",
  text: "Thanks for your order!",
  html: "<p>Thanks for your order!</p>",
});
```

## Why

The AWS SDK for JavaScript v3 is built for Node.js and needs polyfills or bundler workarounds in edge runtimes. It also adds a large dependency tree for what is ultimately one signed HTTP request.

`edge-ses` is a small, typed client focused on sending email:

- Simple, raw MIME, and templated email
- Native SES attachments, custom headers, inline images
- CC, BCC, Reply-To, configuration sets, email tags, list management, tenant and multi-region endpoint options
- SigV4 signing in Web Crypto, including temporary credentials
- Retries with exponential backoff and jitter, `Retry-After` support, per-attempt timeouts, abort signals
- Typed SES errors with request ids
- No Node built-ins, no AWS SDK, no runtime dependencies
- Full TypeScript declarations and dual ESM/CJS builds

## Install

```bash
npm install edge-ses
```

Requires a server-side runtime with `fetch`, `crypto.subtle`, `TextEncoder`, and `btoa`:

- Cloudflare Workers
- Deno and Bun
- Vercel Edge, Netlify Edge, and other WinterCG-style runtimes
- Node.js 20+

> Do not use this package in browser code. AWS does not allow cross-origin SES requests, and shipping AWS credentials to a browser would expose them.

## AWS setup

1. Verify a domain or email address in SES.
2. Create an IAM identity with permission to send from it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:us-east-1:123456789012:identity/example.com"
    }
  ]
}
```

`ses:SendEmail` covers simple, raw, and templated messages through the v2 API. If your account is in the SES sandbox, every recipient must also be verified.

### Cloudflare Worker

Add the secrets to your Worker:

```bash
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
```

Then use them in the Worker:

```ts
import { SESClient } from "edge-ses";

interface Env {
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ses = new SESClient({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const { messageId } = await ses.sendEmail({
      from: "Acme <hello@example.com>",
      to: "customer@example.com",
      subject: "Hello from a Worker",
      text: "This was sent from the edge.",
    });

    return new Response(JSON.stringify({ messageId }), {
      headers: { "content-type": "application/json" },
    });
  },
};
```

Use a dedicated IAM user or role with only `ses:SendEmail`, rotate keys regularly, and prefer temporary credentials when your platform can provide them.

## Sending email

### Simple email

```ts
await ses.sendEmail({
  from: "Acme <hello@example.com>",
  to: ["customer@example.com", "Second Customer <second@example.com>"],
  cc: "accounting@example.com",
  bcc: "audit@example.com",
  replyTo: "support@example.com",
  subject: "Your invoice",
  text: "Your invoice is attached.",
  html: "<p>Your invoice is attached.</p>",
  charset: "UTF-8",
  headers: {
    "X-Campaign": "invoice",
  },
  tags: {
    campaign: "invoice",
    customerType: "business",
  },
  configurationSetName: "transactional",
  listManagement: {
    contactListName: "newsletter",
    topicName: "product-updates",
  },
  configurationOverrides: {
    tracking: {
      openTrackingEnabled: "DISABLED",
      clickTrackingEnabled: "DISABLED",
    },
  },
});
```

- `to`, `cc`, and `bcc` accept a string, an array, or a comma-separated list.
- Addresses can be bare (`user@example.com`) or include a display name (`"Acme, Inc." <hello@example.com>`).
- `BCC` recipients are passed to SES in the envelope only; they never appear in message headers.
- At least one recipient is required for simple and templated email.
- `subject` is required for simple email. Provide `text`, `html`, or both.
- `charset` defaults to `UTF-8`.
- Custom headers must be printable ASCII, cannot contain a colon in the name, and are limited to 15 headers by SES.

### Attachments

Attachments work with simple and templated email. String content is sent as UTF-8; binary content must be a `Uint8Array` or `ArrayBuffer`.

```ts
await ses.sendEmail({
  from: "hello@example.com",
  to: "customer@example.com",
  subject: "Your invoice",
  html: '<p>Your invoice is attached.</p><p><img src="cid:logo"></p>',
  attachments: [
    {
      filename: "invoice.pdf",
      content: pdfBytes, // Uint8Array | ArrayBuffer | string
      contentType: "application/pdf",
    },
    {
      filename: "logo.png",
      content: logoBytes,
      contentType: "image/png",
      contentId: "logo", // referenced with cid:logo; disposition defaults to inline
    },
  ],
});
```

SES v2 supports up to 40 MB total message size, including encoded attachments; check the current SES limits for your region. When `contentType` is omitted, SES derives it from the file extension. Some file extensions are blocked by SES; see the SES documentation for the current list.

`transferEncoding` can be set to `"base64"`, `"quoted-printable"`, or `"7bit"` if you need to control how SES encodes an attachment. edge-ses defaults to `"base64"` because SES otherwise defaults to 7-bit encoding, which corrupts binary attachments.

### Templates

Send a stored template by name or ARN:

```ts
await ses.sendEmail({
  from: "hello@example.com",
  to: "customer@example.com",
  template: {
    name: "welcome",
    data: {
      firstName: "Ada",
      loginUrl: "https://example.com/login",
    },
    headers: {
      "X-Tenant": "acme",
    },
  },
});
```

Or define the template inline:

```ts
await ses.sendEmail({
  from: "hello@example.com",
  to: "customer@example.com",
  template: {
    content: {
      subject: "Welcome, {{firstName}}",
      text: "Welcome, {{firstName}}!",
      html: "<p>Welcome, {{firstName}}!</p>",
    },
    data: { firstName: "Ada" },
  },
});
```

`data` may be an object or a pre-serialized JSON string. Template attachments and headers are supported the same way as simple attachments. Provide exactly one of `name`, `arn`, or `content`.

```ts
// Shorthand for a stored template name
await ses.sendEmail({ from, to, template: "welcome" });
```

### Raw MIME

Pass a complete MIME message with `raw`:

```ts
await ses.sendEmail({
  from: "hello@example.com",
  to: "customer@example.com",
  bcc: "audit@example.com",
  raw: mimeString, // string | Uint8Array | ArrayBuffer
});
```

Strings are sent as UTF-8 and automatically base64-encoded for the SES API. If you omit `to`/`cc`/`bcc`, SES derives the envelope recipients from the MIME headers.

### Building MIME messages

`buildMimeMessage` creates a standards-compliant message with encoded display names, encoded subjects, multipart text/HTML, attachments, and inline images:

```ts
import { SESClient, buildMimeMessage } from "edge-ses";

const raw = buildMimeMessage({
  from: "Acme <hello@example.com>",
  to: ["Customer <customer@example.com>"],
  cc: "accounting@example.com",
  replyTo: "support@example.com",
  subject: "Your invoice",
  text: "Your invoice is attached.",
  html: '<p>Your invoice is attached.</p><p><img src="cid:logo"></p>',
  headers: {
    "X-Campaign": "invoice",
  },
  attachments: [
    {
      filename: "invoice.pdf",
      content: pdfBytes,
      contentType: "application/pdf",
    },
    {
      filename: "logo.png",
      content: logoBytes,
      contentType: "image/png",
      contentId: "logo",
    },
  ],
});

await ses.sendEmail({
  from: "hello@example.com",
  to: "customer@example.com",
  bcc: "audit@example.com",
  raw,
});
```

The builder:

- emits CRLF line endings and RFC 2047 encoded words for non-ASCII subjects and display names
- produces `multipart/alternative` for text + HTML, `multipart/related` for inline images, and `multipart/mixed` for attachments
- supports base64, quoted-printable, and 7bit attachment encodings
- deliberately does not write a `Bcc` header — pass Bcc to `sendEmail`
- rejects header injection and reserved header overrides

You can also build the message yourself and pass it as a string or bytes.

## Configuration

```ts
const ses = new SESClient({
  region: "us-east-1", // required
  credentials: {
    // required: static credentials or a provider function
    accessKeyId: "...",
    secretAccessKey: "...",
    sessionToken: "...", // optional, for temporary credentials
  },
  endpoint: "https://email.us-east-1.amazonaws.com", // optional
  timeoutMs: 30_000, // per attempt; 0 disables
  retry: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    jitter: true,
  },
  defaultTags: { application: "checkout" },
  defaultConfigurationSetName: "transactional",
  fetch: customFetch, // optional
});
```

### Credentials provider

The provider is called for every attempt, so expiring or rotating credentials work without recreating the client:

```ts
const ses = new SESClient({
  region: "us-east-1",
  credentials: async () => {
    const response = await fetch("https://your-credential-service.example.com/sts");
    return response.json(); // { accessKeyId, secretAccessKey, sessionToken }
  },
});
```

Temporary credentials include the `X-Amz-Security-Token` header and are signed correctly.

### Endpoints

The default endpoint is `https://email.<region>.amazonaws.com`, or `https://email.<region>.amazonaws.com.cn` for China regions.

Use `endpoint` for FIPS endpoints, VPC endpoints, a proxy, or local testing:

```ts
new SESClient({
  region: "us-east-1",
  endpoint: "https://email-fips.us-east-1.amazonaws.com",
  credentials,
});
```

The endpoint may include a base path, for example `https://proxy.example.com/ses`. Query strings and fragments are rejected.

## Retries and timeouts

Defaults:

- 3 total attempts
- 100 ms base delay, capped at 5 s
- full jitter
- 30 s per-attempt timeout

The client retries throttling, transient 5xx responses, network failures, and timeouts. It does not retry validation failures or terminal `4xx` errors such as `MessageRejected`. `Retry-After` is honored (capped by `maxDelayMs`).

```ts
const ses = new SESClient({
  region: "us-east-1",
  credentials,
  timeoutMs: 10_000,
  retry: {
    maxAttempts: 5,
    baseDelayMs: 200,
    maxDelayMs: 3_000,
    jitter: true,
    retryOn: (error, attempt) => {
      // completely overrides the default decision; maxAttempts still applies
      return attempt < 4 && error.statusCode === 503;
    },
  },
});

// disable retries
new SESClient({ region, credentials, retry: false });
```

> **Duplicate sends:** SES can accept a message and still return a transient error. Retrying `SendEmail` can therefore deliver a duplicate. Disable retries with `retry: false` or use `retryOn` for messages that must not be duplicated.

Cancel a request with an `AbortSignal`:

```ts
await ses.sendEmail(input, {
  signal: request.signal,
  timeoutMs: 5_000, // per-request override
});
```

## Errors

```ts
import {
  SESError,
  SESServiceError,
  SESValidationError,
  SESNetworkError,
  SESTimeoutError,
  SESCredentialsError,
  isRetryableError,
} from "edge-ses";

try {
  await ses.sendEmail(input);
} catch (error) {
  if (error instanceof SESServiceError) {
    console.error(error.code); // e.g. "MessageRejected"
    console.error(error.statusCode);
    console.error(error.requestId); // include this in AWS support requests
    console.error(error.details); // parsed response body
  } else if (error instanceof SESValidationError) {
    console.error("Invalid input:", error.message);
  } else if (error instanceof SESTimeoutError) {
    console.error("SES timed out");
  } else if (error instanceof SESNetworkError) {
    console.error("Network failure:", error.cause);
  } else if (isRetryableError(error)) {
    console.error("Retryable failure:", error.code);
  }
}
```

All errors extend `SESError` and expose `code`, `statusCode`, `requestId`, `retryable`, `retryAfterMs`, and `details`.

## Any SES v2 operation

`sendEmail` covers the sending API. For contacts, suppression lists, account data, bulk email, or anything else in SES v2, use the signed `request` escape hatch:

```ts
// GET /v2/email/account
const account = await ses.request<{ SendQuota: { Max24HourSend: number } }>(
  "/v2/email/account",
  undefined,
  { method: "GET" },
);

// POST /v2/email/outbound-bulk-emails
const bulk = await ses.request("/v2/email/outbound-bulk-emails", {
  FromEmailAddress: "hello@example.com",
  DefaultContent: {
    Template: {
      TemplateName: "welcome",
      TemplateData: JSON.stringify({ firstName: "Ada" }),
    },
  },
  BulkEmailEntries: [
    {
      Destination: { ToAddresses: ["ada@example.com"] },
    },
  ],
});
```

The path must start with a single `/`. The same endpoint, credentials, signing, retries, timeout, and error handling apply. `body` is serialized with `JSON.stringify`.

## Advanced: SigV4 for other AWS services

The signer is exported if you need a tiny SigV4 client for another AWS JSON API:

```ts
import { signRequest } from "edge-ses";

const url = "https://dynamodb.us-east-1.amazonaws.com/";
const signed = await signRequest({
  method: "POST",
  url,
  headers: { "content-type": "application/x-amz-json-1.0" },
  body: JSON.stringify({ TableName: "users" }),
  region: "us-east-1",
  service: "dynamodb",
  credentials,
});

await fetch(url, {
  method: "POST",
  headers: signed.headers, // do not modify these
  body: JSON.stringify({ TableName: "users" }),
});
```

## API

### `new SESClient(config)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `region` | `string` | required | AWS region used for the endpoint and signing |
| `credentials` | `AwsCredentials \| () => AwsCredentials \| Promise<AwsCredentials>` | required | Static credentials or a per-attempt provider |
| `endpoint` | `string` | SES regional endpoint | Custom/FIPS/proxy endpoint, optionally with a base path |
| `fetch` | `typeof fetch` | global `fetch` | Custom fetch implementation |
| `timeoutMs` | `number` | `30000` | Per-attempt timeout; `0` disables |
| `retry` | `RetryOptions \| false` | 3 attempts | Retry/backoff configuration |
| `defaultTags` | `Record<string, string>` | none | Tags merged into every send |
| `defaultConfigurationSetName` | `string` | none | Configuration set used unless overridden |

### Methods

| Method | Description |
| --- | --- |
| `sendEmail(input, options?)` | Send a simple, raw, or templated email; returns `{ messageId, requestId?, statusCode }` |
| `request<T>(path, body?, options?)` | Call any SES v2 REST path; returns `{ data, requestId?, statusCode }` |

`RequestOptions`: `{ signal?, timeoutMs?, method? }`.

### Exports

- `SESClient`, `createSESClient`
- `buildMimeMessage`
- `signRequest`
- Errors: `SESError`, `SESServiceError`, `SESValidationError`, `SESNetworkError`, `SESTimeoutError`, `SESCredentialsError`, `isRetryableError`
- Types: `AwsCredentials`, `SESClientConfig`, `RetryOptions`, `SendEmailInput`, `SimpleEmail`, `RawEmail`, `TemplateEmail`, `Attachment`, `EmailHeaders`, `EmailTags`, `SendEmailResult`, `SESResponse`, and more

## Notes and limitations

- This package uses the SES **v2 HTTP API**; it does not implement SMTP.
- SES v2 supports up to 40 MB per message, including attachments and encoding. Check the current limits for your region.
- Simple and templated custom headers are limited to 15 and must be printable ASCII.
- `Bcc` is envelope-only. Do not add a `Bcc` header to raw MIME; pass `bcc` to `sendEmail`.
- Retrying can duplicate an email. See the note above.
- Only the SES send path is modeled ergonomically; everything else is available through `request`.
- Credentials must stay on the server. Never call SES from a browser.

## License

MI
