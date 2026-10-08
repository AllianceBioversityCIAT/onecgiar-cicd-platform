// @akili-spec changes/cicd-executor-poc design §7.7, DD-21; requirements FR-18, FR-24, RL-1; tasks R-5 (AC-02 V1)
// Pure deploy-window policy (no I/O, no clock reads: the caller supplies
// `now`). AC-02 V1 (V1-R5): external deployers are NOT modeled; the target
// carries only its `deployWindowPolicy`. A window needs an owner and a
// non-empty `externalJobsDisabled[]`, recorded for audit; that it covers every
// external deployer is attested by the operator (coexistence runbook), never
// checked here. No Jenkins logic (NFR-01).
//
// Units: every timestamp is epoch milliseconds.

/** Maximum lifetime of an open window (§7.7, FR-24): 8 h. */
export const MAX_WINDOW_DURATION_MS = 8 * 60 * 60 * 1000;

export type DeployWindowPolicy = "required" | "not-required";

/** The window policy of a target, from its record or its execution snapshot (design §6.3). */
export interface TargetWindowPolicy {
  readonly deployWindowPolicy: DeployWindowPolicy;
}

/** Window record as persisted (structurally a subset of the repository's item). */
export interface WindowRecord {
  readonly lockKey: string;
  readonly state: "OPEN" | "CLOSED";
  readonly openedBy?: string;
  readonly openedAt?: number;
  readonly closesAt?: number;
  readonly externalJobsDisabled?: readonly string[];
  readonly note?: string;
  readonly closedBy?: string;
  readonly closedReason?: "MANUAL" | "EXPIRED";
  readonly closedAt?: number;
  readonly version: number;
}

export type OpenViolation =
  | "WINDOW_NOT_REQUIRED"
  | "OPENED_BY_REQUIRED"
  | "EMPTY_DISABLED_LIST"
  | "CLOSES_AT_INVALID"
  | "CLOSES_AT_NOT_IN_FUTURE"
  | "WINDOW_TOO_LONG";

export interface OpenWindowInput {
  readonly target: TargetWindowPolicy;
  readonly openedBy: string;
  readonly externalJobsDisabled: readonly string[];
  readonly closesAt: number;
  readonly now: number;
}

export type OpenValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly violations: readonly OpenViolation[] };

/** Opening rules (§7.7, V1): a target that requires a window, an owner, a non-empty disabled list (audit), closesAt in (now, now + 8 h]. */
export function validateOpenWindow(input: OpenWindowInput): OpenValidation {
  const violations: OpenViolation[] = [];

  if (input.target.deployWindowPolicy === "not-required") violations.push("WINDOW_NOT_REQUIRED");
  if (input.openedBy.trim() === "") violations.push("OPENED_BY_REQUIRED");
  if (input.externalJobsDisabled.length === 0) violations.push("EMPTY_DISABLED_LIST");

  if (!Number.isFinite(input.closesAt)) {
    violations.push("CLOSES_AT_INVALID");
  } else if (input.closesAt <= input.now) {
    violations.push("CLOSES_AT_NOT_IN_FUTURE");
  } else if (input.closesAt - input.now > MAX_WINDOW_DURATION_MS) {
    violations.push("WINDOW_TOO_LONG");
  }

  return violations.length === 0 ? { valid: true } : { valid: false, violations };
}

export type DeployDenial =
  | "UNKNOWN_TARGET"
  | "NO_WINDOW"
  | "WINDOW_CLOSED"
  | "WINDOW_EXPIRED"
  | "WINDOW_TOO_SHORT"
  | "WINDOW_INVALID";

export type DeployDecision =
  | { readonly allowed: true; readonly windowRequired: boolean }
  | { readonly allowed: false; readonly reason: DeployDenial };

/**
 * `isDeployAllowed` (§4.3 / §7.7): a deploy may start iff the target does not
 * require a window, or an OPEN window — opened by an owner, with a non-empty
 * disabled list — remains valid until `needUntil` (now + deployTimeoutMinutes).
 * Fails closed on any missing datum.
 */
export function isDeployAllowed(input: {
  readonly target: TargetWindowPolicy | undefined;
  readonly window: WindowRecord | undefined;
  readonly needUntil: number;
  readonly now: number;
}): DeployDecision {
  const { target, window } = input;
  if (target === undefined) return { allowed: false, reason: "UNKNOWN_TARGET" };
  if (target.deployWindowPolicy === "not-required") return { allowed: true, windowRequired: false };

  if (window === undefined) return { allowed: false, reason: "NO_WINDOW" };
  if (window.state !== "OPEN") return { allowed: false, reason: "WINDOW_CLOSED" };
  if (window.closesAt === undefined || window.openedBy === undefined || window.openedBy.trim() === "" || (window.externalJobsDisabled ?? []).length === 0) {
    return { allowed: false, reason: "WINDOW_INVALID" };
  }
  if (window.closesAt <= input.now) return { allowed: false, reason: "WINDOW_EXPIRED" };
  if (window.closesAt < input.needUntil) return { allowed: false, reason: "WINDOW_TOO_SHORT" };
  return { allowed: true, windowRequired: true };
}
