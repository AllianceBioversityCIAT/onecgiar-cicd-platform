// @akili-spec changes/cicd-executor-poc design DD-27, §7.3; requirements FR-23
// Every scenario mixes ARRIVAL order with RUN order (the point of DD-27: the
// Executor's arrival order is not the ordering key). Expected values come from
// FR-23's scenarios, not from the module's own arithmetic.

import { describe, expect, it } from "vitest";
import {
  compareOrdering,
  decideRaiseMax,
  evaluateS1,
  evaluateS2,
  type OrderingValue,
  type TargetOrderingState,
} from "../../src/domain/supersede-policy/index.js";

const SRC = "<SOURCE_A>";
const v = (runNumber: number, sourceRef = SRC): OrderingValue => ({ sourceRef, runNumber });

describe("compareOrdering", () => {
  it("lower is OLDER, higher is NEWER, equal is EQUAL (not older)", () => {
    expect(compareOrdering(v(4), v(5))).toBe("OLDER");
    expect(compareOrdering(v(6), v(5))).toBe("NEWER");
    expect(compareOrdering(v(5), v(5))).toBe("EQUAL");
  });

  it("never orders across sources", () => {
    expect(compareOrdering(v(1), v(99, "<SOURCE_B>"))).toBe("DIFFERENT_SOURCE");
    expect(compareOrdering(v(99), v(1, "<SOURCE_B>"))).toBe("DIFFERENT_SOURCE");
  });

  it("rejects invalid run numbers", () => {
    expect(() => compareOrdering(v(0), v(1))).toThrow(RangeError);
    expect(() => compareOrdering(v(1.5), v(1))).toThrow(RangeError);
  });
});

describe("S1 (X3) - FR-23", () => {
  it("late older build: run 7 deployed, run 6 arrives afterwards -> SUPERSEDED", () => {
    const state: TargetOrderingState = { lastDeployed: v(7), highestDispatched: v(7), highestAccepted: v(7) };
    expect(evaluateS1(v(6), state)).toEqual({ decision: "SUPERSEDED", by: "lastDeployed" });
  });

  it("re-run of an older run (same lower number) arriving after a newer deploy -> SUPERSEDED", () => {
    // Run 3 deployed, run 4 deployed, then run 3 is re-run and arrives with runNumber 3 again.
    const state: TargetOrderingState = { lastDeployed: v(4), highestDispatched: v(4), highestAccepted: v(4) };
    expect(evaluateS1(v(3), state)).toEqual({ decision: "SUPERSEDED", by: "lastDeployed" });
  });

  it("newer accepted, then older arrives -> SUPERSEDED by highestAccepted (nothing deployed yet)", () => {
    // Arrival order: run 9 first (accepted, still queued), then run 8.
    expect(evaluateS1(v(8), { highestAccepted: v(9) })).toEqual({ decision: "SUPERSEDED", by: "highestAccepted" });
  });

  it("older accepted first, newer arrives later: the newer is not superseded", () => {
    // Arrival order 8 then 9: 9 is newer than the stored highestAccepted 8.
    expect(evaluateS1(v(9), { highestAccepted: v(8) })).toEqual({ decision: "PROCEED" });
  });

  it("equal re-run is allowed (equal is not older)", () => {
    const state: TargetOrderingState = { lastDeployed: v(5), highestDispatched: v(5), highestAccepted: v(5) };
    expect(evaluateS1(v(5), state)).toEqual({ decision: "PROCEED" });
  });

  it("empty target state proceeds", () => {
    expect(evaluateS1(v(1), {})).toEqual({ decision: "PROCEED" });
  });

  it("different source is rejected defensively, whatever the numbers", () => {
    expect(evaluateS1(v(100), { highestAccepted: v(1, "<SOURCE_B>") })).toEqual({
      decision: "REJECTED_SOURCE_MISMATCH",
      attribute: "highestAccepted",
    });
  });
});

describe("S2 (X6) - FR-23", () => {
  it("newer dispatched then UNKNOWN_TARGET_STATE (lastDeployed absent): older is SUPERSEDED", () => {
    // Run 12 reached X9 and ended unknown; run 11, which arrived earlier and waited for the lock, now holds it.
    expect(evaluateS2(v(11), { highestDispatched: v(12) })).toEqual({
      decision: "SUPERSEDED",
      by: "highestDispatched",
    });
  });

  it("newer lost its lease (target write rejected: lastDeployed unchanged, highestDispatched set): older SUPERSEDED", () => {
    const state: TargetOrderingState = { lastDeployed: v(10), highestDispatched: v(12) };
    expect(evaluateS2(v(11), state)).toEqual({ decision: "SUPERSEDED", by: "highestDispatched" });
  });

  it("older than lastDeployed is superseded by lastDeployed", () => {
    expect(evaluateS2(v(9), { lastDeployed: v(10), highestDispatched: v(10) })).toEqual({
      decision: "SUPERSEDED",
      by: "lastDeployed",
    });
  });

  it("ignores highestAccepted: a merely accepted newer request does not block the lock holder", () => {
    expect(evaluateS2(v(8), { highestAccepted: v(9) })).toEqual({ decision: "PROCEED" });
  });

  it("same execution re-entering after exit 50 (equal to highestDispatched) is not superseded", () => {
    expect(evaluateS2(v(12), { highestDispatched: v(12) })).toEqual({ decision: "PROCEED" });
  });

  it("equal re-run proceeds after a newer-arrival deploy; a strictly lower one does not", () => {
    const state: TargetOrderingState = { lastDeployed: v(12), highestDispatched: v(12) };
    expect(evaluateS2(v(12), state)).toEqual({ decision: "PROCEED" });
    expect(evaluateS2(v(11), state).decision).toBe("SUPERSEDED");
  });

  it("different source is rejected defensively", () => {
    expect(evaluateS2(v(5), { lastDeployed: v(1, "<SOURCE_B>") })).toEqual({
      decision: "REJECTED_SOURCE_MISMATCH",
      attribute: "lastDeployed",
    });
  });
});

describe("decideRaiseMax (highestAccepted after X1, highestDispatched at X9)", () => {
  it("accepts when absent", () => {
    expect(decideRaiseMax(undefined, v(3))).toEqual({ accepted: true, reason: "ABSENT" });
  });
  it("raises when the new value is higher", () => {
    expect(decideRaiseMax(v(3), v(4))).toEqual({ accepted: true, reason: "RAISED" });
  });
  it("accepts an equal value (same execution after exit 50, re-run of the same run)", () => {
    expect(decideRaiseMax(v(4), v(4))).toEqual({ accepted: true, reason: "EQUAL" });
  });
  it("refuses a strictly lower value (late older arrival after a newer one)", () => {
    expect(decideRaiseMax(v(4), v(3))).toEqual({ accepted: false, reason: "STORED_IS_NEWER" });
  });
  it("refuses a value of another source", () => {
    expect(decideRaiseMax(v(1, "<SOURCE_B>"), v(5))).toEqual({ accepted: false, reason: "SOURCE_MISMATCH" });
  });
});
