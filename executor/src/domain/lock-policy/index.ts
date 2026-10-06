// @akili-spec changes/cicd-executor-poc design DD-09, §7.6; requirements FR-11, FR-16 F17-F18
// Lease, fencing and lock-wait-schedule decision logic for the
// distributed lock (DD-09). Pure, no I/O: no Date.now(), no randomness — the
// caller supplies `now` and every persisted field. Persistence / conditional
// DynamoDB writes are T-08; this module only decides what SHOULD happen and
// the ownership/fencing parameters those conditional writes would check
// (design §5.1's Lock item: `owner, fencingToken, leaseExpiresAt`).
//
// Units: `now` and `lockWaitStartedAt`/`leaseExpiresAt` are epoch
// milliseconds (matching `ports/clock.ts`'s `Clock.now(): Date` via
// `.getTime()`). `budgetSeconds`, `leaseSeconds` and every `delaySeconds`
// returned are plain seconds, matching design §7.1/§7.6's own units.

// ---------------------------------------------------------------------------
// §7.6 — Lock wait: exact schedule
// ---------------------------------------------------------------------------

/** Accumulated lock-wait budget (§7.1, §7.6): 30 min. */
export const LOCK_WAIT_BUDGET_SECONDS = 1800;

/** Maximum publishable delay per SQS message (§7.6, P-22). */
export const LOCK_WAIT_MAX_DELAY_SECONDS = 900;

/** Base re-enqueue schedule (§7.6), one value per failed acquisition attempt. */
export const LOCK_WAIT_SCHEDULE_SECONDS = [30, 60, 120, 240, 480, 900] as const;

/**
 * Safety cap (§7.6, DD-09): at most 10 acquisition attempts in total. Only
 * reached through many short re-entries via exit code 50 (T9).
 */
export const LOCK_WAIT_SAFETY_CAP_ATTEMPTS = 10;

/** Lease renewal cadence for the duration of the SSH session (DD-09: "Renew every 60 s"). */
export const LOCK_RENEWAL_INTERVAL_SECONDS = 60;

export type LockRetryDecision =
  | { readonly action: "RETRY"; readonly delaySeconds: number }
  | { readonly action: "LOCK_TIMEOUT" };

export interface NextLockRetryParams {
  /** Step.lockWaitStartedAt, set once by T2 and preserved across T9 (epoch ms). */
  readonly lockWaitStartedAt: number;
  /** Step.lockWaitAttempts: number of retries already published so far (0 before the first). */
  readonly lockWaitAttempts: number;
  /** Caller-supplied clock reading (epoch ms) — never Date.now() inside this module. */
  readonly now: number;
  /** Defaults to the 30 min budget of §7.1/§7.6. */
  readonly budgetSeconds?: number;
}

/**
 * Decides the outcome of one failed lock-acquisition attempt: either publish
 * a `LOCK_RETRY_REQUESTED` with a bounded delay, or give up with the
 * canonical `LOCK_TIMEOUT` (R3-4: the ONLY outcome of exhausting the
 * lock-wait budget, whoever detects it — the retry handler or the
 * reconciler).
 *
 * The accumulated wait is ALWAYS `now - lockWaitStartedAt`, read from
 * persisted state (DD-09, §7.6) — never the sum of previously published
 * delays, which would drift from the real wall-clock the instant any
 * processing or queue latency is added on top of the nominal schedule.
 */
