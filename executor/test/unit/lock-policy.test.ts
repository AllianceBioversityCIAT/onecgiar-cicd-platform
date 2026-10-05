// @akili-spec changes/cicd-executor-poc design DD-09, §7.6; requirements FR-11, FR-16 F17-F18
//
// Proves the pure lock-policy decision logic: the exact lock-wait schedule
// of §7.6 (clipped to the remaining budget, never more than 900 s per
// message), the safety cap, the supersede comparison, and the
// acquire/renew/release ownership rules of DD-09.
//
// Expected values are transcribed independently from design §7.6's table and
// FR-11's scenarios (not derived from this module's own arithmetic), so a
// wrong implementation cannot satisfy them by construction.

import { describe, expect, it } from "vitest";
import {
  canReleaseLock,
  canRenewLock,
  evaluateLockAcquisition,
  evaluateSupersede,
  LOCK_RENEWAL_INTERVAL_SECONDS,
  nextLockRetry,
  type PersistedLockItem,
} from "../../src/domain/lock-policy/index.js";

// Independent source of truth for the "never more than 900s per SQS message"
// rule (design §7.6, P-22) — a literal, NOT the module's own exported
// LOCK_WAIT_MAX_DELAY_SECONDS constant. Asserting against the module's own
// constant would make this test tautological: a mutation that loosens the
// constant (e.g. to 1000) would silently also loosen what the test checks,
// and the falsifier run below would stay green instead of turning red.
const SQS_MAX_DELAY_SECONDS_PER_MESSAGE = 900;

describe("nextLockRetry — §7.6 exact schedule, no contention", () => {
  // design §7.6's table, transcribed literally:
  //  attempt 1 (T2, immediate) -> delay 30s  -> accumulated wait 30s
  //  attempt 2                 -> delay 60s  -> accumulated wait 90s
  //  attempt 3                 -> delay 120s -> accumulated wait 210s
  //  attempt 4                 -> delay 240s -> accumulated wait 450s
  //  attempt 5                 -> delay 480s -> accumulated wait 930s
  //  attempt 6                 -> delay 870s (clipped) -> accumulated wait 1800s
  //  attempt 7                 -> if it fails: wait >= 1800s -> LOCK_TIMEOUT
  const lockWaitStartedAt = 0;

  it("is RETRY 30s after attempt 1 fails immediately (lockWaitAttempts=0, now=0)", () => {
    const decision = nextLockRetry({ lockWaitStartedAt, lockWaitAttempts: 0, now: 0 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 30 });
  });

  it("is RETRY 60s after attempt 2 fails (lockWaitAttempts=1, now=30s)", () => {
    const decision = nextLockRetry({ lockWaitStartedAt, lockWaitAttempts: 1, now: 30_000 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 60 });
  });

  it("is RETRY 120s after attempt 3 fails (lockWaitAttempts=2, now=90s)", () => {
    const decision = nextLockRetry({ lockWaitStartedAt, lockWaitAttempts: 2, now: 90_000 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 120 });
  });

  it("is RETRY 240s after attempt 4 fails (lockWaitAttempts=3, now=210s)", () => {
    const decision = nextLockRetry({ lockWaitStartedAt, lockWaitAttempts: 3, now: 210_000 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 240 });
  });

  it("is RETRY 480s after attempt 5 fails (lockWaitAttempts=4, now=450s)", () => {
    const decision = nextLockRetry({ lockWaitStartedAt, lockWaitAttempts: 4, now: 450_000 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 480 });
  });

  it("is RETRY 870s (clipped) after attempt 6 fails (lockWaitAttempts=5, now=930s)", () => {
    // Base calendar's 6th entry is 900s, but only 1800-930=870s of budget
    // remain — the published delay must never exceed the remaining budget.
    const decision = nextLockRetry({ lockWaitStartedAt, lockWaitAttempts: 5, now: 930_000 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 870 });
  });

  it("is LOCK_TIMEOUT when attempt 7 fails at >= 1800s accumulated wait (lockWaitAttempts=6, now=1800s)", () => {
    const decision = nextLockRetry({ lockWaitStartedAt, lockWaitAttempts: 6, now: 1_800_000 });
    expect(decision).toEqual({ action: "LOCK_TIMEOUT" });
  });

  it("never schedules a delay greater than 900s across the whole no-contention schedule", () => {
    const schedulePoints = [
      { lockWaitAttempts: 0, now: 0 },
      { lockWaitAttempts: 1, now: 30_000 },
      { lockWaitAttempts: 2, now: 90_000 },
      { lockWaitAttempts: 3, now: 210_000 },
      { lockWaitAttempts: 4, now: 450_000 },
      { lockWaitAttempts: 5, now: 930_000 },
    ];
    for (const point of schedulePoints) {
      const decision = nextLockRetry({ lockWaitStartedAt, ...point });
      expect(decision.action).toBe("RETRY");
      if (decision.action === "RETRY") {
        expect(decision.delaySeconds).toBeLessThanOrEqual(SQS_MAX_DELAY_SECONDS_PER_MESSAGE);
      }
    }
  });
});

