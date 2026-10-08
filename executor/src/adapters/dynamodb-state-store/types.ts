// @akili-spec changes/cicd-executor-poc design §5.1
// Persisted item shapes for the single table, one interface per row of
// design §5.1's item table. These are storage records (plain data, epoch-ms
// timestamps, no behavior) — never confused with the pure domain snapshots
// in `domain/state-machine` or `domain/lock-policy`, which a repository
// translates to/from.
import type { ExecutionStatus } from "../../domain/state-machine/index.js";
import type { DomainErrorCode, RejectReason } from "../../domain/errors/index.js";

/**
 * Non-secret copy of the target record taken at acceptance (X1, design §5.1, §6.3;
 * AC-02 V1). Lock retries, reconciliation and dispatch use it for the whole
 * execution, so a later edit or deletion of the record never changes an
 * in-flight execution. `credentialRef` is a reference; the credential is read
 * only at connect time.
 */
export interface TargetSnapshot {
  /** Version of the target record that was copied. */
  readonly version: number;
  readonly project: string;
  readonly environment: string;
  readonly host: string;
  /** SSH port; absent means 22. */
  readonly port?: number;
  readonly user: string;
  readonly hostKey: readonly string[];
  readonly credentialRef: string;
  readonly deployScript: string;
  readonly deployWindowPolicy: "required" | "not-required";
  readonly sourceRepositoryId: string;
}

/** Execution item (`EXEC#{executionId}` / `META`), design §5.1. */
export interface ExecutionItem {
  readonly executionId: string;
  /** V1 deploy identity and lock key (design §1.2). */
  readonly targetId: string;
  readonly targetSnapshot: TargetSnapshot;
  readonly requestId: string;
  readonly commitSha: string;
  /** Immutable artifact identity: unit name to image digest (DD-26). */
  readonly artifacts: Readonly<Record<string, string>>;
  /** Supersede ordering key (DD-27). */
  readonly order: { readonly sourceRef: string; readonly runNumber: number; readonly runAttempt: number };
  readonly ci: {
    readonly repository: string;
    readonly runId: string;
    readonly workflowRef: string;
    readonly runUrl?: string;
  };
  readonly senderRef: string;
  readonly sequence: number;
  readonly status: ExecutionStatus;
  /** Optimistic-concurrency counter (DD-03); every write increments it. */
  readonly version: number;
  /** Current attempt's token, written by X9 (DD-28 phase 1). */
  readonly dispatchToken?: string;
  /** 0 until the first X9. */
  readonly attempt: number;
  /** DD-28 phase 2, per attempt; cleared at X9 and X14. */
  readonly execStartedAt?: number;
  readonly fencingToken?: number;
  readonly lockWaitStartedAt?: number;
  readonly lockWaitAttempts?: number;
  readonly nextAttemptAt?: number;
  readonly contentionCount: number;
  readonly lockLostDuringRun?: boolean;
  readonly targetWriteRejected?: boolean;
  readonly windowClosedDuringRun?: boolean;
  /** The script exited with a code that guarantees `CICD_RESULT` (0/10/20/30/40) but none was parsed (design §6.5, §7.2). */
  readonly cicdResultMissing?: boolean;
  readonly result?: { readonly code: number; readonly cicdResult?: string; readonly logTail?: string };
  readonly error?: { readonly code: DomainErrorCode; readonly message?: string };
  readonly slackThreadTs?: string;
  readonly deadlineAt?: number;
  /** Present (= "EXECUTION") only while `status` is non-terminal: GSI2's sparse key. */
  readonly activeStatus?: "EXECUTION";
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** Epoch seconds (DynamoDB TTL); 180 days after creation. */
  readonly expiresAt: number;
}

/** Rejection record (`REJECT#...` / `META`), design §5.1: an X2 rejection leaves no Execution item. */
export interface RejectionItem {
  readonly reason: RejectReason;
  readonly senderRef: string;
  /** Best-effort identifiers read from the (possibly invalid) body, audit only (V1: the record key is always the SQS message id). */
  readonly targetId?: string;
  readonly requestId?: string;
  readonly receivedAt: number;
  /** Epoch seconds (DynamoDB TTL); 30 days after `receivedAt`. */
  readonly expiresAt: number;
}

