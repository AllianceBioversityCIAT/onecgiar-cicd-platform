// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §7, §9, §10.2–§10.4, §16, §17; design DD-09
//
// E1 acceptance criteria that the pure protocol rules can prove now. The wiring that applies them (the Executor's
// lock repository, results consumer and reconciler in E2; the agent's journal and scheduler in E3) is covered by
// the pending cases in agent-protocol.pending.test.ts.
import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_DEFAULTS,
  clearActiveCommand,
  commandIdOf,
  decideAcceptance,
  effectOfAgentEvent,
  hardDeadlineAt,
  holdDecision,
  isPinned,
  mayChangeLock,
  neverSeenVerdict,
  PINNED_LEASE_EXPIRES_AT,
  type AcceptanceInput,
  type AgentTargetState,
  type NeverSeenContext,
  type NotStartedReason,
} from "../../src/domain/agent-protocol/index.js";
import { evaluateLockAcquisition, type PersistedLockItem } from "../../src/domain/lock-policy/index.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-10T20:00:00Z");
const TOKEN_A = "0f8b3c1e-2a4d-4b6f-8c9e-1a2b3c4d5e6f";
const TOKEN_B = "1f8b3c1e-2a4d-4b6f-8c9e-1a2b3c4d5e6f";
const CMD_A = commandIdOf("example-app-dev-7", TOKEN_A);
const CMD_B = commandIdOf("example-app-dev-8", TOKEN_B);

function acceptance(overrides: Partial<AcceptanceInput> = {}): AcceptanceInput {
  return {
    commandId: CMD_A,
    fencingToken: 12,
    issuedAtMs: T0,
    notAfterMs: T0 + 5 * MIN,
    journalEpochMs: T0 - 30 * 24 * 60 * MIN,
    journalHasCommand: false,
    targetState: { highestFencingToken: 11 },
    nowMs: T0 + 10_000,
    clockOffsetMs: 0,
    clockSkewSeconds: AGENT_PROTOCOL_DEFAULTS.clockSkewSeconds,
    ...overrides,
  };
}

describe("persistent fencing (AC-04 §9.1, §10.4)", () => {
  it("central fencing tokens never go backwards across owner changes, re-entries and expiries", () => {
    let lock: PersistedLockItem | undefined;
    let now = T0;
    const seen: number[] = [];
    const owners = ["exec-1", "exec-1", "exec-2", "exec-3", "exec-3", "exec-4"];
    for (const owner of owners) {
      const decision = evaluateLockAcquisition(lock, owner, now, 180);
      expect(decision.outcome).toBe("ACQUIRED");
      if (decision.outcome !== "ACQUIRED") return;
      seen.push(decision.fencingToken);
      lock = { owner, fencingToken: decision.fencingToken, leaseExpiresAt: decision.leaseExpiresAt };
      now += 200_000; // past the lease: the next owner takes it over
    }
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number);
    expect(seen).toEqual([1, 1, 2, 3, 3, 4]);
  });

  it("an older command can never start after a newer one on the same target (STALE_FENCING)", () => {
    const afterNewer = decideAcceptance(acceptance({ commandId: CMD_A, fencingToken: 11, targetState: { highestFencingToken: 12 } }));
    expect(afterNewer).toEqual({ decision: "NOT_STARTED", reason: "STALE_FENCING" });
  });

  it("an equal token for a different command is refused (only the same, journaled command may repeat)", () => {
    expect(decideAcceptance(acceptance({ commandId: CMD_B, fencingToken: 12, targetState: { highestFencingToken: 12 } }))).toEqual({ decision: "NOT_STARTED", reason: "STALE_FENCING" });
    expect(decideAcceptance(acceptance({ journalHasCommand: true, fencingToken: 12, targetState: { highestFencingToken: 12 } }))).toEqual({ decision: "DUPLICATE" });
  });

  it("a recreated central lock (token restarted at 1) is never silently accepted: the agent refuses it, fail closed", () => {
    const recreated = evaluateLockAcquisition(undefined, "exec-9", T0, 180);
    expect(recreated).toMatchObject({ outcome: "ACQUIRED", fencingToken: 1 });
    const decision = decideAcceptance(acceptance({ fencingToken: 1, targetState: { highestFencingToken: 7 } }));
    expect(decision).toEqual({ decision: "NOT_STARTED", reason: "STALE_FENCING" });
    expect(effectOfAgentEvent({ phase: "NOT_STARTED", reason: "STALE_FENCING" })).toEqual({ kind: "CLOSE", transition: "X11", lock: "RELEASE", cause: "AGENT_STALE_FENCING" });
  });

  it("a reinstalled agent (new journal) refuses every command issued before its journal existed", () => {
    const reinstalled = acceptance({ journalEpochMs: T0 + 1, targetState: {} });
    expect(decideAcceptance(reinstalled)).toEqual({ decision: "NOT_STARTED", reason: "PREDATES_JOURNAL" });
  });

  it("a reinstalled agent accepts a command issued after its journal existed, and records the token from then on", () => {
    const decision = decideAcceptance(acceptance({ journalEpochMs: T0 - 1, targetState: {} }));
    expect(decision).toEqual({ decision: "ACCEPT", nextState: { highestFencingToken: 12, activeCommandId: CMD_A } });
  });
});

