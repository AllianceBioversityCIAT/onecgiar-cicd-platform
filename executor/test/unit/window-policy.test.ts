// @akili-spec changes/cicd-executor-poc design §7.7; requirements FR-18, FR-24, RL-1; tasks R-5 (AC-02 V1)
// AC-02 V1: external deployers are not modeled (V1-R5). The target carries only
// its `deployWindowPolicy`; opening requires an owner and a non-empty
// `externalJobsDisabled[]`, recorded for audit; its coverage is attested by the
// operator, not checked here.
import { describe, expect, it } from "vitest";
import {
  isDeployAllowed,
  validateOpenWindow,
  type TargetWindowPolicy,
  type WindowRecord,
} from "../../src/domain/window-policy/index.js";

const HOUR = 3_600_000;
// Independent literal for the 8 h cap of FR-24 (not the module constant).
const EIGHT_HOURS = 8 * HOUR;
const NOW = Date.parse("2026-10-06T10:00:00.000Z");

const required: TargetWindowPolicy = { deployWindowPolicy: "required" };
const none: TargetWindowPolicy = { deployWindowPolicy: "not-required" };

function open(overrides: Partial<Parameters<typeof validateOpenWindow>[0]> = {}) {
  return validateOpenWindow({
    target: required,
    openedBy: "operator-1",
    externalJobsDisabled: ["<JOB_A>"],
    closesAt: NOW + 2 * HOUR,
    now: NOW,
    ...overrides,
  });
}

describe("validateOpenWindow", () => {
  it("accepts an owner, a non-empty disabled list and closesAt within 8 h", () => {
    expect(open()).toEqual({ valid: true });
  });

  it("rejects an empty disabled list and a missing owner", () => {
    const result = open({ externalJobsDisabled: [], openedBy: " " });
    if (result.valid) throw new Error("expected invalid");
    expect(result.violations).toEqual(expect.arrayContaining(["EMPTY_DISABLED_LIST", "OPENED_BY_REQUIRED"]));
  });

  it("rejects closesAt more than 8 h ahead and accepts exactly 8 h", () => {
    expect(open({ closesAt: NOW + EIGHT_HOURS + 1 })).toMatchObject({ valid: false, violations: ["WINDOW_TOO_LONG"] });
    expect(open({ closesAt: NOW + EIGHT_HOURS })).toEqual({ valid: true });
  });

  it("rejects closesAt in the past or not a number", () => {
    expect(open({ closesAt: NOW })).toMatchObject({ violations: ["CLOSES_AT_NOT_IN_FUTURE"] });
    expect(open({ closesAt: Number.NaN })).toMatchObject({ violations: ["CLOSES_AT_INVALID"] });
  });

  it("rejects opening a window on a not-required target (design §7.7)", () => {
    const result = open({ target: none });
    if (result.valid) throw new Error("expected invalid");
    expect(result.violations).toContain("WINDOW_NOT_REQUIRED");
  });

  it("does not compare the disabled list with any modeled deployer list (V1-R5)", () => {
    expect(open({ externalJobsDisabled: ["<ANY_JOB>"] })).toEqual({ valid: true });
  });
});

function windowRecord(overrides: Partial<WindowRecord> = {}): WindowRecord {
  return {
    lockKey: "example-app-dev",
    state: "OPEN",
    openedBy: "operator-1",
    openedAt: NOW - HOUR,
    closesAt: NOW + 3 * HOUR,
    externalJobsDisabled: ["<JOB_A>"],
    version: 1,
    ...overrides,
  };
}

describe("isDeployAllowed", () => {
  const needUntil = NOW + HOUR;
  const decide = (window: WindowRecord | undefined, target: TargetWindowPolicy | undefined = required, until = needUntil) =>
    isDeployAllowed({ target, window, needUntil: until, now: NOW });

  it("allows with a valid open window covering needUntil", () => {
    expect(decide(windowRecord())).toEqual({ allowed: true, windowRequired: true });
  });

  it("denies when there is no window", () => {
    expect(decide(undefined)).toEqual({ allowed: false, reason: "NO_WINDOW" });
  });

  it("denies a closed window", () => {
    expect(decide(windowRecord({ state: "CLOSED" }))).toEqual({ allowed: false, reason: "WINDOW_CLOSED" });
  });

  it("denies an expired window even if still marked OPEN", () => {
    expect(decide(windowRecord({ closesAt: NOW }))).toEqual({ allowed: false, reason: "WINDOW_EXPIRED" });
    expect(decide(windowRecord({ closesAt: NOW - 1 }))).toEqual({ allowed: false, reason: "WINDOW_EXPIRED" });
  });

  it("denies a window that ends before needUntil", () => {
    expect(decide(windowRecord({ closesAt: needUntil - 1 }))).toEqual({ allowed: false, reason: "WINDOW_TOO_SHORT" });
    expect(decide(windowRecord({ closesAt: needUntil }))).toEqual({ allowed: true, windowRequired: true });
  });

  it("denies an OPEN window without an owner or with an empty disabled list", () => {
    expect(decide(windowRecord({ openedBy: undefined }))).toEqual({ allowed: false, reason: "WINDOW_INVALID" });
    expect(decide(windowRecord({ externalJobsDisabled: [] }))).toEqual({ allowed: false, reason: "WINDOW_INVALID" });
  });

  it("allows a not-required target without any window", () => {
    expect(decide(undefined, none)).toEqual({ allowed: true, windowRequired: false });
  });

  it("fails closed on an unknown target", () => {
    expect(isDeployAllowed({ target: undefined, window: windowRecord(), needUntil, now: NOW })).toEqual({ allowed: false, reason: "UNKNOWN_TARGET" });
  });
});