export type DedupeState = "CLAIMED" | "BOUND";

/** Dedupe item (`DEDUPE#{targetId}#{requestId}` / `DEDUPE`), design DD-20, §1.2. */
export interface DedupeItem {
  readonly targetId: string;
  readonly requestId: string;
  readonly state: DedupeState;
  readonly claimToken: string;
  readonly claimLeaseExpiresAt: number;
  readonly sequence?: number;
  readonly executionId?: string;
  readonly expiresAt: number;
}

export type DeployWindowState = "OPEN" | "CLOSED";

/** Deploy window item (`WINDOW#{lockKey}` / `WINDOW`), design §7.7/DD-21. */
export interface DeployWindowItem {
  readonly lockKey: string;
  readonly state: DeployWindowState;
  readonly openedBy?: string;
  readonly openedAt?: number;
  readonly closesAt?: number;
  readonly externalJobsDisabled?: readonly string[];
  readonly note?: string;
  readonly closedBy?: string;
  readonly closedReason?: "MANUAL" | "EXPIRED";
  readonly closedAt?: number;
  readonly version: number;
  /** Present (= "WINDOW") only while `state === "OPEN"` — GSI2's sparse key. */
  readonly activeStatus?: "WINDOW";
  /** Mirrors `closesAt` while OPEN (design §5.1); absent once CLOSED. */
  readonly deadlineAt?: number;
}

/** Sequence item (`DEPLOYMENT#{targetId}` / `SEQ`), design §5.1 with the V1 mapping of §1.2. */
export interface SequenceItem {
  readonly targetId: string;
  readonly value: number;
}

/** `highestDispatched` value (design §5.1): ordering key plus the execution that reached X9. */
export interface DispatchedStamp {
  readonly sourceRef: string;
  readonly runNumber: number;
  readonly executionId: string;
}

/** `highestAccepted` value (design §5.1). */
export type AcceptedStamp = DispatchedStamp;

/** `lastDeployed` value (design §5.1), written at X12 success under the lock. */
export interface DeployedStamp extends DispatchedStamp {
  readonly commitSha: string;
}

/** `unresolved[]` entry (design §5.1/§12.2). */
export interface UnresolvedEntry {
  readonly executionId: string;
  readonly since: number;
}

/**
 * Target state item (`TARGET#{lockKey}` / `STATE`), design §5.1/DD-09/DD-27.
 * Every attribute except `lockKey` is absent until first written: the ordering
 * attributes are created by independent conditional updates.
 */
export interface TargetStateItem {
  readonly lockKey: string;
  readonly currentImages?: Record<string, string>;
  /** Opaque strings: a value may be the script's `unresolved:sha256:<id>` marker, never a digest. */
  readonly previousImages?: Record<string, string>;
  readonly lastDeployed?: DeployedStamp;
  readonly highestDispatched?: DispatchedStamp;
  readonly highestAccepted?: AcceptedStamp;
  readonly unresolved?: readonly UnresolvedEntry[];
  readonly updatedAt?: number;
  /** Fencing token of the lock-owner write that produced `lastDeployed` and the images (DD-09). */
  readonly fencingToken?: number;
  readonly version?: number;
}

/** Lock item (`LOCK#{lockKey}` / `LOCK`), design DD-09. */
export interface LockItem {
  readonly lockKey: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
  readonly acquiredAt: number;
  /** TTL cleanup only (forward pointer T-08.a): never the mechanism that frees the lock. */
  readonly expiresAt: number;
}

/** Event mark item (`EXEC#{executionId}` / `EVT#{eventKey}`) — presence-only, design §5.1. */
export interface EventMarkItem {
  readonly executionId: string;
  readonly eventKey: string;
  readonly expiresAt: number;
}
