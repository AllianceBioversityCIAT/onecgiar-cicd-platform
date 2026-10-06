// @akili-spec changes/cicd-executor-poc design §6.3 (hostKeyRef mandatory), §7.2, FR-12 scenario "host key", DD-23
// Pinned host key handling. The pinned value is PUBLIC material resolved from
// the registry's `hostKeyRef`: one or more OpenSSH public key lines
// (`<type> <base64> [comment]`) or bare base64 blobs.
import { createHash, timingSafeEqual } from "node:crypto";

const KEY_TYPE_PATTERN = /^(ssh|ecdsa|sk)-[A-Za-z0-9@.-]+$/;
const MIN_BLOB_CHARS = 16;
const BLOB_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decodes the key blobs out of the pinned value. Returns `[]` when nothing usable is present (callers must fail closed). */
export function parsePinnedHostKeys(value: string): Buffer[] {
  const keys: Buffer[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    // `<type> <base64> [comment]`, or a lone base64 blob; anything else is ignored (never guessed).
    if (parts.length >= 2 && !KEY_TYPE_PATTERN.test(parts[0]!)) continue;
    const candidate = parts.length === 1 ? parts[0]! : parts[1]!;
    if (!BLOB_PATTERN.test(candidate) || candidate.length < MIN_BLOB_CHARS) continue;
    const blob = Buffer.from(candidate, "base64");
    if (blob.length > 0) keys.push(blob);
  }
  return keys;
}

/** Constant-time comparison of the presented key blob with every pinned blob. */
export function matchesPinnedHostKey(presented: Buffer, pinned: readonly Buffer[]): boolean {
  let match = false;
  for (const key of pinned) {
    if (key.length === presented.length && timingSafeEqual(key, presented)) match = true;
  }
  return match;
}

/** `SHA256:<base64>` fingerprint (public information, safe to log). */
export function hostKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}