describe("AGENT_QUERY / NEVER_SEEN evidence (AC-04 §6, §9.3)", () => {
  const valid: NeverSeenContext = {
    commandIssuedAtMs: T0,
    notAfterMs: T0 + 5 * MIN,
    journalEpochMs: T0 - 24 * 60 * MIN,
    journalRetentionDays: 30,
    answeredAtMs: T0 + 10 * MIN,
    clockSkewSeconds: 60,
  };

  it("is evidence only when every precondition holds", () => {
    expect(neverSeenVerdict(valid)).toEqual({ evidence: true });
  });

  it("a lost or recreated journal (epoch not older than the command) proves nothing", () => {
    expect(neverSeenVerdict({ ...valid, journalEpochMs: T0 })).toEqual({ evidence: false, reason: "JOURNAL_NOT_OLDER_THAN_COMMAND" });
    expect(neverSeenVerdict({ ...valid, journalEpochMs: T0 + MIN })).toEqual({ evidence: false, reason: "JOURNAL_NOT_OLDER_THAN_COMMAND" });
  });

  it("a command older than the journal retention proves nothing (its entry may have been pruned)", () => {
    expect(neverSeenVerdict({ ...valid, answeredAtMs: T0 + 31 * 24 * 60 * MIN })).toEqual({ evidence: false, reason: "OUTSIDE_RETENTION" });
  });

  it("FIFO order alone is not proof: an answer before notAfter + skew proves nothing (a delayed copy could still start)", () => {
    expect(neverSeenVerdict({ ...valid, answeredAtMs: T0 + 2 * MIN })).toEqual({ evidence: false, reason: "BEFORE_START_WINDOW_CLOSED" });
    expect(neverSeenVerdict({ ...valid, answeredAtMs: valid.notAfterMs + 60_000 })).toEqual({ evidence: false, reason: "BEFORE_START_WINDOW_CLOSED" });
    expect(neverSeenVerdict({ ...valid, answeredAtMs: valid.notAfterMs + 60_001 })).toEqual({ evidence: true });
  });

  it("insufficient evidence keeps the execution and the lock as they are", () => {
    const weak = neverSeenVerdict({ ...valid, journalEpochMs: T0 + MIN });
    expect(effectOfAgentEvent({ phase: "NEVER_SEEN", neverSeen: weak })).toEqual({ kind: "NOT_EVIDENCE" });
    expect(effectOfAgentEvent({ phase: "NEVER_SEEN" })).toEqual({ kind: "NOT_EVIDENCE" });
    expect(effectOfAgentEvent({ phase: "NO_RECORD" })).toEqual({ kind: "NOT_EVIDENCE" });
    expect(holdDecision({ phase: "NEVER_SEEN", neverSeen: weak })).toBe("KEEP");
    expect(holdDecision({ phase: "NO_RECORD" })).toBe("KEEP");
  });

  it("valid evidence frees the target by retrying (X14), never by declaring success", () => {
    expect(effectOfAgentEvent({ phase: "NEVER_SEEN", neverSeen: { evidence: true } })).toEqual({ kind: "CLOSE", transition: "X14", lock: "RELEASE", cause: "AGENT_NEVER_SEEN" });
    expect(holdDecision({ phase: "NEVER_SEEN", neverSeen: { evidence: true } })).toBe("RELEASE_AUTOMATIC");
  });
});

