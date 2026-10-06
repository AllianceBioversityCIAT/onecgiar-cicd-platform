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
        decision.reason === "REENTRANT"
          ? "#owner = :me AND #fencingToken = :expectedFencingToken"
          : "#leaseExpiresAt < :now AND #fencingToken = :expectedFencingToken";
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
            },
            ExpressionAttributeValues: {
              ":me": me,
              ":now": now,
              ":newFencingToken": decision.fencingToken,
              ":newLeaseExpiresAt": decision.leaseExpiresAt,
              ":ttl": ttl,
              ":expectedFencingToken": persisted?.fencingToken,
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
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner", "#leaseExpiresAt": "leaseExpiresAt", "#expiresAt": "expiresAt" },
          ExpressionAttributeValues: { ":owner": owner, ":newLeaseExpiresAt": newLeaseExpiresAt, ":ttl": ttl },
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
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner", "#leaseExpiresAt": "leaseExpiresAt", "#expiresAt": "expiresAt" },
          ExpressionAttributeValues: { ":owner": owner, ":expiredLeaseExpiresAt": now - 1, ":ttl": ttl },
        }),
      ),
    );
  }
}
