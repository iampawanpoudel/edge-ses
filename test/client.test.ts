import { describe, expect, it } from "vitest";
import { SESClient } from "../src/client";
import {
  SESCredentialsError,
  SESError,
  SESNetworkError,
  SESServiceError,
  SESTimeoutError,
  SESValidationError,
} from "../src/errors";
import type { SendEmailInput } from "../src/types";
import {
  createMockFetch,
  headerValue,
  jsonResponse,
  requestBody,
  responseText,
} from "./helpers";

const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const SIMPLE_INPUT: SendEmailInput = {
  from: "Acme <hello@example.com>",
  to: "user@example.com",
  subject: "Hello",
  text: "Hi",
};

function client(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}): SESClient {
  return new SESClient({
    region: "us-east-1",
    credentials: CREDENTIALS,
    fetch,
    retry: false,
    ...overrides,
  });
}

describe("SESClient.sendEmail", () => {
  it("maps a full simple email onto the SES v2 request", async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse({ MessageId: "message-1" }, 200, { "x-amzn-requestid": "request-1" }),
    );

    const ses = client(fetch);
    const result = await ses.sendEmail({
      from: "Acme <hello@example.com>",
      to: ["one@example.com", "two@example.com"],
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
      subject: "Hello",
      text: "Plain text",
      html: "<p>HTML</p>",
      headers: [{ name: "X-Campaign", value: "welcome" }],
      tags: { campaign: "welcome", environment: "test" },
      listManagement: { contactListName: "newsletter", topicName: "product" },
      configurationSetName: "transactional",
      configurationOverrides: {
        tracking: { clickTrackingEnabled: "DISABLED", openTrackingEnabled: "ENABLED" },
      },
    });

    expect(result).toEqual({
      messageId: "message-1",
      requestId: "request-1",
      statusCode: 200,
    });
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect(call.init.method).toBe("POST");
    expect(headerValue(call.init, "content-type")).toBe("application/json");
    expect(headerValue(call.init, "accept")).toBe("application/json");
    expect(headerValue(call.init, "host")).toBeNull();
    expect(headerValue(call.init, "authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );

    const body = requestBody(call) as any;
    expect(body.FromEmailAddress).toBe("Acme <hello@example.com>");
    expect(body.Destination).toEqual({
      ToAddresses: ["one@example.com", "two@example.com"],
      CcAddresses: ["cc@example.com"],
      BccAddresses: ["bcc@example.com"],
    });
    expect(body.ReplyToAddresses).toEqual(["reply@example.com"]);
    expect(body.ConfigurationSetName).toBe("transactional");
    expect(body.EmailTags).toEqual([
      { Name: "campaign", Value: "welcome" },
      { Name: "environment", Value: "test" },
    ]);
    expect(body.ListManagementOptions).toEqual({
      ContactListName: "newsletter",
      TopicName: "product",
    });
    expect(body.ConfigurationOverrides).toEqual({
      Tracking: { ClickTrackingEnabled: "DISABLED", OpenTrackingEnabled: "ENABLED" },
    });
    expect(body.Content.Simple.Subject).toEqual({ Data: "Hello", Charset: "UTF-8" });
    expect(body.Content.Simple.Body.Text).toEqual({ Data: "Plain text", Charset: "UTF-8" });
    expect(body.Content.Simple.Body.Html).toEqual({ Data: "<p>HTML</p>", Charset: "UTF-8" });
    expect(body.Content.Simple.Headers).toEqual([{ Name: "X-Campaign", Value: "welcome" }]);
  });

  it("merges default tags and configuration set with per-message overrides", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "id" }));
    const ses = client(fetch, {
      defaultTags: { app: "edge-ses", environment: "production" },
      defaultConfigurationSetName: "default-set",
    });

    await ses.sendEmail({
      ...SIMPLE_INPUT,
      tags: { environment: "staging" },
    });
    const body = requestBody(calls[0]!) as any;
    expect(body.ConfigurationSetName).toBe("default-set");
    expect(body.EmailTags).toEqual([
      { Name: "app", Value: "edge-ses" },
      { Name: "environment", Value: "staging" },
    ]);

    await ses.sendEmail({ ...SIMPLE_INPUT, configurationSetName: "custom-set" });
    expect((requestBody(calls[1]!) as any).ConfigurationSetName).toBe("custom-set");
  });

  it("sends raw MIME content as base64", async () => {
    const raw =
      "From: hello@example.com\r\nTo: user@example.com\r\nSubject: Raw\r\nMIME-Version: 1.0\r\n\r\nHello";
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "raw-1" }));

    await client(fetch).sendEmail({
      from: "hello@example.com",
      to: "user@example.com",
      raw,
    });

    const body = requestBody(calls[0]!) as any;
    expect(Buffer.from(body.Content.Raw.Data, "base64").toString("utf8")).toBe(raw);
    expect(body.Content.Simple).toBeUndefined();
  });

  it("allows raw email envelope recipients to come from the MIME headers", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "raw-2" }));
    await client(fetch).sendEmail({
      from: "hello@example.com",
      raw: "From: hello@example.com\r\nTo: user@example.com\r\n\r\nHi",
    });

    expect((requestBody(calls[0]!) as any).Destination).toBeUndefined();
  });

  it("maps stored and inline templates", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "tpl-1" }));
    const ses = client(fetch);

    await ses.sendEmail({
      from: "hello@example.com",
      to: "user@example.com",
      template: {
        name: "welcome",
        data: { name: "Ada", nested: { active: true } },
        headers: { "X-Tenant": "acme" },
        attachments: [
          {
            filename: "terms.txt",
            content: "terms",
            contentType: "text/plain",
          },
        ],
      },
    });

    const stored = requestBody(calls[0]!) as any;
    expect(stored.Content.Template.TemplateName).toBe("welcome");
    expect(stored.Content.Template.TemplateData).toBe(
      JSON.stringify({ name: "Ada", nested: { active: true } }),
    );
    expect(stored.Content.Template.Headers).toEqual([{ Name: "X-Tenant", Value: "acme" }]);
    expect(stored.Content.Template.Attachments[0]).toMatchObject({
      FileName: "terms.txt",
      ContentType: "text/plain",
      ContentDisposition: "ATTACHMENT",
      ContentTransferEncoding: "BASE64",
      RawContent: Buffer.from("terms").toString("base64"),
    });

    await ses.sendEmail({
      from: "hello@example.com",
      to: "user@example.com",
      template: {
        content: {
          subject: "Hello {{name}}",
          text: "Text {{name}}",
          html: "<p>{{name}}</p>",
        },
        data: { name: "Grace" },
      },
    });

    const inline = (requestBody(calls[1]!) as any).Content.Template;
    expect(inline.TemplateContent).toEqual({
      Subject: "Hello {{name}}",
      Text: "Text {{name}}",
      Html: "<p>{{name}}</p>",
    });
    expect(inline.TemplateName).toBeUndefined();
    expect(inline.TemplateData).toBe(JSON.stringify({ name: "Grace" }));
  });

  it("accepts a template name string", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "tpl-2" }));
    await client(fetch).sendEmail({
      from: "hello@example.com",
      to: "user@example.com",
      template: "welcome",
    });
    expect((requestBody(calls[0]!) as any).Content.Template).toEqual({
      TemplateName: "welcome",
    });
  });

  it("maps native simple attachments, including inline images", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "att-1" }));
    await client(fetch).sendEmail({
      ...SIMPLE_INPUT,
      attachments: [
        {
          filename: "data.bin",
          content: new Uint8Array([1, 2, 3]),
          contentType: "application/octet-stream",
        },
        {
          filename: "logo.png",
          content: "PNG",
          contentType: "image/png",
          contentId: "logo",
        },
        {
          filename: "notes.txt",
          content: "notes",
        },
      ],
    });

    const attachments = (requestBody(calls[0]!) as any).Content.Simple.Attachments;
    expect(attachments).toHaveLength(3);
    expect(attachments[0]).toEqual({
      FileName: "data.bin",
      RawContent: "AQID",
      ContentType: "application/octet-stream",
      ContentDisposition: "ATTACHMENT",
      ContentTransferEncoding: "BASE64",
    });
    expect(attachments[1]).toMatchObject({
      FileName: "logo.png",
      RawContent: Buffer.from("PNG").toString("base64"),
      ContentType: "image/png",
      ContentDisposition: "INLINE",
      ContentTransferEncoding: "BASE64",
      ContentId: "logo",
    });
    expect(attachments[2]).toEqual({
      FileName: "notes.txt",
      RawContent: Buffer.from("notes").toString("base64"),
      ContentDisposition: "ATTACHMENT",
      ContentTransferEncoding: "BASE64",
    });
  });
});

