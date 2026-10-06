// @akili-spec changes/cicd-executor-poc design §7.2, §7.3; requirements FR-16, RL-4, RL-7
// Closed set of domain failure and rejection codes. Pure data, no I/O.
//
// This list is CLOSED: adding a code means re-approving design §7.2's
// failure-mapping table or §7.3's transition table, not just adding a string.
//
// Failure codes (the `FAILED (code)` outcome of X4, X7, X8, X10, X11, X13, X15):
//   DEPLOY_WINDOW_CLOSED  X4, X8, X10, X15 (FR-24; V1-V4)
//   LOCK_TIMEOUT          X7, X15 (canonical lock-wait budget exhaustion, FR-11)
//   SSH_CONNECT           X11, after the connection retries, before exec
//   HOST_KEY_MISMATCH     X11, never retried
//   DISPATCH_INTERRUPTED  X11, crash in DEPLOYING before `execStartedAt` (DD-28)
//   PULL / MIGRATION / START / HEALTH   X13, script exit 10/20/30/40 (FR-13)
// Non-FAILED outcome codes (carried on the SUPERSEDED / UNKNOWN_TARGET_STATE
// states and in logs):
//   UNKNOWN_TARGET_STATE  X16 (any other exit code incl. 2, lost session, deadline)
//   SUPERSEDED            X3, X6 (FR-23)
// Rejection of a transition itself (not a step outcome):
//   INVALID_TRANSITION    anything outside the closed list (design §7.3)

/** Codes that may accompany a `FAILED` execution. */
export const FAILURE_CODES = [
  "DEPLOY_WINDOW_CLOSED",
  "LOCK_TIMEOUT",
  "SSH_CONNECT",
  "HOST_KEY_MISMATCH",
  "DISPATCH_INTERRUPTED",
  "PULL",
  "MIGRATION",
  "START",
  "HEALTH",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** X2 rejection reasons (design §7.2 first rows; FR-16 F3/F4). */
export const REJECT_REASONS = [
  "UNAUTHORIZED_SENDER",
  "SCHEMA_INVALID",
  "REQUEST_ID_MISMATCH",
  "UNKNOWN_DEPLOYMENT",
  "CONSISTENCY_MISMATCH",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const DOMAIN_ERROR_CODES = [
  ...FAILURE_CODES,
  "UNKNOWN_TARGET_STATE",
  "SUPERSEDED",
  "INVALID_TRANSITION",
  ...REJECT_REASONS,
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export function isDomainErrorCode(value: string): value is DomainErrorCode {
  return (DOMAIN_ERROR_CODES as readonly string[]).includes(value);
}

/** Script exit codes that map to a terminal FAILED outcome (X13). */
export const SCRIPT_FAILURE_EXIT_CODES: Readonly<Record<10 | 20 | 30 | 40, FailureCode>> = {
  10: "PULL",
  20: "MIGRATION",
  30: "START",
  40: "HEALTH",
};

/** Exit code reported by the script when the target is busy (X14/X15). */
export const TARGET_BUSY_EXIT_CODE = 50;

export type ExitClassification =
  | { readonly kind: "SUCCESS" }
  | { readonly kind: "FAILED"; readonly code: FailureCode }
  | { readonly kind: "TARGET_BUSY" }
  | { readonly kind: "UNKNOWN" };

/**
 * Exit-code classification for `deploy-container.sh` (design §6.4, §7.2;
 * FR-13, RL-4, RL-7). Exactly 0/10/20/30/40/50 are known; ANY other value
 * (including 2, negatives, signals, non-integers) is UNKNOWN, because the
 * Executor cannot prove the target was untouched.
 */
export function classifyExitCode(exitCode: number): ExitClassification {
  if (exitCode === 0) return { kind: "SUCCESS" };
  if (exitCode === TARGET_BUSY_EXIT_CODE) return { kind: "TARGET_BUSY" };
  if (exitCode === 10 || exitCode === 20 || exitCode === 30 || exitCode === 40) {
    return { kind: "FAILED", code: SCRIPT_FAILURE_EXIT_CODES[exitCode] };
  }
  return { kind: "UNKNOWN" };
}
