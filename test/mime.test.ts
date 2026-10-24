import { describe, expect, it } from "vitest";
import { SESValidationError } from "../src/errors";
import { buildMimeMessage } from "../src/mime";

const DATE = new Date("2026-01-02T03:04:05Z");

function headerBlock(message: string): string {
  return message.split("\r\n\r\n")[0]!;
}

function headerValue(message: string, name: string): string | undefined {
  const lines = headerBlock(message).split("\r\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) {
      let value = line.slice(name.length + 1).trim();
      let next = index + 1;
      while (next < lines.length && lines[next]!.startsWith(" ")) {
        value += `\r\n${lines[next]!}`;
        next += 1;
      }
      return value;
    }
  }
  return undefined;
}

function decodeEncodedWords(value: string): string {
  return value
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_match, encoded: string) =>
      Buffer.from(encoded, "base64").toString("utf8"),
    )
    .replace(/\r\n /g, "");
}

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\r\n/g, ""), "base64").toString("utf8");
}

function decodeQuotedPrintable(value: string): Buffer {
  const withoutSoftBreaks = value.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const character = withoutSoftBreaks[index]!;
    if (character === "=") {
      bytes.push(Number.parseInt(withoutSoftBreaks.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(character.charCodeAt(0));
    }
  }
  return Buffer.from(bytes);
}

function rootBoundary(message: string): string {
  const contentType = headerValue(message, "Content-Type") ?? "";
  const match = /boundary="([^"]+)"/.exec(contentType);
  if (!match) throw new Error("Message has no boundary");
  return match[1]!;
}