describe("SESClient errors and retries", () => {
  it("surfaces SES service errors with code, status, request id, and details", async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse(
        {
          __type: "com.amazonaws.sesv2#MessageRejected",
          message: "Email address is not verified.",
        },
        400,
        { "x-amzn-requestid": "request-error" },
      ),
    );

    const error = await client(fetch)
      .sendEmail(SIMPLE_INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SESServiceError);
    expect(error).toMatchObject({
      name: "SESServiceError",
      code: "MessageRejected",
      statusCode: 400,
      requestId: "request-error",
      retryable: false,
      message: "SES MessageRejected: Email address is not verified.",
      details: {
        __type: "com.amazonaws.sesv2#MessageRejected",
        message: "Email address is not verified.",
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("retries throttling responses and honors Retry-After", async () => {
    const { fetch, calls } = createMockFetch((_call, attempt) => {
      if (attempt === 1) {
        return jsonResponse(
          { __type: "TooManyRequestsException", message: "Slow down" },
          429,
          { "retry-after": "0" },
        );
      }
      return jsonResponse({ MessageId: "after-retry" });
    });

    const result = await client(fetch, {
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    }).sendEmail(SIMPLE_INPUT);

    expect(result.messageId).toBe("after-retry");
    expect(calls).toHaveLength(2);
  });

  it("retries transient 5xx responses up to the configured limit", async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse({ __type: "ServiceUnavailableException", message: "Try later" }, 503),
    );

    const error = await client(fetch, {
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    })
      .sendEmail(SIMPLE_INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SESServiceError);
    expect((error as SESServiceError).retryable).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries network failures", async () => {
    const { fetch, calls } = createMockFetch((_call, attempt) => {
      if (attempt === 1) return Promise.reject(new TypeError("fetch failed"));
      return jsonResponse({ MessageId: "after-network" });
    });

    let firstError: unknown;
    const ses = client(fetch, {
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
        retryOn: (error: SESError) => {
          firstError = error;
          return true;
        },
      },
    });

    await expect(ses.sendEmail(SIMPLE_INPUT)).resolves.toMatchObject({
      messageId: "after-network",
    });
    expect(firstError).toBeInstanceOf(SESNetworkError);
    expect(calls).toHaveLength(2);
  });

  it("lets retryOn override the default decision", async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse({ __type: "MessageRejected", message: "nope" }, 400),
    );

    const error = await client(fetch, {
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
        retryOn: () => false,
      },
    })
      .sendEmail(SIMPLE_INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SESServiceError);
    expect(calls).toHaveLength(1);
  });

  it("reports non-JSON errors with a synthetic code", async () => {
    const { fetch } = createMockFetch(() => responseText("upstream unavailable", 503));
    const error = await client(fetch)
      .sendEmail(SIMPLE_INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SESServiceError);
    expect(error).toMatchObject({
      code: "HTTP_503",
      statusCode: 503,
      retryable: true,
    });
    expect((error as Error).message).toContain("upstream unavailable");
  });

  it("throws InvalidResponse when a successful response has no MessageId", async () => {
    const { fetch } = createMockFetch(() => jsonResponse({}));
    const error = await client(fetch)
      .sendEmail(SIMPLE_INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SESError);
    expect(error).toMatchObject({ code: "InvalidResponse", statusCode: 200 });
  });

  it("times out a hanging request", async () => {
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const ses = client(hangingFetch, { timeoutMs: 5, retry: false });
    await expect(ses.sendEmail(SIMPLE_INPUT)).rejects.toBeInstanceOf(SESTimeoutError);
  });

  it("does not start a request when the caller signal is already aborted", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "never" }));
    const controller = new AbortController();
    controller.abort();

    const error = await client(fetch)
      .sendEmail(SIMPLE_INPUT, { signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("refreshes credentials for every attempt and sends the session token", async () => {
    const { fetch, calls } = createMockFetch((_call, attempt) => {
      if (attempt === 1) {
        return jsonResponse({ __type: "InternalFailure", message: "retry" }, 500);
      }
      return jsonResponse({ MessageId: "credentials-ok" });
    });

    let callsToProvider = 0;
    const ses = new SESClient({
      region: "us-east-1",
      credentials: async () => {
        callsToProvider += 1;
        return {
          ...CREDENTIALS,
          sessionToken: `token-${callsToProvider}`,
        };
      },
      fetch,
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    });

    await expect(ses.sendEmail(SIMPLE_INPUT)).resolves.toMatchObject({
      messageId: "credentials-ok",
    });
    expect(callsToProvider).toBe(2);
    expect(headerValue(calls[0]!.init, "x-amz-security-token")).toBe("token-1");
    expect(headerValue(calls[1]!.init, "x-amz-security-token")).toBe("token-2");
  });

  it("wraps credential provider failures", async () => {
    const { fetch } = createMockFetch(() => jsonResponse({ MessageId: "never" }));
    const ses = new SESClient({
      region: "us-east-1",
      credentials: () => {
        throw new Error("secrets unavailable");
      },
      fetch,
      retry: false,
    });

    const error = await ses.sendEmail(SIMPLE_INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SESCredentialsError);
    expect((error as Error).message).toBe("The credentials provider failed");
  });
});

