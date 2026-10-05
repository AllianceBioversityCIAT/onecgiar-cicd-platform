// @akili-spec changes/cicd-executor-poc design §7.2, §7.3; requirements FR-16
// Closed set of domain error/failure codes. Pure data — no I/O.
//
// This list is CLOSED: adding a code means re-approving design §7.2's
// failure-mapping table (origin → classification) or §7.3's transition
// table (T5/T7/T8/T12's failure outcomes), not just adding a string here.
//
// Sources:
//   SOURCE_CLONE, SOURCE_PREP, ARTIFACT_UPLOAD   — FR-16 F1/F2/F3 (handlers/source)
//   INFRA, QUALITY, BUILD                        — FR-16 F4/F5/F7 (lambda/codebuild)
//   SSH_CONNECT, HOST_KEY_MISMATCH               — FR-16 F10, FR-12 (handlers/ssh, before exec)
//   PULL, MIGRATION, START, HEALTH               — design §6.4/§7.2: deploy-container.sh
//                                                   exit codes 10/20/30/40 (FR-13)
//   UNKNOWN_TARGET_STATE                         — exit code "other" / lost SSH session (§7.3 recovery table)
//   TARGET_BUSY                                  — exit code 50 (T9 guard); never itself a terminal
//                                                   step outcome — it always routes back into
//                                                   WAITING_LOCK (T9), never into FAILED directly
//   LOCK_TIMEOUT                                 — T5, the canonical (and only) outcome of exhausting
//                                                   the WAITING_LOCK budget (§7.3 canonical rule, FR-11)
//   DEPLOY_WINDOW_CLOSED                         — T5/T7 (FR-18, §7.7 V1–V4)
//   TIMED_OUT                                    — T8/T12 outcome, distinct from LOCK_TIMEOUT
//   INVALID_TRANSITION                           — rejection code for any transition outside §7.3's
//                                                   closed list (state-machine's own rejection, not a
//                                                   step failure classification)
//   SUPERSEDED                                   — T4 outcome (FR-11 supersede)
export const DOMAIN_ERROR_CODES = [
  "SOURCE_CLONE",
  "SOURCE_PREP",
  "ARTIFACT_UPLOAD",
  "INFRA",
  "QUALITY",
  "BUILD",
  "SSH_CONNECT",
  "HOST_KEY_MISMATCH",
  "PULL",
  "MIGRATION",
  "START",
  "HEALTH",
  "UNKNOWN_TARGET_STATE",
  "TARGET_BUSY",
  "LOCK_TIMEOUT",
  "DEPLOY_WINDOW_CLOSED",
  "TIMED_OUT",
  "INVALID_TRANSITION",
  "SUPERSEDED",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export function isDomainErrorCode(value: string): value is DomainErrorCode {
  return (DOMAIN_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Exit-code → failure-code mapping for `deploy-container.sh` (design §6.4, §7.2; FR-13).
 * Exit 0 is success and has no failure code: it maps to `undefined`, not an
 * exception — a classifier that throws on its one "good" input forces every
 * caller to special-case 0 before calling it at all, which defeats the point
 * of a single classification function. Any exit code outside the known table
 * (including negative or signal-derived values) maps to UNKNOWN_TARGET_STATE,
 * matching the "other / lost session" row of §7.2.
 */
export const DEPLOY_SCRIPT_EXIT_CODE_MAP: Readonly<Record<number, DomainErrorCode>> = {
  10: "PULL",
  20: "MIGRATION",
  30: "START",
  40: "HEALTH",
  50: "TARGET_BUSY",
};

export function classifyDeployExitCode(exitCode: number): DomainErrorCode | undefined {
  if (exitCode === 0) {
    return undefined;
  }
  return DEPLOY_SCRIPT_EXIT_CODE_MAP[exitCode] ?? "UNKNOWN_TARGET_STATE";
}
