// @akili-spec changes/cicd-executor-poc design DD-27, §7.3 (S1 at X3, S2 at X6, X9), §5.1 (TARGET state); requirements FR-23
// Pure supersede decisions under the single-source invariant (DD-27, approved
// by the owner for the PoC): one `deploymentId` per `lockKey`, one trusted
// source per `deploymentId`, and `ci.runNumber` orders runs INSIDE that source
// only. No I/O, no clock. Persistence and conditional writes live in the
// state-store adapter; this module only decides.
//
// Rules:
//   - newer  <=> strictly higher runNumber in the same source;
//   - equal  ==> NOT older (same logical run or a re-run): never superseded;
//   - runNumber values of different sources are NEVER compared: such a pair is
//     rejected defensively (validation makes it impossible; this is the
//     fail-safe, not an ordering rule).

/** An ordering value as stored in TARGET#STATE (design §5.1). */
export interface OrderingValue {
  /** Logical reference of the bound source (repository + workflow + environment). */
  readonly sourceRef: string;
  /** `ci.runNumber`: integer >= 1, ordering input inside the source only. */
  readonly runNumber: number;
}

export type OrderingRelation = "OLDER" | "EQUAL" | "NEWER" | "DIFFERENT_SOURCE";

function assertValid(value: OrderingValue): void {
  if (!Number.isInteger(value.runNumber) || value.runNumber < 1) {
    throw new RangeError(`runNumber must be an integer >= 1, got ${String(value.runNumber)}`);
  }
}

/**
 * Relation of `candidate` to `reference` (what `candidate` is relative to
 * `reference`). Across sources no relation is established.
 */
export function compareOrdering(candidate: OrderingValue, reference: OrderingValue): OrderingRelation {
  assertValid(candidate);
  assertValid(reference);
  if (candidate.sourceRef !== reference.sourceRef) return "DIFFERENT_SOURCE";
  if (candidate.runNumber < reference.runNumber) return "OLDER";
  if (candidate.runNumber > reference.runNumber) return "NEWER";
  return "EQUAL";
}

/** TARGET-state ordering attributes (each absent until first written). */
export interface TargetOrderingState {
  readonly lastDeployed?: OrderingValue;
  readonly highestDispatched?: OrderingValue;
  readonly highestAccepted?: OrderingValue;
}

export type OrderingAttribute = keyof TargetOrderingState;

export type SupersedeDecision =
  | { readonly decision: "PROCEED" }
  | { readonly decision: "SUPERSEDED"; readonly by: OrderingAttribute }
  | { readonly decision: "REJECTED_SOURCE_MISMATCH"; readonly attribute: OrderingAttribute };

function evaluate(
  request: OrderingValue,
  state: TargetOrderingState,
  attributes: readonly OrderingAttribute[],
): SupersedeDecision {
  assertValid(request);
  let supersededBy: OrderingAttribute | undefined;
  for (const attribute of attributes) {
    const stored = state[attribute];
    if (stored === undefined) continue;
    const relation = compareOrdering(request, stored);
    // Fail safe first: a foreign source anywhere means order cannot be
    // established, so nothing may proceed (no cross-source comparison).
    if (relation === "DIFFERENT_SOURCE") return { decision: "REJECTED_SOURCE_MISMATCH", attribute };
    if (relation === "OLDER" && supersededBy === undefined) supersededBy = attribute;
  }
  return supersededBy === undefined ? { decision: "PROCEED" } : { decision: "SUPERSEDED", by: supersededBy };
}

/**
 * S1 (X3, at QUEUED): cheap and non-authoritative; it may only skip, never
 * authorize a deploy. Superseded when `lastDeployed`, `highestDispatched` or
 * `highestAccepted` is strictly newer than the request.
 */
export function evaluateS1(request: OrderingValue, state: TargetOrderingState): SupersedeDecision {
  return evaluate(request, state, ["lastDeployed", "highestDispatched", "highestAccepted"]);
}

/**
 * S2 (X6, under the lock): authoritative. Compares against
 * `max(lastDeployed, highestDispatched)`; `highestAccepted` is deliberately
 * not an input, because a newer request that was merely accepted may never
 * reach the lock (design §7.3).
 */
export function evaluateS2(request: OrderingValue, state: TargetOrderingState): SupersedeDecision {
  return evaluate(request, state, ["lastDeployed", "highestDispatched"]);
}

export type RaiseMaxDecision =
  | { readonly accepted: true; readonly reason: "ABSENT" | "RAISED" | "EQUAL" }
  | { readonly accepted: false; readonly reason: "STORED_IS_NEWER" | "SOURCE_MISMATCH" };

/**
 * Monotonic-max rule shared by `highestAccepted` (after X1) and
 * `highestDispatched` (at X9): the write is accepted when the attribute is
 * absent or `stored <= new` (equal is accepted: the same execution re-entering
 * X9 after exit 50, and re-runs of the same run). A strictly lower new value
 * is refused; so is a value of another source.
 */
export function decideRaiseMax(stored: OrderingValue | undefined, candidate: OrderingValue): RaiseMaxDecision {
  assertValid(candidate);
  if (stored === undefined) return { accepted: true, reason: "ABSENT" };
  switch (compareOrdering(candidate, stored)) {
    case "NEWER":
      return { accepted: true, reason: "RAISED" };
    case "EQUAL":
      return { accepted: true, reason: "EQUAL" };
    case "OLDER":
      return { accepted: false, reason: "STORED_IS_NEWER" };
    case "DIFFERENT_SOURCE":
      return { accepted: false, reason: "SOURCE_MISMATCH" };
  }
}
