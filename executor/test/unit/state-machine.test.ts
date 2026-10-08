// @akili-spec changes/cicd-executor-poc design §7.3, DD-04, DD-28; requirements FR-05, FR-16, RL-4, RL-7
//
// Proves the execution state machine is EXACTLY the closed list X1-X16 of
// design §7.3. The core is an exhaustive product: (source state incl. "no
// execution" x every permitted-transition request) and the full 9 x 8
// source-state x target-state matrix. The expectations below are transcribed
// independently from the design table; nothing is derived from the
// implementation beyond its vocabulary.

import { describe, expect, it } from "vitest";
import {
  applyTransition,
  EXECUTION_STATUSES,
  LOCK_WAIT_BUDGET_MS,
  MAX_LOCK_WAIT_ATTEMPTS,
  PER_ATTEMPT_FIELDS,
  TERMINAL_EXECUTION_STATUSES,
  TRANSITION_IDS,
  type CreationChecks,
  type ExecutionSnapshot,
  type ExecutionStatus,
  type TransitionId,
  type TransitionRequest,
} from "../../src/domain/state-machine/index.js";
import {
  classifyExitCode,
  DOMAIN_ERROR_CODES,
  FAILURE_CODES,
  isDomainErrorCode,
  REJECT_REASONS,
} from "../../src/domain/errors/index.js";

type From = ExecutionStatus | "NONE";
const FROM_STATES: readonly From[] = ["NONE", ...EXECUTION_STATUSES];

const TOKEN = "tok-1";
const GOOD_CHECKS: CreationChecks = {
  senderAuthorized: true,
  schemaValid: true,
  requestIdMatches: true,
  targetKnown: true,
  targetValid: true,
  sourceAuthorized: true,
  dedupeClaimOwned: true,
};

interface Row {
  readonly id: TransitionId;
  readonly from: From;
  readonly to: ExecutionStatus;
  /** Request whose guard is satisfied. */
  readonly request: TransitionRequest;
  /** Snapshot extras needed for the guard when the source state matches. */
  readonly snapshot?: Partial<ExecutionSnapshot>;
}

const exit = (exitCode: number, over: Partial<Extract<TransitionRequest, { kind: "SCRIPT_EXITED" }>> = {}): TransitionRequest => ({
  kind: "SCRIPT_EXITED",
  dispatchToken: TOKEN,
  exitCode,
  v3Valid: true,
  now: 100_000,
  nextAttemptAt: 130_000,
  ...over,
});

