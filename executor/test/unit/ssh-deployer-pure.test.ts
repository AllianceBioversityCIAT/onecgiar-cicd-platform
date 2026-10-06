// @akili-spec changes/cicd-executor-poc design §6.5, FR-12, FR-13
// N-13: pure helpers of the ssh2 deploy transport (quoting, CICD_RESULT, host-key parsing).
import { describe, expect, it } from "vitest";
import {
  assertSafeExecutionId,
  buildRemoteCommand,
  matchesPinnedHostKey,
  parseCicdResult,
  parsePinnedHostKeys,
  shellQuote,
} from "../../src/adapters/ssh-deployer/index.js";

describe("shellQuote / buildRemoteCommand", () => {
  it("single-quotes every element and escapes embedded single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(buildRemoteCommand("/tmp/x/s.sh", ["a b", "$(id)"])).toBe(`'/tmp/x/s.sh' 'a b' '$(id)'`);
  });

  it("rejects line breaks and NUL in any argument", () => {
    for (const bad of ["a\nb", "a\rb", "a\0b"]) expect(() => buildRemoteCommand("/s", [bad])).toThrow();
  });

  it("only accepts path-safe execution ids", () => {
    expect(() => assertSafeExecutionId("0f3c-9A_b.1")).not.toThrow();
    for (const bad of ["", "..", ".", "a/b", "a b", "a;b", "a'b", "x".repeat(129)]) {
      expect(() => assertSafeExecutionId(bad)).toThrow();
    }
  });
});

describe("parseCicdResult", () => {
  const ok = 'CICD_RESULT {"status":"SUCCESS","healthy":true}';

  it("parses a valid last line", () => {
    expect(parseCicdResult(`log\n${ok}\n`)).toEqual({ status: "SUCCESS", healthy: true });
    expect(parseCicdResult(`${ok}\r\n`)).toEqual({ status: "SUCCESS", healthy: true });
  });

  it.each([
    ["empty", ""],
    ["no marker", "hello\n"],
    ["malformed JSON", "CICD_RESULT {oops\n"],
    ["not an object", "CICD_RESULT []\n"],
    ["missing status", 'CICD_RESULT {"healthy":true}\n'],
    ["bad migrations enum", 'CICD_RESULT {"status":"X","migrations":"MAYBE"}\n'],
    ["bad healthy type", 'CICD_RESULT {"status":"X","healthy":"yes"}\n'],
    ["bad image map", 'CICD_RESULT {"status":"X","deployedImages":{"a":1}}\n'],
    ["marker not on the last line", `${ok}\nafter\n`],
    ["no space after marker", 'CICD_RESULT{"status":"X"}\n'],
  ])("treats %s as missing", (_name, stdout) => {
    expect(parseCicdResult(stdout)).toBeUndefined();
  });

  it("ignores a result that could be a front-truncated fragment", () => {
    expect(parseCicdResult(ok, true)).toBeUndefined();
    expect(parseCicdResult(`tail\n${ok}`, true)).toEqual({ status: "SUCCESS", healthy: true });
  });
});

describe("pinned host keys", () => {
  const blob = Buffer.from("fake-key-blob-bytes");
  const b64 = blob.toString("base64");

  it("parses OpenSSH lines, bare blobs, comments and several keys", () => {
    const keys = parsePinnedHostKeys(`# c\nssh-ed25519 ${b64} host\n${Buffer.from("other-key-blob-bytes").toString("base64")}\n`);
    expect(keys).toHaveLength(2);
    expect(matchesPinnedHostKey(blob, keys)).toBe(true);
    expect(matchesPinnedHostKey(Buffer.from("nope"), keys)).toBe(false);
  });

  it("yields nothing usable for garbage", () => {
    expect(parsePinnedHostKeys("not a key !!!\n")).toEqual([]);
    expect(matchesPinnedHostKey(blob, [])).toBe(false);
  });
});
