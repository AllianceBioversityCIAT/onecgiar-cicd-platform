// @akili-spec changes/cicd-executor-poc design §6.5, §7 (Forbidden: concatenating commands), FR-12 scenario "arguments"
// Argument-safe remote command construction. The remote command line is the
// only place where text is joined, so EVERY element is single-quote escaped:
// inside single quotes a POSIX shell interprets nothing, and an embedded `'`
// is written as `'\''`. Arguments that cannot be represented safely are
// rejected instead of being "sanitized" (design forward pointer from T-13).

/** Error for an argument or identifier the adapter refuses to put on a command line. Never carries the offending value (it may be sensitive). */
export class UnsafeArgumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsafeArgumentError";
  }
}

/** Single-quote escapes one argument for a POSIX shell. */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

/**
 * Rejects any argument containing a line break (`\n`, `\r`) or a NUL byte.
 * Line breaks are the classic argument-injection vector for remote command
 * parsers that split on them; NUL cannot be carried by a command line at all.
 * Call it before connecting wherever the arguments are known.
 */
export function assertSafeScriptArgs(args: readonly string[]): void {
  args.forEach((arg, index) => {
    if (typeof arg !== "string") {
      throw new UnsafeArgumentError(`script argument #${index} is not a string`);
    }
    if (/[\n\r\0]/.test(arg)) {
      throw new UnsafeArgumentError(`script argument #${index} contains a line break or NUL byte`);
    }
  });
}

/** Execution ids end up in remote paths: letters, digits, `.`, `_`, `-` only, and never a pure-dot name. */
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function assertSafeExecutionId(executionId: string): void {
  if (!EXECUTION_ID_PATTERN.test(executionId) || /^\.+$/.test(executionId)) {
    throw new UnsafeArgumentError("executionId is not a safe path component");
  }
}

/** `<scriptPath> <arg1> <arg2> …`, every element quoted. The script path is adapter-built, never request text. */
export function buildRemoteCommand(scriptPath: string, args: readonly string[]): string {
  assertSafeScriptArgs(args);
  return [scriptPath, ...args].map(shellQuote).join(" ");
}

/**
 * The target's deploy script path (AC-02 V1, design §6.3): absolute, letters,
 * digits, `.`, `_`, `/`, `-` only, no `.` or `..` segment and no trailing slash.
 * Defense in depth behind the target-record schema; the value is never request text.
 */
const SCRIPT_PATH_PATTERN = /^\/[A-Za-z0-9._/-]{1,255}$/;
const SCRIPT_PATH_FORBIDDEN = /(^|\/)\.{1,2}(\/|$)|\/$/;

export function assertSafeScriptPath(scriptPath: string): void {
  if (typeof scriptPath !== "string" || !SCRIPT_PATH_PATTERN.test(scriptPath) || SCRIPT_PATH_FORBIDDEN.test(scriptPath)) {
    throw new UnsafeArgumentError("deploy script path is not a safe absolute path");
  }
}