// Independent transcription of design §7.3 (one row per X-id; X13 and X16 have
// several triggers, listed as extra rows sharing the id).
const ROWS: readonly Row[] = [
  { id: "X1", from: "NONE", to: "QUEUED", request: { kind: "CREATE", checks: GOOD_CHECKS } },
  { id: "X2", from: "NONE", to: "REJECTED", request: { kind: "CREATE", checks: { ...GOOD_CHECKS, senderAuthorized: false } } },
  { id: "X3", from: "QUEUED", to: "SUPERSEDED", request: { kind: "SUPERSEDE_QUEUED", superseded: true } },
  { id: "X4", from: "QUEUED", to: "FAILED", request: { kind: "EVALUATE_QUEUED", v1Valid: false, now: 5 } },
  { id: "X5", from: "QUEUED", to: "WAITING_LOCK", request: { kind: "EVALUATE_QUEUED", v1Valid: true, now: 5 } },
  { id: "X6", from: "WAITING_LOCK", to: "SUPERSEDED", request: { kind: "SUPERSEDE_UNDER_LOCK", superseded: true, lockHeld: true } },
  { id: "X7", from: "WAITING_LOCK", to: "FAILED", request: { kind: "LOCK_WAIT_TIMEOUT", now: LOCK_WAIT_BUDGET_MS }, snapshot: { lockWaitStartedAt: 0 } },
  { id: "X8", from: "WAITING_LOCK", to: "FAILED", request: { kind: "WAITING_WINDOW_CLOSED", v2Valid: false } },
  {
    id: "X9", from: "WAITING_LOCK", to: "DEPLOYING",
    request: { kind: "BEGIN_DISPATCH", v2Valid: true, lockAcquired: true, superseded: false, newDispatchToken: "tok-2" },
  },
  { id: "X10", from: "DEPLOYING", to: "FAILED", request: { kind: "WINDOW_CLOSED_BEFORE_EXEC", dispatchToken: TOKEN, v4Valid: false } },
  { id: "X11", from: "DEPLOYING", to: "FAILED", request: { kind: "FAIL_BEFORE_EXEC", dispatchToken: TOKEN, code: "SSH_CONNECT" } },
  { id: "X11", from: "DEPLOYING", to: "FAILED", request: { kind: "FAIL_BEFORE_EXEC", dispatchToken: TOKEN, code: "HOST_KEY_MISMATCH" } },
  { id: "X11", from: "DEPLOYING", to: "FAILED", request: { kind: "RECONCILE_OVERDUE_DEPLOYING", now: 2_000 }, snapshot: { deadlineAt: 1_000 } },
  { id: "X12", from: "DEPLOYING", to: "SUCCEEDED", request: exit(0) },
  { id: "X13", from: "DEPLOYING", to: "FAILED", request: exit(10) },
  { id: "X13", from: "DEPLOYING", to: "FAILED", request: exit(20) },
  { id: "X13", from: "DEPLOYING", to: "FAILED", request: exit(30) },
  { id: "X13", from: "DEPLOYING", to: "FAILED", request: exit(40) },
  { id: "X14", from: "DEPLOYING", to: "WAITING_LOCK", request: exit(50), snapshot: { lockWaitStartedAt: 0, attempt: 1 } },
  { id: "X15", from: "DEPLOYING", to: "FAILED", request: exit(50, { v3Valid: false }), snapshot: { lockWaitStartedAt: 0, attempt: 1 } },
  { id: "X15", from: "DEPLOYING", to: "FAILED", request: exit(50, { now: LOCK_WAIT_BUDGET_MS }), snapshot: { lockWaitStartedAt: 0, attempt: 1 } },
  { id: "X16", from: "DEPLOYING", to: "UNKNOWN_TARGET_STATE", request: exit(2), snapshot: { execStartedAt: 50 } },
  { id: "X16", from: "DEPLOYING", to: "UNKNOWN_TARGET_STATE", request: exit(137), snapshot: { execStartedAt: 50 } },
  { id: "X16", from: "DEPLOYING", to: "UNKNOWN_TARGET_STATE", request: { kind: "SESSION_LOST", dispatchToken: TOKEN }, snapshot: { execStartedAt: 50 } },
  { id: "X16", from: "DEPLOYING", to: "UNKNOWN_TARGET_STATE", request: { kind: "RECONCILE_OVERDUE_DEPLOYING", now: 2_000 }, snapshot: { deadlineAt: 1_000, execStartedAt: 50 } },
];

/** Builds a snapshot for any status, with guard-relevant extras. */
function snap(status: ExecutionStatus, extras: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    status,
    attempt: status === "DEPLOYING" ? 1 : 0,
    contentionCount: 0,
    lockWaitStartedAt: 0,
    dispatchToken: status === "DEPLOYING" ? TOKEN : undefined,
    ...extras,
  } as ExecutionSnapshot;
}

function current(row: Row, from: From): ExecutionSnapshot | null {
  if (from === "NONE") return null;
  // Guard extras always travel with the row, whatever the source state, so a
  // wrong-source rejection can only come from the source state itself.
  return snap(from, row.snapshot);
}