describe("buildMimeMessage", () => {
  it("builds a multipart/alternative message with text and HTML", () => {
    const message = buildMimeMessage({
      from: "Acme <hello@example.com>",
      to: ["User <user@example.com>", "second@example.com"],
      cc: "cc@example.com",
      replyTo: "reply@example.com",
      subject: "Hello",
      text: "Plain ✓",
      html: "<p>Héllo</p>",
      date: DATE,
      messageId: "fixed@example.com",
    });

    expect(headerValue(message, "From")).toBe("Acme <hello@example.com>");
    expect(headerValue(message, "To")).toBe(
      "User <user@example.com>, second@example.com",
    );
    expect(headerValue(message, "Cc")).toBe("cc@example.com");
    expect(headerValue(message, "Reply-To")).toBe("reply@example.com");
    expect(headerValue(message, "Subject")).toBe("Hello");
    expect(headerValue(message, "Date")).toBe("Fri, 02 Jan 2026 03:04:05 +0000");
    expect(headerValue(message, "Message-ID")).toBe("<fixed@example.com>");
    expect(headerValue(message, "MIME-Version")).toBe("1.0");
    expect(headerValue(message, "Content-Type")).toMatch(
      /^multipart\/alternative; boundary="----=_edge_ses_[0-9a-f]+"$/,
    );
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);

    const parts = [
      ...message.matchAll(
        /Content-Type: text\/(plain|html); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g,
      ),
    ].map((match) => ({
      type: match[1]!,
      body: decodeBase64(match[2]!.replace(/\r\n$/, "")),
    }));

    expect(parts).toEqual([
      { type: "plain", body: "Plain ✓" },
      { type: "html", body: "<p>Héllo</p>" },
    ]);

    const boundary = rootBoundary(message);
    expect(message.split(`--${boundary}`)).toHaveLength(4);
  });

  it("builds a single-part HTML message", () => {
    const message = buildMimeMessage({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "HTML",
      html: "<p>Only HTML</p>",
      date: DATE,
    });

    expect(headerValue(message, "Content-Type")).toBe("text/html; charset=UTF-8");
    expect(message).toContain("Content-Transfer-Encoding: base64");
    expect(message).toContain(Buffer.from("<p>Only HTML</p>").toString("base64"));
    expect(headerValue(message, "Message-ID")).toMatch(/^<[0-9a-f]+@example\.com>$/);
  });

  it("RFC 2047-encodes non-ASCII subjects and display names", () => {
    const subject =
      "Héllo wörld, this is a rather long subject line with ünïcödé characters that should fold into several encoded words";
    const message = buildMimeMessage({
      from: "Jöhn Döe <john@example.com>",
      to: "user@example.com",
      subject,
      text: "Unicode body ✓",
      date: DATE,
    });

    const encodedSubject = headerValue(message, "Subject")!;
    expect(encodedSubject).toContain("=?UTF-8?B?");
    expect(encodedSubject).toContain("\r\n =?UTF-8?B?");
    expect(decodeEncodedWords(encodedSubject)).toBe(subject);

    const from = headerValue(message, "From")!;
    expect(from).toContain("=?UTF-8?B?");
    expect(decodeEncodedWords(from)).toBe("Jöhn Döe <john@example.com>");

    const body = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(message)?.[1];
    expect(decodeBase64(body!)).toBe("Unicode body ✓");
  });

  it("adds attachments in multipart/mixed with escaped file names", () => {
    const message = buildMimeMessage({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "Files",
      text: "See attached",
      date: DATE,
      attachments: [
        {
          filename: "report.pdf",
          content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          contentType: "application/pdf",
        },
        {
          filename: "naïve.txt",
          content: "héllo",
          contentType: "text/plain; charset=UTF-8",
        },
      ],
    });

    expect(headerValue(message, "Content-Type")).toMatch(/^multipart\/mixed; boundary=/);
    expect(message).toContain('Content-Type: application/pdf; name="report.pdf"');
    expect(message).toContain(
      'Content-Disposition: attachment; filename="report.pdf"',
    );
    expect(message).toContain(
      'Content-Type: text/plain; charset=UTF-8; name="na_ve.txt"; name*=UTF-8\'\'na%C3%AFve.txt',
    );
    expect(message).toContain(
      'Content-Disposition: attachment; filename="na_ve.txt"; filename*=UTF-8\'\'na%C3%AFve.txt',
    );

    const pdf = /Content-Type: application\/pdf; name="report\.pdf"[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(
      message,
    )?.[1];
    expect(Buffer.from(pdf!.replace(/\r\n/g, ""), "base64")).toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46]),
    );

    const text = /Content-Type: text\/plain; charset=UTF-8; name="na_ve\.txt"[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(
      message,
    )?.[1];
    expect(decodeBase64(text!)).toBe("héllo");
  });

  it("places inline images in multipart/related and keeps regular attachments in mixed", () => {
    const inlineOnly = buildMimeMessage({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "Inline",
      html: '<p><img src="cid:logo"></p>',
      date: DATE,
      attachments: [
        {
          filename: "logo.png",
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          contentType: "image/png",
          contentId: "logo",
        },
      ],
    });

    expect(headerValue(inlineOnly, "Content-Type")).toMatch(
      /^multipart\/related; boundary="[^"]+"; type="text\/html"$/,
    );
    expect(inlineOnly).toContain("Content-ID: <logo>");
    expect(inlineOnly).toContain("Content-Disposition: inline");

    const mixed = buildMimeMessage({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "Mixed",
      text: "Body",
      date: DATE,
      attachments: [
        {
          filename: "logo.png",
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          contentType: "image/png",
          contentId: "<logo>",
        },
        {
          filename: "invoice.pdf",
          content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          contentType: "application/pdf",
        },
      ],
    });

    expect(headerValue(mixed, "Content-Type")).toMatch(/^multipart\/mixed; boundary=/);
    expect(mixed).toContain("multipart/related");
    expect(mixed).toContain("Content-ID: <logo>");
    expect(mixed).toContain('filename="invoice.pdf"');
  });

  it("supports custom headers and rejects reserved or injected ones", () => {
    const message = buildMimeMessage({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "Headers",
      text: "Body",
      date: DATE,
      headers: [
        { name: "X-Campaign", value: "welcome" },
        { name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.com>" },
      ],
    });

    expect(message).toContain("X-Campaign: welcome");
    expect(message).toContain("List-Unsubscribe: <mailto:unsubscribe@example.com>");

    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "Headers",
        text: "Body",
        headers: { Bcc: "secret@example.com" },
      }),
    ).toThrow(SESValidationError);

    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "Headers",
        text: "Body",
        headers: { "X-Test": "ok\r\nBcc: secret@example.com" },
      }),
    ).toThrow(SESValidationError);
  });

  it("encodes quoted-printable and 7bit attachments", () => {
    const quotedPrintable = buildMimeMessage({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "QP",
      text: "Body",
      date: DATE,
      attachments: [
        {
          filename: "notes.txt",
          content: "line=1\nline2",
          contentType: "text/plain",
          transferEncoding: "quoted-printable",
        },
      ],
    });

    expect(quotedPrintable).toContain("Content-Transfer-Encoding: quoted-printable");
    const qpBody = /Content-Transfer-Encoding: quoted-printable\r\n\r\n([\s\S]*?)\r\n--/.exec(
      quotedPrintable,
    )?.[1];
    expect(decodeQuotedPrintable(qpBody!).toString("utf8")).toBe("line=1\nline2");

    const sevenBit = buildMimeMessage({
      from: "hello@example.com",
      to: "user@example.com",
      subject: "7bit",
      text: "Body",
      date: DATE,
      attachments: [
        {
          filename: "plain.txt",
          content: "hello\nworld",
          contentType: "text/plain",
          transferEncoding: "7bit",
        },
      ],
    });
    expect(sevenBit).toContain("Content-Transfer-Encoding: 7bit");
    expect(sevenBit).toContain("hello\nworld");

    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "7bit",
        text: "Body",
        attachments: [
          {
            filename: "bad.txt",
            content: "héllo",
            transferEncoding: "7bit",
          },
        ],
      }),
    ).toThrow(SESValidationError);
  });

  it("validates message input", () => {
    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "No body",
      }),
    ).toThrow(SESValidationError);

    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "Bad\r\nBcc: attacker@example.com",
        text: "Body",
      }),
    ).toThrow(SESValidationError);

    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "Bad ID",
        text: "Body",
        messageId: "not-an-id",
      }),
    ).toThrow(SESValidationError);

    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "Bad date",
        text: "Body",
        date: new Date(Number.NaN),
      }),
    ).toThrow(SESValidationError);

    expect(() =>
      buildMimeMessage({
        from: "hello@example.com",
        subject: "Bad attachment",
        text: "Body",
        attachments: [{ filename: "bad\r\nname.txt", content: "x" }],
      }),
    ).toThrow(SESValidationError);
  });
});