export function nextLockRetry(params: NextLockRetryParams): LockRetryDecision {
  const budgetSeconds = params.budgetSeconds ?? LOCK_WAIT_BUDGET_SECONDS;

  // Safety cap first (§7.6): independent of elapsed time — reached only
  // through repeated short T9 re-entries. lockWaitAttempts retries already
  // published + the attempt that just failed = total attempts so far.
  const totalAttemptsSoFar = params.lockWaitAttempts + 1;
  if (totalAttemptsSoFar >= LOCK_WAIT_SAFETY_CAP_ATTEMPTS) {
    return { action: "LOCK_TIMEOUT" };
  }

  const elapsedSeconds = (params.now - params.lockWaitStartedAt) / 1000;
  if (elapsedSeconds >= budgetSeconds) {
    return { action: "LOCK_TIMEOUT" };
  }

  const remainingSeconds = budgetSeconds - elapsedSeconds;
  const scheduledDelaySeconds =
    LOCK_WAIT_SCHEDULE_SECONDS[params.lockWaitAttempts] ?? LOCK_WAIT_MAX_DELAY_SECONDS;
  // §7.6: delay = min(next value from the schedule, budget − accumulated
  // wait), and never more than 900 s per message regardless.
  const rawDelaySeconds = Math.min(scheduledDelaySeconds, remainingSeconds, LOCK_WAIT_MAX_DELAY_SECONDS);
  // SQS `DelaySeconds` is an integer: round up so a fractional remaining
  // budget never under-waits, but re-clip to the 900 s cap in case rounding
  // up a value that was already at the cap would otherwise push it over.
  const delaySeconds = Math.min(Math.ceil(rawDelaySeconds), LOCK_WAIT_MAX_DELAY_SECONDS);
  return { action: "RETRY", delaySeconds };
}

// ---------------------------------------------------------------------------
// DD-09 — Lock: acquire / reentrant / busy, fencing on owner change only
// ---------------------------------------------------------------------------

/** design §5.1's Lock item, the domain-relevant subset. */
export interface PersistedLockItem {
  readonly owner: string;
  readonly fencingToken: number;
  /** Epoch ms. */
  readonly leaseExpiresAt: number;
}

export type LockAcquisitionDecision =
  | {
      readonly outcome: "ACQUIRED";
      readonly reason: "ABSENT" | "LEASE_EXPIRED" | "REENTRANT";
      readonly fencingToken: number;
      readonly leaseExpiresAt: number;
    }
  | {
      readonly outcome: "BUSY";
      readonly owner: string;
      readonly leaseExpiresAt: number;
    };

/**
 * DD-09 "Decision (lock)": acquire if the lock does not exist, if its lease
 * has expired, or if its owner is already `me` (re-entrant — a duplicate
 * message must not fail). `fencingToken` increments by exactly 1 only when
 * the owner actually changes (absent -> me, or a different expired owner ->
 * me); a re-entrant acquisition by the SAME owner never moves it, whether or
 * not that owner's own lease had already expired.
 */
export function evaluateLockAcquisition(
  currentLock: PersistedLockItem | undefined,
  me: string,
  now: number,
  leaseSeconds: number,
): LockAcquisitionDecision {
  const leaseExpiresAt = now + leaseSeconds * 1000;

  if (currentLock === undefined) {
    return { outcome: "ACQUIRED", reason: "ABSENT", fencingToken: 1, leaseExpiresAt };
  }

  if (currentLock.owner === me) {
    return {
      outcome: "ACQUIRED",
      reason: "REENTRANT",
      fencingToken: currentLock.fencingToken,
      leaseExpiresAt,
    };
  }

  if (currentLock.leaseExpiresAt < now) {
    return {
      outcome: "ACQUIRED",
      reason: "LEASE_EXPIRED",
      fencingToken: currentLock.fencingToken + 1,
      leaseExpiresAt,
    };
  }

  return { outcome: "BUSY", owner: currentLock.owner, leaseExpiresAt: currentLock.leaseExpiresAt };
}

// ---------------------------------------------------------------------------
// FR-11 "Scenario: ownership" — renewal/release are conditional to the owner
// ---------------------------------------------------------------------------

function isOwnedBy(currentLock: PersistedLockItem | undefined, me: string): boolean {
  return currentLock !== undefined && currentLock.owner === me;
}

/** A renewal by a different execution than the current owner has no effect. */
export function canRenewLock(currentLock: PersistedLockItem | undefined, me: string): boolean {
  return isOwnedBy(currentLock, me);
}

/** A release by a different execution than the current owner has no effect. */
export function canReleaseLock(currentLock: PersistedLockItem | undefined, me: string): boolean {
  return isOwnedBy(currentLock, me);
}
