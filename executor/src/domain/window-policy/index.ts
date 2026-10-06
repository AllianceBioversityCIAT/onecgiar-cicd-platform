// @akili-spec changes/cicd-executor-poc design §7.7, DD-21; requirements FR-18, FR-24, RL-1
// Pure deploy-window policy (no I/O, no clock reads: the caller supplies
// `now`). External deployers are opaque identifiers compared as sets: the core
// has no knowledge of what they are (no Jenkins logic, NFR-01).
//
// Units: every timestamp is epoch milliseconds.

/** Maximum lifetime of an open window (§7.7, FR-24): 8 h. */
export const MAX_WINDOW_DURATION_MS = 8 * 60 * 60 * 1000;

export type DeployWindowPolicy = "required" | "not-required";

/** What the Target Registry says about a target, with `externalDeployersRef` already resolved to its opaque list. */
export interface TargetWindowPolicy {
  readonly deployWindowPolicy: DeployWindowPolicy;
  /** Resolved external deployers; empty for `externalDeployers: none`. */
  readonly externalDeployers: readonly string[];
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

/** `none` <=> `not-required`; a reference <=> `required` (§7.7, owner amendment 2026-10-05). */
export function isTargetPolicyConsistent(policy: TargetWindowPolicy): boolean {
  const none = policy.externalDeployers.length === 0;
  return none ? policy.deployWindowPolicy === "not-required" : policy.deployWindowPolicy === "required";
}

/** External deployers not covered by `disabled` (opaque set difference). */
export function uncoveredDeployers(externalDeployers: readonly string[], disabled: readonly string[]): string[] {
  const covered = new Set(disabled);
  return externalDeployers.filter((deployer) => !covered.has(deployer));
}

export type OpenViolation =
  | "TARGET_POLICY_INCONSISTENT"
  | "WINDOW_NOT_REQUIRED"
  | "OPENED_BY_REQUIRED"
  | "EMPTY_DISABLED_LIST"
  | "PARTIAL_COVERAGE"
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
  | { readonly valid: false; readonly violations: readonly OpenViolation[]; readonly uncovered: readonly string[] };

/** Opening rules (§7.7): owner, non-empty list covering ALL external deployers, closesAt in (now, now + 8 h]. */
export function validateOpenWindow(input: OpenWindowInput): OpenValidation {
  const violations: OpenViolation[] = [];
  let uncovered: string[] = [];

  if (!isTargetPolicyConsistent(input.target)) {
    violations.push("TARGET_POLICY_INCONSISTENT");
  } else if (input.target.deployWindowPolicy === "not-required") {
    violations.push("WINDOW_NOT_REQUIRED");
  }
  if (input.openedBy.trim() === "") violations.push("OPENED_BY_REQUIRED");

  if (input.externalJobsDisabled.length === 0) {
    violations.push("EMPTY_DISABLED_LIST");
  }
  uncovered = uncoveredDeployers(input.target.externalDeployers, input.externalJobsDisabled);
  if (input.externalJobsDisabled.length > 0 && uncovered.length > 0) violations.push("PARTIAL_COVERAGE");

  if (!Number.isFinite(input.closesAt)) {
    violations.push("CLOSES_AT_INVALID");
  } else if (input.closesAt <= input.now) {
    violations.push("CLOSES_AT_NOT_IN_FUTURE");
  } else if (input.closesAt - input.now > MAX_WINDOW_DURATION_MS) {
    violations.push("WINDOW_TOO_LONG");
  }

  return violations.length === 0 ? { valid: true } : { valid: false, violations, uncovered };
}

export type DeployDenial =
  | "UNKNOWN_TARGET"
  | "TARGET_POLICY_INCONSISTENT"
  | "NO_WINDOW"
  | "WINDOW_CLOSED"
  | "WINDOW_EXPIRED"
  | "WINDOW_TOO_SHORT"
  | "WINDOW_INVALID"
  | "COVERAGE_INCOMPLETE";

export type DeployDecision =
  | { readonly allowed: true; readonly windowRequired: boolean }
  | { readonly allowed: false; readonly reason: DeployDenial };

/**
 * `isDeployAllowed` (§4.3 / §7.7): a deploy may start iff the target does not
 * require a window, or an OPEN window — opened by an owner, covering ALL the
 * target's CURRENT external deployers — remains valid until `needUntil`
 * (now + timeoutMinutes). Fails closed on any missing or inconsistent datum.
 */
export function isDeployAllowed(input: {
  readonly target: TargetWindowPolicy | undefined;
  readonly window: WindowRecord | undefined;
  readonly needUntil: number;
  readonly now: number;
}): DeployDecision {
  const { target, window } = input;
  if (target === undefined) return { allowed: false, reason: "UNKNOWN_TARGET" };
  if (!isTargetPolicyConsistent(target)) return { allowed: false, reason: "TARGET_POLICY_INCONSISTENT" };
  if (target.deployWindowPolicy === "not-required") return { allowed: true, windowRequired: false };

  if (window === undefined) return { allowed: false, reason: "NO_WINDOW" };
  if (window.state !== "OPEN") return { allowed: false, reason: "WINDOW_CLOSED" };
  if (window.closesAt === undefined || window.openedBy === undefined || window.openedBy.trim() === "") {
    return { allowed: false, reason: "WINDOW_INVALID" };
  }
  if (window.closesAt <= input.now) return { allowed: false, reason: "WINDOW_EXPIRED" };
  if (window.closesAt < input.needUntil) return { allowed: false, reason: "WINDOW_TOO_SHORT" };
  const disabled = window.externalJobsDisabled ?? [];
  if (disabled.length === 0 || uncoveredDeployers(target.externalDeployers, disabled).length > 0) {
    return { allowed: false, reason: "COVERAGE_INCOMPLETE" };
  }
  return { allowed: true, windowRequired: true };
}