describe("closed transition list X1-X16 (design §7.3)", () => {
  it("defines exactly the 8 FR-05 states, 5 terminal, and no RECEIVED (CW-3)", () => {
    expect([...EXECUTION_STATUSES].sort()).toEqual(
      ["DEPLOYING", "FAILED", "QUEUED", "REJECTED", "SUCCEEDED", "SUPERSEDED", "UNKNOWN_TARGET_STATE", "WAITING_LOCK"],
    );
    expect([...TERMINAL_EXECUTION_STATUSES].sort()).toEqual(
      ["FAILED", "REJECTED", "SUCCEEDED", "SUPERSEDED", "UNKNOWN_TARGET_STATE"],
    );
    expect(EXECUTION_STATUSES as readonly string[]).not.toContain("RECEIVED");
    expect(TRANSITION_IDS).toHaveLength(16);
  });

  it("every one of the 16 ids is covered by at least one row", () => {
    expect(new Set(ROWS.map((r) => r.id))).toEqual(new Set(TRANSITION_IDS));
  });

  describe.each(ROWS.map((r, i) => ({ ...r, label: `${r.id} #${i} ${r.request.kind}` })))(
    "row $label",
    (row) => {
      it("is accepted from its source state with its guard satisfied, landing on the documented state", () => {
        const result = applyTransition(current(row, row.from), row.request);
        expect(result.accepted).toBe(true);
        if (!result.accepted) return;
        expect(result.transitionId).toBe(row.id);
        expect(result.next.status).toBe(row.to);
        expect(result.effects.terminal).toBe(TERMINAL_EXECUTION_STATUSES.has(row.to));
      });

      it("is rejected as INVALID_TRANSITION from EVERY other source state (state x request matrix)", () => {
        for (const from of FROM_STATES) {
          if (from === row.from) continue;
          expect(applyTransition(current(row, from), row.request), `${row.id} from ${from}`).toEqual({
            accepted: false,
            code: "INVALID_TRANSITION",
          });
        }
      });
    },
  );

  // Independent transcription of the (from, to) edge set of design §7.3.
  const EXPECTED_EDGES = new Set<string>([
    "NONE>QUEUED", "NONE>REJECTED",
    "QUEUED>SUPERSEDED", "QUEUED>FAILED", "QUEUED>WAITING_LOCK",
    "WAITING_LOCK>SUPERSEDED", "WAITING_LOCK>FAILED", "WAITING_LOCK>DEPLOYING",
    "DEPLOYING>FAILED", "DEPLOYING>SUCCEEDED", "DEPLOYING>WAITING_LOCK", "DEPLOYING>UNKNOWN_TARGET_STATE",
  ]);

  it("exhaustive source x target matrix (9 x 8 = 72 pairs): exactly the listed edges are reachable, all others rejected", () => {
    const reached = new Set<string>();
    for (const row of ROWS) {
      for (const from of FROM_STATES) {
        const r = applyTransition(current(row, from), row.request);
        if (r.accepted) reached.add(`${from}>${r.next.status}`);
      }
    }
    let checked = 0;
    for (const from of FROM_STATES) {
      for (const to of EXECUTION_STATUSES) {
        checked += 1;
        expect(reached.has(`${from}>${to}`), `${from} -> ${to}`).toBe(EXPECTED_EDGES.has(`${from}>${to}`));
      }
    }
    expect(checked).toBe(72);
    expect(reached).toEqual(EXPECTED_EDGES);
  });

  it("terminal states are immutable against every request (all guards satisfied)", () => {
    for (const row of ROWS) {
      for (const terminal of TERMINAL_EXECUTION_STATUSES) {
        expect(applyTransition(snap(terminal, row.snapshot), row.request), `${terminal} / ${row.id}`).toEqual({
          accepted: false,
          code: "INVALID_TRANSITION",
        });
      }
    }
  });

  it("X14 is the only backward edge: every accepted edge moves forward in rank except DEPLOYING -> WAITING_LOCK", () => {
    const rank: Record<ExecutionStatus, number> = {
      QUEUED: 0, WAITING_LOCK: 1, DEPLOYING: 2,
      SUCCEEDED: 3, FAILED: 3, SUPERSEDED: 3, REJECTED: 3, UNKNOWN_TARGET_STATE: 3,
    };
    const backward = new Set<string>();
    for (const row of ROWS) {
      for (const from of FROM_STATES) {
        if (from === "NONE") continue;
        const r = applyTransition(current(row, from), row.request);
        if (r.accepted && rank[r.next.status] < rank[from]) backward.add(`${r.transitionId}:${from}>${r.next.status}`);
      }
    }
    expect([...backward]).toEqual(["X14:DEPLOYING>WAITING_LOCK"]);
  });

  it("an unlisted DEPLOYING -> QUEUED can never be produced by any request (falsifier target)", () => {
    for (const row of ROWS) {
      const r = applyTransition(current(row, "DEPLOYING"), row.request);
      if (r.accepted) expect(r.next.status).not.toBe("QUEUED");
    }
  });
});

