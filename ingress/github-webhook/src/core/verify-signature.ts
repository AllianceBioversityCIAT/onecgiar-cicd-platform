// @akili-spec changes/cicd-executor-poc design §6.6
// Constant-time HMAC-SHA256 verification of X-Hub-Signature-256 over the raw
// request body. The comparison itself is injected (defaults to
// node:crypto's timingSafeEqual) so a test can prove the implementation
// delegates to it instead of a non-constant-time `===`/Buffer.equals, per
// this task's falsifier (swap the compare for `===` -> test goes red).
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureCompareFn = (a: Buffer, b: Buffer) => boolean;

/** The real, constant-time comparison this module wires in by default (node:crypto's own). */
export const DEFAULT_SIGNATURE_COMPARE: SignatureCompareFn = timingSafeEqual;

const SIGNATURE_PREFIX = "sha256=";
const HEX_PATTERN = /^[0-9a-f]+$/i;

function decodeHexSignature(hex: string): Buffer | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_PATTERN.test(hex)) return undefined;
  return Buffer.from(hex, "hex");
}

/**
 * Builds a verifier bound to a specific constant-time compare function.
 * Production code always uses the default export below; tests use this
 * factory to inject a spy and prove the compare function is actually
 * invoked (rather than the implementation falling back to `===`).
 */
export function createSignatureVerifier(compare: SignatureCompareFn = DEFAULT_SIGNATURE_COMPARE) {
  return function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

    const provided = decodeHexSignature(signatureHeader.slice(SIGNATURE_PREFIX.length));
    if (provided === undefined) return false;

    const expected = createHmac("sha256", secret).update(rawBody).digest();

    // timingSafeEqual throws on length mismatch — guard it explicitly so an
    // attacker-controlled signature length can never crash the handler nor
    // (worse) short-circuit into an unsafe comparison path.
    if (provided.length !== expected.length) return false;

    return compare(provided, expected);
  };
}

/** Production verifier: HMAC-SHA256, constant-time compare (node:crypto's timingSafeEqual). */
export const verifySignature = createSignatureVerifier();