describe("nextLockRetry — never exceeds the 900s per-message SQS limit, even past the 6-entry calendar", () => {
  it("caps the delay at 900s for an attempt beyond the base calendar (lockWaitAttempts=6), with ample remaining budget", () => {
    // Past the base calendar's 6 entries (reachable only via repeated T9
    // re-entries, before the 10-attempt safety cap), there is no further
    // named schedule value — but §7.6 is unconditional that no message ever
    // carries more than 900s of delay (P-22), regardless of how much budget
    // remains.
    const decision = nextLockRetry({ lockWaitStartedAt: 0, lockWaitAttempts: 6, now: 0 });
    expect(decision.action).toBe("RETRY");
    if (decision.action === "RETRY") {
      expect(decision.delaySeconds).toBeLessThanOrEqual(SQS_MAX_DELAY_SECONDS_PER_MESSAGE);
    }
  });
});

describe("nextLockRetry — budget exhaustion (R3-4 canonical LOCK_TIMEOUT)", () => {
  it("returns LOCK_TIMEOUT once accumulated wait reaches the budget, regardless of attempt count", () => {
    const decision = nextLockRetry({
      lockWaitStartedAt: 0,
      lockWaitAttempts: 2,
      now: 1_800_000,
    });
    expect(decision).toEqual({ action: "LOCK_TIMEOUT" });
  });

  it("returns LOCK_TIMEOUT past the budget (reconciler finding it late)", () => {
    const decision = nextLockRetry({
      lockWaitStartedAt: 0,
      lockWaitAttempts: 1,
      now: 2_000_000,
    });
    expect(decision).toEqual({ action: "LOCK_TIMEOUT" });
  });
});

describe("nextLockRetry — safety cap of 10 total acquisition attempts (§7.6)", () => {
  // Literal 9/8 (design §7.6: "safety cap: 10 attempts in total"),
  // NOT derived from the module's own LOCK_WAIT_SAFETY_CAP_ATTEMPTS export —
  // deriving the input from that constant would make this tautological: a
  // mutation widening the cap to e.g. 11 would silently widen what the test
  // checks too, and would NOT turn it red.
  it("returns LOCK_TIMEOUT once 10 acquisition attempts have occurred (lockWaitAttempts=9), even with almost no elapsed time", () => {
    // lockWaitAttempts=9 means 9 retries already published, i.e. 10 total
    // acquisition attempts (the one that just failed included) — reached
    // only through repeated short T9 re-entries, per design §7.6. Elapsed
    // time here is trivially small (5s) so this must be the CAP firing, not
    // the 1800s budget check.
    const decision = nextLockRetry({
      lockWaitStartedAt: 0,
      lockWaitAttempts: 9,
      now: 5_000,
    });
    expect(decision).toEqual({ action: "LOCK_TIMEOUT" });
  });

  it("still allows a retry at the attempt just below the cap (lockWaitAttempts=8)", () => {
    const decision = nextLockRetry({
      lockWaitStartedAt: 0,
      lockWaitAttempts: 8,
      now: 5_000,
    });
    expect(decision.action).toBe("RETRY");
  });
});

