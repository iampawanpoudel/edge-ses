import { describe, expect, it } from "vitest";
import { SESCredentialsError, SESValidationError } from "../src/errors";
import { signRequest } from "../src/sigv4";

/**
 * These vectors were generated with botocore's SigV4 implementation. The
 * IAM vector is also the example published in the AWS Signature Version 4
 * documentation.
 */
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("signRequest", () => {
  it("matches the AWS documentation ListUsers vector", async () => {
    const signed = await signRequest({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      region: "us-east-1",
      service: "iam",
      credentials: CREDENTIALS,
      date: new Date("2015-08-30T12:36:00Z"),
    });

    expect(signed.amzDate).toBe("20150830T123600Z");
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "Action=ListUsers&Version=2010-05-08",
        "content-type:application/x-www-form-urlencoded; charset=utf-8",
        "host:iam.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "content-type;host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    expect(signed.headers["host"]).toBeUndefined();
    expect(signed.headers["authorization"]).toBe(signed.authorization);
    expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("matches botocore for a JSON SES request with non-ASCII content", async () => {
    const body = JSON.stringify({
      FromEmailAddress: "Acme <hello@example.com>",
      Destination: { ToAddresses: ["user@example.com", "Jöhn <john@example.com>"] },
      ReplyToAddresses: ["reply@example.com"],
      Content: {
        Simple: {
          Subject: { Data: "Héllo wörld", Charset: "UTF-8" },
          Body: { Text: { Data: "Hello", Charset: "UTF-8" } },
          Headers: [{ Name: "X-Campaign", Value: "welcome" }],
        },
      },
    });

    const signed = await signRequest({
      method: "POST",
      url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      region: "us-east-1",
      service: "ses",
      credentials: CREDENTIALS,
      date: new Date("2026-10-24T10:11:12Z"),
    });

    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261024/us-east-1/ses/aws4_request, " +
        "SignedHeaders=accept;content-type;host;x-amz-date, " +
        "Signature=e86e68b553a2508a8331a012539a5e552a740a2919646f8c03d4660e32f40fd4",
    );
    expect(signed.canonicalRequest).toContain(
      "73a7038b461540cbf90a5ba1254940dbd3bcb58c3cfc2fc9fb43fff30f158b3e",
    );
  });

  it("includes session tokens and canonicalizes query parameters", async () => {
    const signed = await signRequest({
      method: "POST",
      url: "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails?X-Test=hello%20world",
      headers: { "Content-Type": "application/json" },
      body: '{"Content":{"Raw":{"Data":"RnJvbTogdGVzdEBleGFtcGxlLmNvbQ=="}}}',
      region: "eu-west-1",
      service: "ses",
      credentials: { ...CREDENTIALS, sessionToken: "SESSIONTOKEN/+= " },
      date: new Date("2026-01-01T00:00:00Z"),
    });

    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260101/eu-west-1/ses/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, " +
        "Signature=25c7e8428a998d45429d82a15c2d58e05ed3c6bfe8f30ac588407dcdc15a9a8d",
    );
    expect(signed.headers["x-amz-security-token"]).toBe("SESSIONTOKEN/+=");
    expect(signed.canonicalRequest).toContain("X-Test=hello%20world");
  });

  it("rejects malformed signing input", async () => {
    await expect(
      signRequest({
        method: "POST",
        url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
        region: "",
        service: "ses",
        credentials: CREDENTIALS,
      }),
    ).rejects.toBeInstanceOf(SESValidationError);

    await expect(
      signRequest({
        method: "POST",
        url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
        headers: { "x-amz-date": "not-a-date" },
        region: "us-east-1",
        service: "ses",
        credentials: CREDENTIALS,
      }),
    ).rejects.toBeInstanceOf(SESValidationError);

    await expect(
      signRequest({
        method: "POST",
        url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
        region: "us-east-1",
        service: "ses",
        credentials: { accessKeyId: "", secretAccessKey: "secret" },
      }),
    ).rejects.toBeInstanceOf(SESCredentialsError);
  });
});
