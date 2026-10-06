// @akili-spec changes/cicd-executor-poc design §7.7; requirements FR-18, FR-24, RL-1
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

const required: TargetWindowPolicy = { deployWindowPolicy: "required", externalDeployers: ["<JOB_A>", "<JOB_B>", "<JOB_C>"] };
const none: TargetWindowPolicy = { deployWindowPolicy: "not-required", externalDeployers: [] };

function open(overrides: Partial<Parameters<typeof validateOpenWindow>[0]> = {}) {
  return validateOpenWindow({
    target: required,
    openedBy: "operator-1",
    externalJobsDisabled: ["<JOB_A>", "<JOB_B>", "<JOB_C>"],
    closesAt: NOW + 2 * HOUR,
    now: NOW,
    ...overrides,
  });
}

describe("validateOpenWindow", () => {
  it("accepts full coverage with an owner and closesAt within 8 h", () => {
    expect(open()).toEqual({ valid: true });
  });

  it("rejects a partial window that misses one external deployer (FR-24)", () => {
    const result = open({ externalJobsDisabled: ["<JOB_A>", "<JOB_B>"] });
    expect(result).toMatchObject({ valid: false, violations: ["PARTIAL_COVERAGE"], uncovered: ["<JOB_C>"] });
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

  it("rejects opening a window on a not-required target (none <=> not-required)", () => {
    const result = open({ target: none, externalJobsDisabled: ["<JOB_A>"] });
    if (result.valid) throw new Error("expected invalid");
    expect(result.violations).toContain("WINDOW_NOT_REQUIRED");
  });

  it("rejects an inconsistent target policy (required + none)", () => {
    const result = open({ target: { deployWindowPolicy: "required", externalDeployers: [] } });
    if (result.valid) throw new Error("expected invalid");
    expect(result.violations).toContain("TARGET_POLICY_INCONSISTENT");
  });
});

function windowRecord(overrides: Partial<WindowRecord> = {}): WindowRecord {
  return {
    lockKey: "<LOCK_KEY>",
    state: "OPEN",
    openedBy: "operator-1",
    openedAt: NOW - HOUR,
    closesAt: NOW + 3 * HOUR,
    externalJobsDisabled: ["<JOB_A>", "<JOB_B>", "<JOB_C>"],
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

  it("denies a window that no longer covers all current external deployers", () => {
    expect(decide(windowRecord({ externalJobsDisabled: ["<JOB_A>", "<JOB_B>"] }))).toEqual({
      allowed: false,
      reason: "COVERAGE_INCOMPLETE",
    });
  });

  it("denies an OPEN window without an owner", () => {
    expect(decide(windowRecord({ openedBy: undefined }))).toEqual({ allowed: false, reason: "WINDOW_INVALID" });
  });

  it("allows a not-required target without any window", () => {
    expect(decide(undefined, none)).toEqual({ allowed: true, windowRequired: false });
  });

  it("fails closed on an unknown target and on an inconsistent policy", () => {
    expect(isDeployAllowed({ target: undefined, window: windowRecord(), needUntil, now: NOW })).toEqual({ allowed: false, reason: "UNKNOWN_TARGET" });
    expect(decide(windowRecord(), { deployWindowPolicy: "not-required", externalDeployers: ["<JOB_A>"] })).toEqual({
      allowed: false,
      reason: "TARGET_POLICY_INCONSISTENT",
    });
  });
});
