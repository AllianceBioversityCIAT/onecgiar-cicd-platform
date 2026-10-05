// Translated scenario titles reference design §6.6 / FR-20.
import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSignatureVerifier, DEFAULT_SIGNATURE_COMPARE, verifySignature } from "../src/core/verify-signature.js";

const secret = "<WEBHOOK_SECRET_REF>-test-value";
const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");

function sign(rawBody: Buffer, withSecret: string): string {
  return `sha256=${createHmac("sha256", withSecret).update(rawBody).digest("hex")}`;
}

describe("verifySignature (design §6.6, FR-20)", () => {
  it("accepts a correctly signed body", () => {
    expect(verifySignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a missing signature header — nothing would be enqueued downstream", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifySignature(body, sign(body, "a-different-secret"), secret)).toBe(false);
  });

  it("rejects a signature over a different body", () => {
    const otherBody = Buffer.from(JSON.stringify({ hello: "mutated" }), "utf8");
    expect(verifySignature(body, sign(otherBody, secret), secret)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const raw = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, raw, secret)).toBe(false);
  });

  it("rejects non-hex signature content without throwing", () => {
    expect(() => verifySignature(body, "sha256=not-hex-zzzz", secret)).not.toThrow();
    expect(verifySignature(body, "sha256=not-hex-zzzz", secret)).toBe(false);
  });

  it("rejects a signature shorter than the expected digest (length mismatch) without throwing", () => {
    // 4 hex chars decode to a 2-byte buffer, far shorter than a 32-byte SHA-256 digest.
    // A naive implementation that calls crypto.timingSafeEqual directly on
    // mismatched lengths throws (RangeError); this must not.
    expect(() => verifySignature(body, "sha256=abcd", secret)).not.toThrow();
    expect(verifySignature(body, "sha256=abcd", secret)).toBe(false);
  });

  it("rejects a signature longer than the expected digest (length mismatch) without throwing", () => {
    const tooLong = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}00`;
    expect(() => verifySignature(body, tooLong, secret)).not.toThrow();
    expect(verifySignature(body, tooLong, secret)).toBe(false);
  });

  it("is wired to node:crypto's timingSafeEqual by default (structural proof of constant-time comparison)", () => {
    // Falsifier for this task: swapping DEFAULT_SIGNATURE_COMPARE's wiring
    // for `(a, b) => a.equals(b)` or `===` keeps every behavioral test above
    // green (functionally equivalent for well-formed inputs) but fails this
    // identity check, because the production comparison is no longer
    // node:crypto's actual constant-time primitive.
    expect(DEFAULT_SIGNATURE_COMPARE).toBe(timingSafeEqual);
  });

  it("delegates the final comparison to the injected compare function (spy)", () => {
    const compare = vi.fn(timingSafeEqual);
    const verify = createSignatureVerifier(compare);

    const signature = sign(body, secret);
    expect(verify(body, signature, secret)).toBe(true);

    expect(compare).toHaveBeenCalledTimes(1);
    const [providedArg, expectedArg] = compare.mock.calls[0] as [Buffer, Buffer];
    expect(Buffer.isBuffer(providedArg)).toBe(true);
    expect(Buffer.isBuffer(expectedArg)).toBe(true);
    expect(providedArg.equals(expectedArg)).toBe(true);
  });

  it("never calls the injected compare function when lengths already mismatch (guarded before compare)", () => {
    const compare = vi.fn(timingSafeEqual);
    const verify = createSignatureVerifier(compare);

    expect(verify(body, "sha256=abcd", secret)).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });

  it("never calls the injected compare function when the signature header is missing", () => {
    const compare = vi.fn(timingSafeEqual);
    const verify = createSignatureVerifier(compare);

    expect(verify(body, undefined, secret)).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });
});