describe("creations X1 / X2 (CW-3: no RECEIVED)", () => {
  it("X1 creates QUEUED when every check passes", () => {
    const r = applyTransition(null, { kind: "CREATE", checks: GOOD_CHECKS });
    expect(r).toMatchObject({ accepted: true, transitionId: "X1", next: { status: "QUEUED", attempt: 0 } });
  });

  it.each([
    ["senderAuthorized", "UNAUTHORIZED_SENDER"],
    ["schemaValid", "SCHEMA_INVALID"],
    ["requestIdMatches", "REQUEST_ID_MISMATCH"],
    ["targetKnown", "TARGET_UNKNOWN"],
    ["targetValid", "TARGET_INVALID"],
    ["sourceAuthorized", "TARGET_NOT_AUTHORIZED"],
  ] as const)("X2 rejects with %s failing -> %s (no sequence)", (field, reason) => {
    const r = applyTransition(null, { kind: "CREATE", checks: { ...GOOD_CHECKS, [field]: false } });
    expect(r).toMatchObject({ accepted: true, transitionId: "X2", rejectReason: reason, next: { status: "REJECTED" } });
  });

  it("X2 reports the first failing reason when several fail (sender first)", () => {
    const r = applyTransition(null, {
      kind: "CREATE",
      checks: { ...GOOD_CHECKS, senderAuthorized: false, schemaValid: false, sourceAuthorized: false },
    });
    expect(r).toMatchObject({ rejectReason: "UNAUTHORIZED_SENDER" });
  });

  it("target checks keep the design §6.3 order: unknown, then invalid, then not authorized (AC-02 V1)", () => {
    const r = applyTransition(null, { kind: "CREATE", checks: { ...GOOD_CHECKS, targetValid: false, sourceAuthorized: false } });
    expect(r).toMatchObject({ rejectReason: "TARGET_INVALID" });
    const u = applyTransition(null, { kind: "CREATE", checks: { ...GOOD_CHECKS, targetKnown: false, targetValid: false, sourceAuthorized: false } });
    expect(u).toMatchObject({ rejectReason: "TARGET_UNKNOWN" });
  });

  it("every rejection reason is reachable", () => {
    const seen = new Set<string>();
    for (const field of ["senderAuthorized", "schemaValid", "requestIdMatches", "targetKnown", "targetValid", "sourceAuthorized"] as const) {
      const r = applyTransition(null, { kind: "CREATE", checks: { ...GOOD_CHECKS, [field]: false } });
      if (r.accepted && r.rejectReason) seen.add(r.rejectReason);
    }
    expect(seen).toEqual(new Set(REJECT_REASONS));
  });

  it("X1 requires the owned dedupe claim: without it there is no creation (duplicate is a no-op, FR-07)", () => {
    expect(applyTransition(null, { kind: "CREATE", checks: { ...GOOD_CHECKS, dedupeClaimOwned: false } })).toEqual({
      accepted: false,
      code: "INVALID_TRANSITION",
    });
  });

  it.each([
    ["senderAuthorized", "UNAUTHORIZED_SENDER"],
    ["schemaValid", "SCHEMA_INVALID"],
    ["requestIdMatches", "REQUEST_ID_MISMATCH"],
    ["targetKnown", "TARGET_UNKNOWN"],
    ["targetValid", "TARGET_INVALID"],
    ["sourceAuthorized", "TARGET_NOT_AUTHORIZED"],
  ] as const)(
    "X2 does NOT need a dedupe claim (rejection precedes the claim; REJECT#MSG# case): %s failing -> %s",
    (field, reason) => {
      const r = applyTransition(null, { kind: "CREATE", checks: { ...GOOD_CHECKS, [field]: false, dedupeClaimOwned: false } });
      expect(r).toMatchObject({ accepted: true, transitionId: "X2", rejectReason: reason, next: { status: "REJECTED" } });
    },
  );

  it("a creation against an existing execution is rejected; a non-creation against none is rejected", () => {
    expect(applyTransition(snap("QUEUED"), { kind: "CREATE", checks: GOOD_CHECKS }).accepted).toBe(false);
    expect(applyTransition(null, { kind: "SUPERSEDE_QUEUED", superseded: true }).accepted).toBe(false);
  });
});