describe("nextLockRetry — delaySeconds is always a whole number of seconds (SQS DelaySeconds is an integer)", () => {
  it("rounds a fractional remaining-budget delay UP to the next whole second, with a non-whole-second `now`", () => {
    // Same point as the "clipped to 870s" schedule test above, but `now` is
    // offset by half a second (930_500 ms, not a multiple of 1000) so the
    // elapsed time — and therefore the remaining-budget clip — is
    // fractional: remaining = 1800 - 930.5 = 869.5s. SQS DelaySeconds cannot
    // carry a fraction, so the published delay must round UP to 870, never
    // truncate down to 869 (which would under-wait against the schedule).
    const decision = nextLockRetry({ lockWaitStartedAt: 0, lockWaitAttempts: 5, now: 930_500 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 870 });
  });

  it("never rounds a delay up past the 900s per-message SQS cap", () => {
    // Base calendar's 6th entry is exactly 900s with no fractional
    // remaining-budget clip in play; ceil(900) must stay 900, not spill over.
    const decision = nextLockRetry({ lockWaitStartedAt: 0, lockWaitAttempts: 5, now: 900_000 });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 900 });
  });
});

describe("LOCK_RENEWAL_INTERVAL_SECONDS — DD-09 lease renewal cadence", () => {
  it("is 60s (DD-09: \"Renew every 60 s for the duration of the SSH session\")", () => {
    expect(LOCK_RENEWAL_INTERVAL_SECONDS).toBe(60);
  });
});

describe("nextLockRetry — T9 (code 50) re-entry resumes the same calendar and budget", () => {
  it("after 3 retries then a quick T9 round-trip, resumes at the 4th schedule value (240s), not a restart", () => {
    // 3 retries already consumed 30+60+120=210s of NOMINAL schedule time.
    // The T9 round trip (acquire -> dispatch -> run -> exit 50 -> back to
    // WAITING_LOCK) itself took a further 7s of REAL wall-clock time before
    // this decision is made again, for a true elapsed of 217s — but
    // lockWaitStartedAt and lockWaitAttempts are UNCHANGED across T9 (design
    // "T9 detail": identity preserved), so the calendar resumes
        // exactly where it left off (index 3 => 240s), consuming the SAME budget.
    const decision = nextLockRetry({
      lockWaitStartedAt: 0,
      lockWaitAttempts: 3,
      now: 217_000,
    });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 240 });
  });
});

describe("nextLockRetry — delay is clipped to the remaining budget (independent of the §7.6 table)", () => {
  it("clips a nominal 30s delay down to whatever budget remains under a custom (small) budget", () => {
    const decision = nextLockRetry({
      lockWaitStartedAt: 0,
      lockWaitAttempts: 0,
      now: 90_000, // 90s elapsed
      budgetSeconds: 100, // only 10s left
    });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 10 });
  });
});

describe("nextLockRetry — accumulated wait is real elapsed time (now - lockWaitStartedAt), never the sum of delays", () => {
  it("uses the real clock reading, so injected extra latency changes the clipped delay", () => {
    // Nominal (sum-of-delays) elapsed after 5 retries would be
    // 30+60+120+240+480 = 930s, which the §7.6 table itself uses to compute
    // the 6th delay as min(900, 1800-930) = 870s. Here we inject 20s of
    // EXTRA real-world latency (processing + queue delay) so the true
    // elapsed, read from `now - lockWaitStartedAt`, is 950s, not 930s.
    //
    // A correct implementation reads elapsed from the real clock and must
    // compute remaining = 1800 - 950 = 850, so delaySeconds = 850.
    // An implementation that (wrongly) re-derives elapsed by summing the
    // nominal schedule entries instead of using `now` would still see 930s
    // elapsed and answer 870 — a different, wrong number — which is exactly
    // the disqualifying bug this test exists to catch.
    const decision = nextLockRetry({
      lockWaitStartedAt: 0,
      lockWaitAttempts: 5,
      now: 950_000,
    });
    expect(decision).toEqual({ action: "RETRY", delaySeconds: 850 });
  });
});

