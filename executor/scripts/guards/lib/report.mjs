// @akili-spec changes/cicd-executor-poc requirements NFR-02, NFR-01; design §4.1, DD-23
// Shared violation shape and masking for guard scripts: "never print secret
// values in full" (T-21 scope). A Violation always names the guard, the
// offending file (repo-relative), and a human-readable English message; an
// optional line number pinpoints it. `mask` keeps enough of a matched value
// to be traceable in a report without reproducing the value itself.

/**
 * @typedef {object} Violation
 * @property {string} guard
 * @property {string} file
 * @property {number} [line]
 * @property {string} message
 */

/**
 * Reveals AT MOST the first 2 characters, plus the value's length — never
 * "half" of it (reviewer round-1 finding: an earlier version kept 4+2
 * characters, which for several of this guard's own shorter matches — e.g.
 * a 12-character GitHub token shape — reconstructed most of the value).
 */
export function mask(value) {
  const str = String(value);
  if (str.length <= 2) return "*".repeat(str.length);
  const visible = str.slice(0, 2);
  return `${visible}***(${str.length} chars)`;
}

export function formatViolation(violation) {
  const location = violation.line !== undefined ? `${violation.file}:${violation.line}` : violation.file;
  return `[${violation.guard}] ${location}: ${violation.message}`;
}