describe("guard-negative cases per row", () => {
  const rejected = { accepted: false, code: "INVALID_TRANSITION" } as const;

  it("X3 needs S1 to say superseded", () => {
    expect(applyTransition(snap("QUEUED"), { kind: "SUPERSEDE_QUEUED", superseded: false })).toEqual(rejected);
  });

  it("X4 is not taken when V1 is valid; X5 sets lockWaitStartedAt and nextAttemptAt = now", () => {
    const r = applyTransition(snap("QUEUED"), { kind: "EVALUATE_QUEUED", v1Valid: true, now: 777 });
    expect(r).toMatchObject({ transitionId: "X5", next: { lockWaitStartedAt: 777, nextAttemptAt: 777 } });
    const f = applyTransition(snap("QUEUED"), { kind: "EVALUATE_QUEUED", v1Valid: false, now: 777 });
    expect(f).toMatchObject({ transitionId: "X4", next: { status: "FAILED", error: { code: "DEPLOY_WINDOW_CLOSED" } } });
  });

  it("X6 needs the lock held and S2 superseded", () => {
    expect(applyTransition(snap("WAITING_LOCK"), { kind: "SUPERSEDE_UNDER_LOCK", superseded: true, lockHeld: false })).toEqual(rejected);
    expect(applyTransition(snap("WAITING_LOCK"), { kind: "SUPERSEDE_UNDER_LOCK", superseded: false, lockHeld: true })).toEqual(rejected);
  });

  it("X7 also fires at the lock-wait safety cap (10 lock attempts) with time still left; 9 attempts do not (boundary)", () => {
    const at = (n: number) => snap("WAITING_LOCK", { lockWaitStartedAt: 1_000, lockWaitAttempts: n });
    const req = { kind: "LOCK_WAIT_TIMEOUT", now: 2_000 } as const;
    expect(applyTransition(at(MAX_LOCK_WAIT_ATTEMPTS - 1), req)).toEqual(rejected);
    expect(applyTransition(at(MAX_LOCK_WAIT_ATTEMPTS), req)).toMatchObject({
      transitionId: "X7",
      next: { status: "FAILED", error: { code: "LOCK_TIMEOUT" } },
    });
  });

  it("X7 needs the full 1,800 s elapsed (boundary) and a lockWaitStartedAt", () => {
    const s = snap("WAITING_LOCK", { lockWaitStartedAt: 1_000 });
    expect(applyTransition(s, { kind: "LOCK_WAIT_TIMEOUT", now: 1_000 + LOCK_WAIT_BUDGET_MS - 1 })).toEqual(rejected);
    expect(applyTransition(s, { kind: "LOCK_WAIT_TIMEOUT", now: 1_000 + LOCK_WAIT_BUDGET_MS })).toMatchObject({
      transitionId: "X7",
      next: { error: { code: "LOCK_TIMEOUT" } },
    });
    expect(
      applyTransition(snap("WAITING_LOCK", { lockWaitStartedAt: undefined }), { kind: "LOCK_WAIT_TIMEOUT", now: 9e9 }),
    ).toEqual(rejected);
  });

  it("X8 needs V2 to fail", () => {
    expect(applyTransition(snap("WAITING_LOCK"), { kind: "WAITING_WINDOW_CLOSED", v2Valid: true })).toEqual(rejected);
  });

  it.each([
    ["V2 invalid", { v2Valid: false }],
    ["lock not acquired", { lockAcquired: false }],
    ["S2 superseded", { superseded: true }],
    ["empty token", { newDispatchToken: "" }],
  ] as const)("X9 is not taken when %s", (_name, over) => {
    const req: TransitionRequest = {
      kind: "BEGIN_DISPATCH", v2Valid: true, lockAcquired: true, superseded: false, newDispatchToken: "t", ...over,
    };
    expect(applyTransition(snap("WAITING_LOCK"), req)).toEqual(rejected);
  });

  it("X9 increments attempt, sets the new dispatchToken, clears per-attempt fields, and asks for the highestDispatched raise", () => {
    const dirty = snap("WAITING_LOCK", {
      attempt: 1, dispatchToken: "old", execStartedAt: 9, result: { exitCode: 50 },
      error: { code: "LOCK_TIMEOUT" }, lockLostDuringRun: true, targetWriteRejected: true, windowClosedDuringRun: true,
    });
    const r = applyTransition(dirty, {
      kind: "BEGIN_DISPATCH", v2Valid: true, lockAcquired: true, superseded: false, newDispatchToken: "new",
    });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.next).toMatchObject({ status: "DEPLOYING", attempt: 2, dispatchToken: "new" });
    for (const f of PER_ATTEMPT_FIELDS) expect(r.next, f).not.toHaveProperty(f);
    expect(r.effects.clear).toEqual(PER_ATTEMPT_FIELDS);
    expect(r.effects.raiseHighestDispatched).toBe(true);
  });

  describe("X10 / X11 read execStartedAt of the current dispatchToken (CW-1)", () => {
    it("X10 is not allowed once execStartedAt is set", () => {
      const s = snap("DEPLOYING", { execStartedAt: 5 });
      expect(applyTransition(s, { kind: "WINDOW_CLOSED_BEFORE_EXEC", dispatchToken: TOKEN, v4Valid: false })).toEqual(rejected);
    });
    it("X10 is not allowed when V4 is valid", () => {
      expect(applyTransition(snap("DEPLOYING"), { kind: "WINDOW_CLOSED_BEFORE_EXEC", dispatchToken: TOKEN, v4Valid: true })).toEqual(rejected);
    });
    it.each(["SSH_CONNECT", "HOST_KEY_MISMATCH"] as const)(
      "X11 %s is allowed only before exec",
      (code) => {
        expect(applyTransition(snap("DEPLOYING"), { kind: "FAIL_BEFORE_EXEC", dispatchToken: TOKEN, code })).toMatchObject({
          transitionId: "X11",
          next: { status: "FAILED", error: { code } },
        });
        expect(
          applyTransition(snap("DEPLOYING", { execStartedAt: 5 }), { kind: "FAIL_BEFORE_EXEC", dispatchToken: TOKEN, code }),
        ).toEqual(rejected);
      },
    );
    it("DISPATCH_INTERRUPTED is not accepted from FAIL_BEFORE_EXEC: only the reconciler request produces it", () => {
      const req = { kind: "FAIL_BEFORE_EXEC", dispatchToken: TOKEN, code: "DISPATCH_INTERRUPTED" } as unknown as TransitionRequest;
      expect(applyTransition(snap("DEPLOYING"), req)).toEqual(rejected);
    });
    it("a stale dispatchToken is rejected by every DEPLOYING row", () => {
      const s = snap("DEPLOYING", { execStartedAt: 5, lockWaitStartedAt: 0 });
      const stale: TransitionRequest[] = [
        { kind: "WINDOW_CLOSED_BEFORE_EXEC", dispatchToken: "old", v4Valid: false },
        { kind: "FAIL_BEFORE_EXEC", dispatchToken: "old", code: "SSH_CONNECT" },
        exit(0, { dispatchToken: "old" }),
        exit(10, { dispatchToken: "old" }),
        exit(50, { dispatchToken: "old" }),
        exit(2, { dispatchToken: "old" }),
        { kind: "SESSION_LOST", dispatchToken: "old" },
      ];
      for (const req of stale) expect(applyTransition(s, req), req.kind).toEqual(rejected);
    });
  });

  describe("X16 requires execStartedAt (DD-28)", () => {
    it("exit 2 / unknown exit / lost session without execStartedAt is NOT X16", () => {
      const s = snap("DEPLOYING");
      expect(applyTransition(s, exit(2))).toEqual(rejected);
      expect(applyTransition(s, { kind: "SESSION_LOST", dispatchToken: TOKEN })).toEqual(rejected);
    });
    it("appends to TARGET.unresolved[] in the same write and is terminal", () => {
      const r = applyTransition(snap("DEPLOYING", { execStartedAt: 5 }), exit(255));
      expect(r).toMatchObject({
        transitionId: "X16",
        next: { status: "UNKNOWN_TARGET_STATE", error: { code: "UNKNOWN_TARGET_STATE" } },
        effects: { appendTargetUnresolved: true, conditionOnDispatchToken: true, terminal: true },
      });
    });
    it("reconciler: overdue DEPLOYING resolves by execStartedAt (X16 vs X11 DISPATCH_INTERRUPTED); not overdue is rejected", () => {
      const overdue = { kind: "RECONCILE_OVERDUE_DEPLOYING", now: 2_000 } as const;
      expect(applyTransition(snap("DEPLOYING", { deadlineAt: 1_000, execStartedAt: 7 }), overdue)).toMatchObject({ transitionId: "X16" });
      expect(applyTransition(snap("DEPLOYING", { deadlineAt: 1_000 }), overdue)).toMatchObject({
        transitionId: "X11",
        next: { error: { code: "DISPATCH_INTERRUPTED" } },
      });
      expect(applyTransition(snap("DEPLOYING", { deadlineAt: 2_000 }), overdue)).toEqual(rejected);
      expect(applyTransition(snap("DEPLOYING", { deadlineAt: 5_000 }), overdue)).toEqual(rejected);
      expect(applyTransition(snap("DEPLOYING"), overdue)).toEqual(rejected);
    });
  });

  describe("exit-code mapping (RL-4, RL-7)", () => {
    it("exit 2 maps to UNKNOWN_TARGET_STATE (X16), not to a distinct usage outcome", () => {
      const r = applyTransition(snap("DEPLOYING", { execStartedAt: 5 }), exit(2));
      expect(r).toMatchObject({ transitionId: "X16", next: { status: "UNKNOWN_TARGET_STATE" } });
    });

    it("every integer exit code 0..255 plus odd values lands on exactly the documented row", () => {
      const expected = new Map<number, TransitionId>([
        [0, "X12"], [10, "X13"], [20, "X13"], [30, "X13"], [40, "X13"], [50, "X14"],
      ]);
      const codes = [...Array.from({ length: 256 }, (_, i) => i), -1, -15, 256, 1000, 1.5, Number.NaN, Infinity];
      for (const code of codes) {
        const r = applyTransition(snap("DEPLOYING", { execStartedAt: 5, lockWaitStartedAt: 0, attempt: 1 }), exit(code));
        expect(r.accepted, `exit ${code}`).toBe(true);
        if (r.accepted) expect(r.transitionId, `exit ${code}`).toBe(expected.get(code) ?? "X16");
      }
    });

    it("X13 maps 10/20/30/40 to PULL/MIGRATION/START/HEALTH and records the exit code", () => {
      const map = { 10: "PULL", 20: "MIGRATION", 30: "START", 40: "HEALTH" } as const;
      for (const [code, failure] of Object.entries(map)) {
        const r = applyTransition(snap("DEPLOYING"), exit(Number(code)));
        expect(r).toMatchObject({
          transitionId: "X13",
          next: { status: "FAILED", error: { code: failure }, result: { exitCode: Number(code) } },
        });
      }
    });

    it("X12 does not require execStartedAt (guard is exit 0 of the current token) and records the result", () => {
      expect(applyTransition(snap("DEPLOYING"), exit(0))).toMatchObject({ transitionId: "X12", next: { result: { exitCode: 0 } } });
    });
  });

  describe("X14 / X15 (exit 50)", () => {
    const deploying = (extras: Partial<ExecutionSnapshot> = {}) =>
      snap("DEPLOYING", { attempt: 1, lockWaitStartedAt: 0, execStartedAt: 10, contentionCount: 2, ...extras });

    it("X14 clears execStartedAt and per-attempt fields, sets nextAttemptAt, counts the contention, keeps lockWaitStartedAt", () => {
      const s = deploying({ result: { exitCode: 50 }, lockLostDuringRun: true, windowClosedDuringRun: true });
      const r = applyTransition(s, exit(50, { nextAttemptAt: 130_000 }));
      expect(r.accepted).toBe(true);
      if (!r.accepted) return;
      expect(r.transitionId).toBe("X14");
      expect(r.next).toMatchObject({ status: "WAITING_LOCK", nextAttemptAt: 130_000, contentionCount: 3, lockWaitStartedAt: 0 });
      for (const f of PER_ATTEMPT_FIELDS) expect(r.next, f).not.toHaveProperty(f);
      expect(r.effects).toMatchObject({ clear: PER_ATTEMPT_FIELDS, conditionOnDispatchToken: true, terminal: false });
    });

    it("exit 50 with V3 failing is X15 DEPLOY_WINDOW_CLOSED", () => {
      expect(applyTransition(deploying(), exit(50, { v3Valid: false }))).toMatchObject({
        transitionId: "X15",
        next: { status: "FAILED", error: { code: "DEPLOY_WINDOW_CLOSED" } },
      });
    });

    it("exit 50 with the budget exhausted is X15 LOCK_TIMEOUT (boundary at exactly 1,800 s; one ms earlier is X14)", () => {
      expect(applyTransition(deploying(), exit(50, { now: LOCK_WAIT_BUDGET_MS }))).toMatchObject({
        transitionId: "X15",
        next: { error: { code: "LOCK_TIMEOUT" } },
      });
      expect(applyTransition(deploying(), exit(50, { now: LOCK_WAIT_BUDGET_MS - 1 }))).toMatchObject({ transitionId: "X14" });
    });

    it("the lock-wait safety cap (lockWaitAttempts = 10) exhausts the budget even when time remains; 9 does not", () => {
      expect(applyTransition(deploying({ lockWaitAttempts: MAX_LOCK_WAIT_ATTEMPTS }), exit(50))).toMatchObject({
        transitionId: "X15",
        next: { error: { code: "LOCK_TIMEOUT" } },
      });
      expect(applyTransition(deploying({ lockWaitAttempts: MAX_LOCK_WAIT_ATTEMPTS - 1 }), exit(50))).toMatchObject({
        transitionId: "X14",
      });
    });

    it("a high `attempt` alone (no lockWaitAttempts fact) does not exhaust the budget", () => {
      expect(applyTransition(deploying({ attempt: 50 }), exit(50))).toMatchObject({ transitionId: "X14" });
    });

    it("exit 50 without lockWaitStartedAt has no budget to draw from: X15, never X14", () => {
      expect(applyTransition(deploying({ lockWaitStartedAt: undefined }), exit(50))).toMatchObject({ transitionId: "X15" });
    });

    it("exit 50 -> X14 -> next attempt with V4 failing -> X10 is reachable (CW-1)", () => {
      let s: ExecutionSnapshot = snap("WAITING_LOCK", { lockWaitStartedAt: 0, attempt: 0 });
      const begin = (token: string): TransitionRequest => ({
        kind: "BEGIN_DISPATCH", v2Valid: true, lockAcquired: true, superseded: false, newDispatchToken: token,
      });
      const step = (req: TransitionRequest, id: TransitionId) => {
        const r = applyTransition(s, req);
        expect(r.accepted, `${id}`).toBe(true);
        if (!r.accepted) throw new Error("unreachable");
        expect(r.transitionId).toBe(id);
        s = r.next;
      };
      step(begin("t1"), "X9");
      // phase 2 of DD-28 for attempt 1 (written by the coordinator, not by a transition)
      s = { ...s, execStartedAt: 123 };
      step(exit(50, { dispatchToken: "t1", now: 60_000, nextAttemptAt: 90_000 }), "X14");
      expect(s.execStartedAt).toBeUndefined();
      step(begin("t2"), "X9");
      expect(s.attempt).toBe(2);
      // The stale token of attempt 1 can no longer drive this execution.
      expect(applyTransition(s, { kind: "WINDOW_CLOSED_BEFORE_EXEC", dispatchToken: "t1", v4Valid: false }).accepted).toBe(false);
      step({ kind: "WINDOW_CLOSED_BEFORE_EXEC", dispatchToken: "t2", v4Valid: false }, "X10");
      expect(s).toMatchObject({ status: "FAILED", error: { code: "DEPLOY_WINDOW_CLOSED" } });
    });

    it("a stale redelivery of exit 50 for the previous attempt cannot bounce a live attempt back (token guard)", () => {
      const live = snap("DEPLOYING", { attempt: 2, dispatchToken: "t2", lockWaitStartedAt: 0 });
      expect(applyTransition(live, exit(50, { dispatchToken: "t1" }))).toEqual(rejected);
    });
  });

  it("transitions are pure: the input snapshot is never mutated", () => {
    const s = Object.freeze({ ...snap("DEPLOYING", { execStartedAt: 5, lockWaitStartedAt: 0, attempt: 1 }) });
    const before = JSON.stringify(s);
    for (const code of [0, 10, 50, 2]) applyTransition(s, exit(code));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("domain error codes (design §7.2, §15.1)", () => {
  it("drops the v2 CI/step codes and keeps the closed set", () => {
    for (const dropped of ["SOURCE_CLONE", "SOURCE_PREP", "ARTIFACT_UPLOAD", "INFRA", "QUALITY", "BUILD", "TIMED_OUT", "TARGET_BUSY"]) {
      expect(isDomainErrorCode(dropped), dropped).toBe(false);
    }
    expect([...FAILURE_CODES].sort()).toEqual(
      ["DEPLOY_WINDOW_CLOSED", "DISPATCH_INTERRUPTED", "HEALTH", "HOST_KEY_MISMATCH", "LOCK_TIMEOUT", "MIGRATION", "PULL", "SSH_CONNECT", "START"],
    );
  });

  it("includes DISPATCH_INTERRUPTED, UNKNOWN_TARGET_STATE, INVALID_TRANSITION and all X2 rejection reasons", () => {
    for (const code of ["DISPATCH_INTERRUPTED", "UNKNOWN_TARGET_STATE", "INVALID_TRANSITION", "SUPERSEDED", ...REJECT_REASONS]) {
      expect(DOMAIN_ERROR_CODES as readonly string[], code).toContain(code);
    }
  });

  it("classifyExitCode: only 0/10/20/30/40/50 are known (RL-4)", () => {
    expect(classifyExitCode(0)).toEqual({ kind: "SUCCESS" });
    expect(classifyExitCode(50)).toEqual({ kind: "TARGET_BUSY" });
    expect(classifyExitCode(30)).toEqual({ kind: "FAILED", code: "START" });
    for (const unknown of [1, 2, 3, 127, 130, 255, -1]) expect(classifyExitCode(unknown), String(unknown)).toEqual({ kind: "UNKNOWN" });
  });
});