describe("evaluateSupersede — FR-11 scenario: supersede", () => {
  it("supersedes when the target already has a strictly newer deployed sequence", () => {
    // FR-11 literal scenario values: target already deployed sequence 186,
    // this execution carries sequence 184.
    expect(evaluateSupersede(186, 184)).toBe(true);
  });

  it("does not supersede when this execution's sequence is the newer one", () => {
    expect(evaluateSupersede(184, 186)).toBe(false);
  });

  it("does not supersede on equal sequences", () => {
    expect(evaluateSupersede(184, 184)).toBe(false);
  });
});

describe("evaluateLockAcquisition — DD-09 acquire / reentrant / busy, fencing on owner change only", () => {
  const me = "exec-184";
  const foreignOwner = "exec-100";

  it("acquires when the lock does not exist (fencingToken starts at 1)", () => {
    const decision = evaluateLockAcquisition(undefined, me, 1_000, 90);
    expect(decision).toEqual({
      outcome: "ACQUIRED",
      reason: "ABSENT",
      fencingToken: 1,
      leaseExpiresAt: 91_000,
    });
  });

  it("acquires when the lease has expired under a different owner, incrementing fencingToken (owner change)", () => {
    const expiredLock: PersistedLockItem = { owner: foreignOwner, fencingToken: 5, leaseExpiresAt: 500 };
    const decision = evaluateLockAcquisition(expiredLock, me, 1_000, 90);
    expect(decision).toEqual({
      outcome: "ACQUIRED",
      reason: "LEASE_EXPIRED",
      fencingToken: 6,
      leaseExpiresAt: 91_000,
    });
  });

  it("acquires re-entrantly when the owner is already this execution and the lease is still valid (duplicate message), fencingToken unchanged", () => {
    const ownLock: PersistedLockItem = { owner: me, fencingToken: 5, leaseExpiresAt: 5_000 };
    const decision = evaluateLockAcquisition(ownLock, me, 1_000, 90);
    expect(decision).toEqual({
      outcome: "ACQUIRED",
      reason: "REENTRANT",
      fencingToken: 5,
      leaseExpiresAt: 91_000,
    });
  });

  it("is BUSY when a different owner holds a still-valid lease", () => {
    const foreignLock: PersistedLockItem = { owner: foreignOwner, fencingToken: 5, leaseExpiresAt: 5_000 };
    const decision = evaluateLockAcquisition(foreignLock, me, 1_000, 90);
    expect(decision).toEqual({ outcome: "BUSY", owner: foreignOwner, leaseExpiresAt: 5_000 });
  });
});

describe("canRenewLock / canReleaseLock — FR-11 scenario: ownership", () => {
  const me = "exec-184";
  const foreignOwner = "exec-100";

  it("a foreign owner cannot renew the lock", () => {
    const lock: PersistedLockItem = { owner: foreignOwner, fencingToken: 1, leaseExpiresAt: 5_000 };
    expect(canRenewLock(lock, me)).toBe(false);
  });

  it("a foreign owner cannot release the lock", () => {
    const lock: PersistedLockItem = { owner: foreignOwner, fencingToken: 1, leaseExpiresAt: 5_000 };
    expect(canReleaseLock(lock, me)).toBe(false);
  });

  it("the owner can renew and release its own lock", () => {
    const lock: PersistedLockItem = { owner: me, fencingToken: 1, leaseExpiresAt: 5_000 };
    expect(canRenewLock(lock, me)).toBe(true);
    expect(canReleaseLock(lock, me)).toBe(true);
  });

  it("there is nothing to renew or release when the lock does not exist", () => {
    expect(canRenewLock(undefined, me)).toBe(false);
    expect(canReleaseLock(undefined, me)).toBe(false);
  });
});
