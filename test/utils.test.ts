import { afterEach, describe, expect, it } from "vitest";
import { bytesToBase64, stringToBase64, toBytes } from "../src/utils";

const originalBtoa = globalThis.btoa;

afterEach(() => {
  globalThis.btoa = originalBtoa;
});

describe("base64 encoding", () => {
  it("matches Buffer for every byte value and length remainder", () => {
    const samples = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0, 255]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(Array.from({ length: 256 }, (_, index) => index)),
      new Uint8Array(Array.from({ length: 100_000 }, (_, index) => index % 251)),
    ];

    for (const sample of samples) {
      expect(bytesToBase64(sample)).toBe(Buffer.from(sample).toString("base64"));
    }
  });

  it("works when btoa is not available", () => {
    globalThis.btoa = undefined as unknown as typeof btoa;

    const samples = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0, 255]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(Array.from({ length: 256 }, (_, index) => index)),
      new Uint8Array(Array.from({ length: 100_000 }, (_, index) => index % 251)),
    ];

    for (const sample of samples) {
      expect(bytesToBase64(sample)).toBe(Buffer.from(sample).toString("base64"));
    }
  });

  it("encodes strings as UTF-8", () => {
    expect(stringToBase64("héllo ✓")).toBe(
      Buffer.from("héllo ✓", "utf8").toString("base64"),
    );
  });

  it("normalizes binary input", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toBytes(bytes)).toBe(bytes);
    expect(Array.from(toBytes(bytes.buffer))).toEqual([1, 2, 3]);
    expect(Array.from(toBytes("abc"))).toEqual([97, 98, 99]);
    expect(() => toBytes(123 as unknown as string)).toThrow(TypeError);
  });
});