describe("SESClient configuration and low-level requests", () => {
  it("builds region-specific and custom endpoints", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "id" }));

    await new SESClient({
      region: "cn-north-1",
      credentials: CREDENTIALS,
      fetch,
      retry: false,
    }).sendEmail(SIMPLE_INPUT);

    await new SESClient({
      region: "us-east-1",
      credentials: CREDENTIALS,
      endpoint: "https://proxy.example.com/ses",
      fetch,
      retry: false,
    }).sendEmail(SIMPLE_INPUT);

    expect(calls[0]!.url).toBe(
      "https://email.cn-north-1.amazonaws.com.cn/v2/email/outbound-emails",
    );
    expect(calls[1]!.url).toBe(
      "https://proxy.example.com/ses/v2/email/outbound-emails",
    );
  });

  it("supports arbitrary SES v2 operations through request()", async () => {
    const { fetch, calls } = createMockFetch(() =>
      jsonResponse({ SendQuota: { Max24HourSend: 200 } }, 200, {
        "x-amzn-requestid": "account-request",
      }),
    );

    const ses = client(fetch);
    const response = await ses.request<{ SendQuota: { Max24HourSend: number } }>(
      "/v2/email/account",
      undefined,
      { method: "GET" },
    );

    expect(response).toEqual({
      data: { SendQuota: { Max24HourSend: 200 } },
      statusCode: 200,
      requestId: "account-request",
    });
    expect(calls[0]!.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/account");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("rejects unsafe request paths and unserializable bodies", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({}));
    const ses = client(fetch);

    await expect(ses.request("https://evil.example.com/")).rejects.toBeInstanceOf(
      SESValidationError,
    );
    await expect(ses.request("//evil.example.com/")).rejects.toBeInstanceOf(
      SESValidationError,
    );
    await expect(
      ses.request("/v2/email/account", {}, { method: "GET" }),
    ).rejects.toBeInstanceOf(SESValidationError);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(ses.request("/v2/email/account", circular)).rejects.toBeInstanceOf(
      SESValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("validates constructor input", () => {
    expect(
      () =>
        new SESClient({
          region: "",
          credentials: CREDENTIALS,
        }),
    ).toThrow(SESValidationError);

    expect(
      () =>
        new SESClient({
          region: "us-east-1",
          credentials: { accessKeyId: "", secretAccessKey: "secret" },
        }),
    ).toThrow(SESCredentialsError);

    expect(
      () =>
        new SESClient({
          region: "us-east-1",
          credentials: CREDENTIALS,
          endpoint: "https://example.com/?query=1",
        }),
    ).toThrow(SESValidationError);
  });

  it("rejects invalid email input before calling fetch", async () => {
    const { fetch, calls } = createMockFetch(() => jsonResponse({ MessageId: "never" }));
    const ses = client(fetch);

    const headers: Record<string, string> = {};
    for (let index = 0; index < 16; index += 1) {
      headers[`X-Header-${index}`] = "value";
    }

    const invalidInputs: SendEmailInput[] = [
      { from: "hello@example.com", subject: "No recipients", text: "Hi" },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
      } as unknown as SendEmailInput,
      {
        from: "hello@example.com",
        to: "not-an-email",
        subject: "Hi",
        text: "Hi",
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi\r\nBcc: attacker@example.com",
        text: "Hi",
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        raw: "",
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        raw: "From: hello@example.com\r\n\r\nHi",
        subject: "conflict",
      } as unknown as SendEmailInput,
      {
        from: "hello@example.com",
        to: "user@example.com",
        template: "welcome",
        text: "conflict",
      } as unknown as SendEmailInput,
      {
        from: "hello@example.com",
        to: "user@example.com",
        template: {},
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
        text: "Hi",
        headers,
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
        text: "Hi",
        headers: { "X-Unicode": "héllo" },
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
        text: "Hi",
        headers: { "X-Empty": "" },
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
        text: "Hi",
        headers: { Bcc: "secret@example.com" },
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
        text: "Hi",
        attachments: [{ filename: "bad\r\nname.txt", content: "hi" }],
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
        text: "Hi",
        listManagement: { contactListName: "" },
      },
      {
        from: "hello@example.com",
        to: "user@example.com",
        subject: "Hi",
        text: "Hi",
        configurationOverrides: {
          tracking: { clickTrackingEnabled: "yes" as "ENABLED" },
        },
      },
    ];

    for (const input of invalidInputs) {
      await expect(ses.sendEmail(input)).rejects.toBeInstanceOf(SESValidationError);
    }
    expect(calls).toHaveLength(0);
  });
});
