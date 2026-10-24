/**
 * Cloudflare Worker example.
 *
 * In a real project, change the import to `from "edge-ses"` and set:
 *   wrangler secret put AWS_ACCESS_KEY_ID
 *   wrangler secret put AWS_SECRET_ACCESS_KEY
 *   wrangler secret put SES_FROM_EMAIL
 *
 * The IAM identity needs `ses:SendEmail` on the verified sending identity.
 * Restrict recipients in production; this example accepts a `to` value from
 * the request body only to keep the demo short.
 */
import { SESClient, SESError } from "../src/index";

export interface Env {
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  SES_FROM_EMAIL: string;
}

interface SendPayload {
  to?: string;
  subject?: string;
  text?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "Use POST" }, 405);
    }

    let payload: SendPayload;
    try {
      payload = (await request.json()) as SendPayload;
    } catch {
      return json({ error: "Request body must be JSON" }, 400);
    }

    if (!payload.to || !payload.subject || !payload.text) {
      return json({ error: "to, subject, and text are required" }, 400);
    }

    const ses = new SESClient({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    try {
      const result = await ses.sendEmail({
        from: env.SES_FROM_EMAIL,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      });

      return json({
        messageId: result.messageId,
        requestId: result.requestId,
      });
    } catch (error) {
      if (error instanceof SESError) {
        return json(
          {
            error: error.code,
            message: error.message,
            requestId: error.requestId,
            retryable: error.retryable,
          },
          error.statusCode ?? 502,
        );
      }

      return json({ error: "Unknown error" }, 500);
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
