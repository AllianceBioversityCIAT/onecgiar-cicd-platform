// @akili-spec changes/cicd-executor-poc design §5.1, DD-09; requirements FR-11
// Repository for the distributed deploy Lock item. Pure acquisition/fencing
// DECISIONS come from `domain/lock-policy` (reused, never duplicated here) —
// this file only turns an accepted decision into the matching conditional
// write, re-asserting the SAME predicate the decision was computed from
// against the row's live state at write time (DD-03: the read that produced
// the decision and the write that applies it are two different round-trips,
// so only the write's own condition — not the earlier read — can be trusted
// to catch a concurrent winner).
//
// Forward pointer T-08.a (recorded by the Leader's brief): a released or
// expired lock is NEVER deleted — only `leaseExpiresAt` moves into the past.
// `expiresAt` (the DynamoDB TTL attribute) is kept far in the future on every
// write and is cleanup-only. A TTL-deleted-then-recreated lock would restart
// `fencingToken` at 1, silently breaking every TargetStateRepository write
// that depends on fencing being monotonic across the lock's whole lifetime.
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { evaluateLockAcquisition, type PersistedLockItem } from "../../domain/lock-policy/index.js";
import { PINNED_LEASE_EXPIRES_AT } from "../../domain/agent-protocol/index.js";
import { lockKeyOf, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";
import type { LockItem } from "./types.js";

/** Cleanup-only TTL horizon (forward pointer T-08.a) — re-extended on every write. */
export const LOCK_ITEM_TTL_SECONDS = 24 * 60 * 60;

export type LockAcquireOutcome =
  | {
      readonly outcome: "ACQUIRED";
      readonly fencingToken: number;
      readonly leaseExpiresAt: number;
      /**
       * `true` when this owner ALREADY held a live lease (a duplicate or concurrent
       * attempt of the same execution re-entered it, DD-09 re-entrancy). Such a caller
       * did not take the lock fresh and must not release it unless it goes on to own the
       * attempt (deploy-coordinator, design §7.5).
       */
      readonly alreadyHeld: boolean;
    }
  | { readonly outcome: "BUSY"; readonly owner: string; readonly leaseExpiresAt: number }
  /** The read-time decision was ACQUIRABLE but a concurrent writer won the race first. */
  | { readonly outcome: "LOST_RACE" };

/**
 * architecture-change-04 §10.4: owner of a lock released with proof or after a hold. No execution has this id, so the
 * next acquisition, even by the same execution (a retry after X14), is LEASE_EXPIRED and gets a STRICTLY higher fencing
 * token: every sqs-agent dispatch carries a fresh token, and an agent never sees two commands with the same token.
 */
export const RELEASED_OWNER = "(released)";

/** Appended to every lease operation: a PINNED or HELD lock (architecture-change-04 §9.1) is out of the lease protocol. */
const UNPINNED_UNHELD = " AND #leaseExpiresAt <> :pinned AND (attribute_not_exists(#hold) OR #hold <> :true)";

/** An Update usable inside `TransactWriteItems` (architecture-change-04: pin at X9, release or hold when closing). */
export interface LockUpdateSpec {
  readonly TableName: string;
  readonly Key: Record<string, string>;
  readonly UpdateExpression: string;
  readonly ConditionExpression: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues: Record<string, unknown>;
}

export class LockRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async get(lockKey: string): Promise<LockItem | undefined> {
    const key = lockKeyOf(lockKey);
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk } }),
    );
    return result.Item as LockItem | undefined;
  }

  /** DD-09's acquire decision (absent / lease-expired / re-entrant), applied as a conditional write. */
  public async acquire(lockKey: string, me: string, now: number, leaseSeconds: number): Promise<LockAcquireOutcome> {
    const current = await this.get(lockKey);
    const persisted: PersistedLockItem | undefined = current
      ? { owner: current.owner, fencingToken: current.fencingToken, leaseExpiresAt: current.leaseExpiresAt }
      : undefined;
    // architecture-change-04 §9.1: a PINNED or HELD lock is never (re)acquired, not even by its owner: only the
    // fenced closing transaction, evidence or an operator resolution frees it.
    if (current !== undefined && (current.leaseExpiresAt === PINNED_LEASE_EXPIRES_AT || current.hold === true)) {
      return { outcome: "BUSY", owner: current.owner, leaseExpiresAt: current.leaseExpiresAt };
    }
    const decision = evaluateLockAcquisition(persisted, me, now, leaseSeconds);

    if (decision.outcome === "BUSY") {
      return { outcome: "BUSY", owner: decision.owner, leaseExpiresAt: decision.leaseExpiresAt };
    }

    const key = lockKeyOf(lockKey);
    const ttl = Math.floor(now / 1000) + LOCK_ITEM_TTL_SECONDS;

    let applied: boolean;
    if (decision.reason === "ABSENT") {
      applied = await runConditionalWrite(() =>
        this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: {
              [TABLE_PK_ATTR]: key.pk,
              [TABLE_SK_ATTR]: key.sk,
              lockKey,
              owner: me,
              fencingToken: decision.fencingToken,
              leaseExpiresAt: decision.leaseExpiresAt,
              acquiredAt: now,
              expiresAt: ttl,
            },
            ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
          }),
        ),
      );
    } else {
      // REENTRANT or LEASE_EXPIRED: re-assert the exact predicate the
      // decision was computed from, PLUS the fencingToken we read it from —
      // the extra guard DD-09's text does not spell out explicitly, but
      // which is necessary: without it, two racing LEASE_EXPIRED winners
      // could each pass a now-stale `leaseExpiresAt < :now` check against an
      // item the other already rewrote a moment earlier (see this file's
      // top comment).
      const conditionExpression =
        (decision.reason === "REENTRANT"
          ? "#owner = :me AND #fencingToken = :expectedFencingToken"
          : "#leaseExpiresAt < :now AND #fencingToken = :expectedFencingToken") + UNPINNED_UNHELD;
      applied = await runConditionalWrite(() =>
        this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
            UpdateExpression:
              "SET #owner = :me, #fencingToken = :newFencingToken, #leaseExpiresAt = :newLeaseExpiresAt, #acquiredAt = :now, #expiresAt = :ttl",
            ConditionExpression: conditionExpression,
            ExpressionAttributeNames: {
              "#owner": "owner",
              "#fencingToken": "fencingToken",
              "#leaseExpiresAt": "leaseExpiresAt",
              "#acquiredAt": "acquiredAt",
              "#expiresAt": "expiresAt",
              "#hold": "hold",
            },
            ExpressionAttributeValues: {
              ":me": me,
              ":now": now,
              ":newFencingToken": decision.fencingToken,
              ":newLeaseExpiresAt": decision.leaseExpiresAt,
              ":ttl": ttl,
              ":expectedFencingToken": persisted?.fencingToken,
              ":pinned": PINNED_LEASE_EXPIRES_AT,
              ":true": true,
            },
          }),
        ),
      );
    }

    if (!applied) {
      return { outcome: "LOST_RACE" };
    }
    const alreadyHeld = decision.reason === "REENTRANT" && current !== undefined && current.leaseExpiresAt >= now;
    return {
      outcome: "ACQUIRED",
      fencingToken: decision.fencingToken,
      leaseExpiresAt: decision.leaseExpiresAt,
      alreadyHeld,
    };
  }

  /**
   * architecture-change-04 §8 step 2 (X9 of an sqs-agent dispatch): the short lease becomes PINNED, with no expiry and no
   * TTL (a TTL deletion would reset the fencing counter). Only the owner with its fencing token, while its short lease is
   * still live, can pin; a lost or expired lease cancels the X9 transaction.
   */
  public pinSpec(lockKey: string, owner: string, fencingToken: number, now: number): LockUpdateSpec {
    const key = lockKeyOf(lockKey);
    return {
      TableName: this.tableName,
      Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
      UpdateExpression: "SET #leaseExpiresAt = :pinned, #mode = :pinnedMode REMOVE #expiresAt",
      ConditionExpression: "#owner = :owner AND #fencingToken = :fencingToken AND #leaseExpiresAt >= :now",
      ExpressionAttributeNames: { "#owner": "owner", "#fencingToken": "fencingToken", "#leaseExpiresAt": "leaseExpiresAt", "#mode": "mode", "#expiresAt": "expiresAt" },
      ExpressionAttributeValues: { ":owner": owner, ":fencingToken": fencingToken, ":now": now, ":pinned": PINNED_LEASE_EXPIRES_AT, ":pinnedMode": "PINNED" },
    };
  }

  /**
   * architecture-change-04 §9.1: release with proof that no process exists, in the SAME transaction as the closing
   * transition. Fenced on owner AND token: a late event of another execution, or of an older dispatch of a reacquired
   * lock, can never release it. A held lock is released only by `releaseHoldSpec`. The item is kept (fencing stays
   * monotonic) and the cleanup TTL is restored.
   */
  public releaseSpec(lockKey: string, owner: string, fencingToken: number, now: number): LockUpdateSpec {
    const key = lockKeyOf(lockKey);
    return {
      TableName: this.tableName,
      Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
      UpdateExpression: "SET #leaseExpiresAt = :expired, #mode = :leaseMode, #expiresAt = :ttl, #owner = :released",
      ConditionExpression: "#owner = :owner AND #fencingToken = :fencingToken AND (attribute_not_exists(#hold) OR #hold <> :true)",
      ExpressionAttributeNames: { "#owner": "owner", "#fencingToken": "fencingToken", "#leaseExpiresAt": "leaseExpiresAt", "#mode": "mode", "#expiresAt": "expiresAt", "#hold": "hold" },
      ExpressionAttributeValues: { ":owner": owner, ":fencingToken": fencingToken, ":expired": now - 1, ":leaseMode": "LEASE", ":ttl": Math.floor(now / 1000) + LOCK_ITEM_TTL_SECONDS, ":true": true, ":released": RELEASED_OWNER },
    };
  }

  /**
   * architecture-change-04 §9.1 (AP-3): X16 keeps the lock: pinned, no TTL, hold = true. Fenced on owner and token (an
   * SSH run may have lost its lease meanwhile: then there is nothing of this execution to hold).
   */
  public holdSpec(lockKey: string, owner: string, fencingToken: number, now: number, reason: string): LockUpdateSpec {
    const key = lockKeyOf(lockKey);
    return {
      TableName: this.tableName,
      Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
      UpdateExpression: "SET #leaseExpiresAt = :pinned, #mode = :pinnedMode, #hold = :true, #holdReason = :reason, #holdSince = :now REMOVE #expiresAt",
      ConditionExpression: "#owner = :owner AND #fencingToken = :fencingToken",
      ExpressionAttributeNames: {
        "#owner": "owner",
        "#fencingToken": "fencingToken",
        "#leaseExpiresAt": "leaseExpiresAt",
        "#mode": "mode",
        "#hold": "hold",
        "#holdReason": "holdReason",
        "#holdSince": "holdSince",
        "#expiresAt": "expiresAt",
      },
      ExpressionAttributeValues: { ":owner": owner, ":fencingToken": fencingToken, ":pinned": PINNED_LEASE_EXPIRES_AT, ":pinnedMode": "PINNED", ":true": true, ":reason": reason, ":now": now },
    };
  }

  /** Releases a HELD lock (verified evidence or an operator resolution): owner, token AND hold must match. */
  public releaseHoldSpec(lockKey: string, owner: string, fencingToken: number, now: number): LockUpdateSpec {
    const key = lockKeyOf(lockKey);
    return {
      TableName: this.tableName,
      Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
      UpdateExpression: "SET #leaseExpiresAt = :expired, #mode = :leaseMode, #expiresAt = :ttl, #owner = :released REMOVE #hold, #holdReason, #holdSince",
      ConditionExpression: "#owner = :owner AND #fencingToken = :fencingToken AND #hold = :true",
      ExpressionAttributeNames: {
        "#owner": "owner",
        "#fencingToken": "fencingToken",
        "#leaseExpiresAt": "leaseExpiresAt",
        "#mode": "mode",
        "#hold": "hold",
        "#holdReason": "holdReason",
        "#holdSince": "holdSince",
        "#expiresAt": "expiresAt",
      },
      ExpressionAttributeValues: { ":owner": owner, ":fencingToken": fencingToken, ":expired": now - 1, ":leaseMode": "LEASE", ":ttl": Math.floor(now / 1000) + LOCK_ITEM_TTL_SECONDS, ":true": true, ":released": RELEASED_OWNER },
    };
  }

  /** Standalone form of `releaseHoldSpec`; false when the lock is not this execution's held lock. */
  public async releaseHold(lockKey: string, owner: string, fencingToken: number, now: number): Promise<boolean> {
    const spec = this.releaseHoldSpec(lockKey, owner, fencingToken, now);
    return runConditionalWrite(() => this.client.send(new UpdateCommand(spec)));
  }

  /** FR-11 "renewal": conditional on `owner` — a non-owner's renewal is a no-op (FR-11 "ownership"). */
  public async renew(lockKey: string, owner: string, now: number, leaseSeconds: number): Promise<boolean> {
    const key = lockKeyOf(lockKey);
    const newLeaseExpiresAt = now + leaseSeconds * 1000;
    const ttl = Math.floor(now / 1000) + LOCK_ITEM_TTL_SECONDS;
    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression: "SET #leaseExpiresAt = :newLeaseExpiresAt, #expiresAt = :ttl",
          ConditionExpression: "#owner = :owner" + UNPINNED_UNHELD,
          ExpressionAttributeNames: { "#owner": "owner", "#leaseExpiresAt": "leaseExpiresAt", "#expiresAt": "expiresAt", "#hold": "hold" },
          ExpressionAttributeValues: { ":owner": owner, ":newLeaseExpiresAt": newLeaseExpiresAt, ":ttl": ttl, ":pinned": PINNED_LEASE_EXPIRES_AT, ":true": true },
        }),
      ),
    );
  }

  /**
   * FR-11 "renewal and release": conditional on `owner` — a non-owner's
   * release is a no-op. NEVER deletes the item (forward pointer T-08.a): it
   * only moves `leaseExpiresAt` into the past, so the next `acquire` sees it
   * as immediately `LEASE_EXPIRED` while `fencingToken` is preserved.
   */
  public async release(lockKey: string, owner: string, now: number): Promise<boolean> {
    const key = lockKeyOf(lockKey);
    const ttl = Math.floor(now / 1000) + LOCK_ITEM_TTL_SECONDS;
    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression: "SET #leaseExpiresAt = :expiredLeaseExpiresAt, #expiresAt = :ttl",
          ConditionExpression: "#owner = :owner" + UNPINNED_UNHELD,
          ExpressionAttributeNames: { "#owner": "owner", "#leaseExpiresAt": "leaseExpiresAt", "#expiresAt": "expiresAt", "#hold": "hold" },
          ExpressionAttributeValues: { ":owner": owner, ":expiredLeaseExpiresAt": now - 1, ":ttl": ttl, ":pinned": PINNED_LEASE_EXPIRES_AT, ":true": true },
        }),
      ),
    );
  }
}