describe("concurrency and recovery rules (AC-04 §7, §9, §10.4)", () => {
  const pinned: PersistedLockItem = { owner: "example-app-dev-7", fencingToken: 12, leaseExpiresAt: PINNED_LEASE_EXPIRES_AT };

  it("a PINNED lock is never acquirable by another execution, whatever the time", () => {
    expect(isPinned(pinned)).toBe(true);
    for (const now of [T0, T0 + 365 * 24 * 60 * MIN, Number.MAX_SAFE_INTEGER - 1]) {
      expect(evaluateLockAcquisition(pinned, "example-app-dev-8", now, 180).outcome).toBe("BUSY");
    }
  });

  it("a PINNED lock is re-entrant only for its owner and keeps its token", () => {
    expect(evaluateLockAcquisition(pinned, "example-app-dev-7", T0, 180)).toMatchObject({ outcome: "ACQUIRED", reason: "REENTRANT", fencingToken: 12 });
  });

  it("a late result can change the lock only with the owner's execution AND token", () => {
    expect(mayChangeLock(pinned, "example-app-dev-7", 12)).toBe(true);
    expect(mayChangeLock(pinned, "example-app-dev-6", 12)).toBe(false); // another execution
    expect(mayChangeLock(pinned, "example-app-dev-7", 11)).toBe(false); // an older dispatch of a reacquired lock
    expect(mayChangeLock(undefined, "example-app-dev-7", 12)).toBe(false);
  });

  it("a target never has two active commands on the agent", () => {
    const active: AgentTargetState = { highestFencingToken: 12, activeCommandId: CMD_A };
    expect(decideAcceptance(acceptance({ commandId: CMD_B, fencingToken: 13, targetState: active }))).toEqual({ decision: "NOT_STARTED", reason: "TARGET_ACTIVE" });
    expect(clearActiveCommand(active, CMD_B)).toEqual(active); // only the active command clears itself
    expect(clearActiveCommand(active, CMD_A)).toEqual({ highestFencingToken: 12 }); // the token survives
  });

  it("a journaled command is a duplicate even when it has expired since (never run twice)", () => {
    expect(decideAcceptance(acceptance({ journalHasCommand: true, nowMs: T0 + 60 * MIN }))).toEqual({ decision: "DUPLICATE" });
  });

  it("an expired or clock-skewed command never starts", () => {
    expect(decideAcceptance(acceptance({ nowMs: T0 + 5 * MIN + 1 }))).toEqual({ decision: "NOT_STARTED", reason: "EXPIRED" });
    expect(decideAcceptance(acceptance({ clockOffsetMs: 61_000 }))).toEqual({ decision: "NOT_STARTED", reason: "CLOCK_SKEW" });
  });

  it("every unknown outcome keeps the lock held; only never-started evidence releases a hold automatically", () => {
    for (const facts of [
      { phase: "LOST" as const },
      { phase: "FINISHED" as const, exitCode: 0, timedOut: true },
      { phase: "FINISHED" as const, exitCode: 70, timedOut: false },
      { phase: "FINISHED" as const, exitCode: 99, timedOut: false },
    ]) {
      expect(effectOfAgentEvent(facts)).toMatchObject({ kind: "CLOSE", transition: "X16", lock: "HOLD" });
    }
    expect(holdDecision({ phase: "FINISHED", exitCode: 0, timedOut: false })).toBe("OPERATOR_REQUIRED");
    expect(holdDecision({ phase: "LOST" })).toBe("OPERATOR_REQUIRED");
    expect(holdDecision({ phase: "HEARTBEAT" })).toBe("KEEP");
    expect(holdDecision({ phase: "NOT_STARTED", reason: "ABANDONED" })).toBe("RELEASE_AUTOMATIC");
  });

  it("progress events never close an execution or touch the lock", () => {
    for (const phase of ["ACCEPTED", "STARTED", "HEARTBEAT", "LOG_UPLOADED"] as const) expect(effectOfAgentEvent({ phase })).toEqual({ kind: "PROGRESS" });
  });

  it("maps every closing event to an EXISTING transition (no new state, no new transition)", () => {
    expect(effectOfAgentEvent({ phase: "FINISHED", exitCode: 0, timedOut: false })).toMatchObject({ transition: "X12", lock: "RELEASE" });
    for (const code of [10, 20, 30, 40]) expect(effectOfAgentEvent({ phase: "FINISHED", exitCode: code, timedOut: false })).toMatchObject({ transition: "X13", lock: "RELEASE" });
    expect(effectOfAgentEvent({ phase: "FINISHED", exitCode: 50, timedOut: false })).toMatchObject({ transition: "X14", lock: "RELEASE" });
    const retry: NotStartedReason[] = ["EXPIRED", "BUSY", "ABANDONED", "CLOCK_SKEW", "PREDATES_JOURNAL", "TARGET_ACTIVE"];
    for (const reason of retry) expect(effectOfAgentEvent({ phase: "NOT_STARTED", reason })).toMatchObject({ transition: "X14", lock: "RELEASE" });
    const reject: NotStartedReason[] = ["STALE_FENCING", "REJECTED_SCHEMA", "REJECTED_SENDER", "REJECTED_AGENT", "REJECTED_TARGET", "REJECTED_SCRIPT", "REJECTED_ARGS", "REJECTED_CONFIG"];
    for (const reason of reject) expect(effectOfAgentEvent({ phase: "NOT_STARTED", reason })).toMatchObject({ transition: "X11", lock: "RELEASE" });
  });

  it("the hard deadline covers the whole start window, the timeout, the kill grace, the skew and the margin", () => {
    const notAfterMs = T0 + 5 * MIN;
    const deadline = hardDeadlineAt({ notAfterMs, timeoutSeconds: 1200, killGraceSeconds: 30, clockSkewSeconds: 60, safetyMarginSeconds: 120 });
    expect(deadline).toBe(notAfterMs + (1200 + 30 + 60 + 120) * 1000);
    expect(() => hardDeadlineAt({ notAfterMs, timeoutSeconds: -1, killGraceSeconds: 30, clockSkewSeconds: 60, safetyMarginSeconds: 120 })).toThrow();
  });

  it("AP-7 defaults are the approved values", () => {
    expect(AGENT_PROTOCOL_DEFAULTS).toMatchObject({ notAfterSeconds: 300, heartbeatSeconds: 60, killGraceSeconds: 30, clockSkewSeconds: 60, safetyMarginSeconds: 120 });
  });
});
