import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESClient } from "../src/client";

interface ReceivedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const received: ReceivedRequest[] = [];
let server: ReturnType<typeof createServer>;
let endpoint: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "x-amzn-requestid": "local-request",
      });
      response.end(JSON.stringify({ MessageId: "local-message" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("real fetch integration", () => {
  it("sends a signed JSON request and reads the request id", async () => {
    const ses = new SESClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      endpoint,
      retry: false,
    });

    const result = await ses.sendEmail({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "Integration",
      text: "Hello from real fetch",
      tags: { source: "integration" },
    });

    expect(result).toEqual({
      messageId: "local-message",
      requestId: "local-request",
      statusCode: 200,
    });

    expect(received).toHaveLength(1);
    const request = received[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v2/email/outbound-emails");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, /,
    );
    expect(request.headers["host"]).toBe(endpoint.replace("http://", ""));

    const body = JSON.parse(request.body) as any;
    expect(body.Destination.ToAddresses).toEqual(["user@example.com"]);
    expect(body.Content.Simple.Subject.Data).toBe("Integration");
    expect(body.Content.Simple.Body.Text.Data).toBe("Hello from real fetch");
  });
});
