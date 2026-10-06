// @akili-spec changes/cicd-executor-poc design §3.3, §5.1, §7 (execution-service row), §7.1, §7.3 (X1, X2, X3), DD-20, DD-25, DD-27; requirements FR-03, FR-07, FR-21, FR-23
// Identity, dedupe and execution creation (N-10). Receives a request already
// validated by the message-router (sender, schema, requestId, definition
// lookup, repository/workflow consistency) and:
//   1. checks unit-set equality with the definition (FR-03): else X2 CONSISTENCY_MISMATCH;
//   2. claims the dedupe key `{deploymentId, requestId}` (DD-20, leased claim);
//   3. ONLY AFTER owning the claim, takes the per-deployment sequence (a
//      rejection or a lost claim never consumes a number, RL-5);
//   4. creates the execution in QUEUED (X1, `attribute_not_exists`) and binds the claim;
//   5. raises `TARGET.highestAccepted` in a SEPARATE conditional write (E2: not
//      a condition of X1; a refused raise is the expected outcome for an older
//      request);
//   6. evaluates S1 and, when superseded, applies X3 (QUEUED -> SUPERSEDED).
// Redelivery table (DD-20), by the stored dedupe state:
//   - absent                      -> claim (`attribute_not_exists`); the winner proceeds;
//   - BOUND                       -> no-op (DUPLICATE); recovery is the reconciler's;
//   - CLAIMED, lease still valid  -> another processing owns it: throw
//                                    `ClaimInProgressError` (NO ack; SQS redelivers
//                                    after the visibility timeout, by when it is
//                                    BOUND or its lease expired);
//   - CLAIMED, lease expired      -> conditional takeover on the previous token; the
//                                    winner reuses an already stored sequence and an
//                                    already created execution (idempotent create),
//                                    a loser gets `ClaimInProgressError`.
// Every write after the claim is conditional on the claim token, so a
// processing that lost its lease can never double-bind.
// Out of scope: V1/X4/X5 and everything after QUEUED (deploy-coordinator,
// reconciler), sender authorization (N-06), TARGET adapter (N-09).
import { randomUUID } from "node:crypto";
import { applyTransition, newExecutionSnapshot, type CreationChecks } from "../../domain/state-machine/index.js";
import type { RejectReason } from "../../domain/errors/index.js";
import { evaluateS1, type OrderingValue } from "../../domain/supersede-policy/index.js";
import type { Clock } from "../../ports/clock.js";
import type { ValidatedDeployRequest, Rejection } from "../message-router/index.js";
import type { ExecutionItem, RejectionItem } from "../../adapters/dynamodb-state-store/types.js";
import type { RejectionRef } from "../../adapters/dynamodb-state-store/keys.js";
import type {
  DedupePort,
  DeploymentCatalog,
  ExecutionStorePort,
  RejectionStorePort,
  SequencePort,
  TargetOrderingPort,
} from "./ports.js";
import { buildSourceRef } from "./source-ref.js";

export { buildSourceRef, type BoundSource } from "./source-ref.js";
export type {
  DedupePort,
  DeploymentCatalog,
  DeploymentInfo,
  ExecutionStorePort,
  RejectionStorePort,
  SequencePort,
  TargetOrderingEntry,
  TargetOrderingPort,
} from "./ports.js";

/** Dedupe claim lease (DD-20): long enough for one creation pass, short enough for a crashed owner to be taken over on redelivery. */
export const DEDUPE_CLAIM_LEASE_MS = 120_000;
/** Retention of the dedupe record (design §5.1): 7 days. */
export const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Retention of an execution (design §5.1): 180 days. */
export const EXECUTION_TTL_SECONDS = 180 * 24 * 60 * 60;
/** `QUEUED` deadline (design §7.1): created + 5 minutes. */
export const QUEUED_DEADLINE_MS = 5 * 60 * 1000;

// Identifier shapes of the schema (deploy-request.schema.json). An identifier
// that does not match is "unusable" for a REJECT# key (design §5.1).
const USABLE_DEPLOYMENT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const USABLE_REQUEST_ID = /^[0-9]{1,20}-[0-9]{1,4}$/;

/** A validated request plus the audit sender reference (role-ID prefix only, DD-25), carried from the authorizer result. */
export interface AcceptedDeployRequest extends ValidatedDeployRequest {
  readonly senderRef: string;
}

/** A router rejection plus the audit data the record needs. */
export interface RejectionInput extends Rejection {
  readonly senderRef: string;
  /** SQS MessageId: the REJECT#MSG# key when `deploymentId`/`requestId` are missing or unusable. */
  readonly sqsMessageId?: string;
}

export type DeployRequestedOutcome =
  | { readonly outcome: "CREATED"; readonly executionId: string; readonly sequence: number; readonly status: "QUEUED" | "SUPERSEDED" }
  | { readonly outcome: "DUPLICATE"; readonly executionId?: string }
  | { readonly outcome: "REJECTED"; readonly reason: RejectReason };

/** A foreign, live (or just-taken-over) claim owns this request: do NOT acknowledge, SQS redelivers (DD-20). */
export class ClaimInProgressError extends Error {
  public constructor(deploymentId: string, requestId: string) {
    super(`dedupe claim for ${deploymentId}#${requestId} is owned by another processing; retry on redelivery`);
    this.name = "ClaimInProgressError";
  }
}

/** Ordering values of different sources met: impossible under validation (DD-27), so fail safe loudly instead of guessing. */
export class OrderingSourceMismatchError extends Error {
  public constructor(executionId: string) {
    super(`supersede ordering for ${executionId} met a value of another source; refusing to compare (DD-27)`);
    this.name = "OrderingSourceMismatchError";
  }
}

export interface ExecutionServiceDeps {
  readonly catalog: DeploymentCatalog;
  readonly dedupe: DedupePort;
  readonly sequences: SequencePort;
  readonly executions: ExecutionStorePort;
  readonly rejections: RejectionStorePort;
  readonly target: TargetOrderingPort;
  readonly clock: Clock;
  /** Claim-token generator; defaults to a random UUID. Injectable for deterministic tests. */
  readonly newClaimToken?: () => string;
}

export interface ExecutionService {
  /** Router handler for a contract-valid DEPLOY_REQUESTED. Resolves = acknowledge; rejects = do not acknowledge. */
  deployRequested(input: AcceptedDeployRequest): Promise<DeployRequestedOutcome>;
  /** Router handler for an X2 rejection: persists the rejection record (no sequence, no execution). Resolves to false when a record already existed. */
  rejected(input: RejectionInput): Promise<boolean>;
}

const ALL_PASSED: CreationChecks = {
  senderAuthorized: true,
  schemaValid: true,
  requestIdMatches: true,
  deploymentKnown: true,
  consistencyOk: true,
  dedupeClaimOwned: true,
};

function x2Reason(failed: Partial<CreationChecks>): RejectReason {
  const t = applyTransition(null, { kind: "CREATE", checks: { ...ALL_PASSED, ...failed, dedupeClaimOwned: false } });
  if (!t.accepted || t.transitionId !== "X2" || t.rejectReason === undefined) {
    throw new Error("execution-service: a failed creation check did not yield X2");
  }
  return t.rejectReason;
}

/** `true` when the request's artifact keys equal the definition's units exactly (no missing, no extra). */
function unitSetsEqual(requested: readonly string[], declared: readonly string[]): boolean {
  const a = new Set(requested);
  const b = new Set(declared);
  if (a.size !== requested.length || b.size !== declared.length) return false;
  return a.size === b.size && [...a].every((unit) => b.has(unit));
}

function rejectionRef(input: RejectionInput): RejectionRef {
  const { deploymentId, requestId, sqsMessageId } = input;
  if (
    deploymentId !== undefined &&
    requestId !== undefined &&
    USABLE_DEPLOYMENT_ID.test(deploymentId) &&
    USABLE_REQUEST_ID.test(requestId)
  ) {
    return { deploymentId, requestId };
  }
  if (sqsMessageId === undefined) {
    throw new Error("execution-service: a rejection with unusable identifiers needs the SQS message id (REJECT#MSG#)");
  }
  return { sqsMessageId };
}

type ClaimResult =
  | { readonly owned: true; readonly token: string; readonly storedSequence?: number }
  | { readonly owned: false; readonly executionId?: string };

export function createExecutionService(deps: ExecutionServiceDeps): ExecutionService {
  const newClaimToken = deps.newClaimToken ?? randomUUID;

  async function record(ref: RejectionRef, reason: RejectReason, senderRef: string, deploymentId: string | undefined): Promise<boolean> {
    const item: Omit<RejectionItem, "expiresAt"> = {
      reason,
      senderRef,
      ...(deploymentId === undefined ? {} : { deploymentId }),
      receivedAt: deps.clock.now().getTime(),
    };
    return deps.rejections.record(ref, item);
  }

  /** DD-20: returns the owned claim (with an already stored sequence when taken over), or a no-op outcome. */
  async function acquireClaim(deploymentId: string, requestId: string): Promise<ClaimResult> {
    const token = newClaimToken();
    // Two attempts: the item can only vanish between claim and get through TTL expiry (7 d), which is not worth more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nowMs = deps.clock.now().getTime();
      const leaseUntil = nowMs + DEDUPE_CLAIM_LEASE_MS;
      const expiresAt = Math.floor(nowMs / 1000) + DEDUPE_TTL_SECONDS;
      if (await deps.dedupe.claim(deploymentId, requestId, token, leaseUntil, expiresAt)) return { owned: true, token };

      const existing = await deps.dedupe.get(deploymentId, requestId);
      if (existing === undefined) continue;
      if (existing.state === "BOUND") {
        return { owned: false, ...(existing.executionId === undefined ? {} : { executionId: existing.executionId }) };
      }
      if (existing.claimLeaseExpiresAt >= nowMs) throw new ClaimInProgressError(deploymentId, requestId);
      const tookOver = await deps.dedupe.takeOverExpiredClaim(deploymentId, requestId, existing.claimToken, token, leaseUntil, nowMs);
      if (!tookOver) throw new ClaimInProgressError(deploymentId, requestId);
      return { owned: true, token, ...(existing.sequence === undefined ? {} : { storedSequence: existing.sequence }) };
    }
    throw new ClaimInProgressError(deploymentId, requestId);
  }

  /** DD-20 step 2: reuse a stored sequence, else increment (only here, after the claim) and record it conditional on the claim. */
  async function resolveSequence(deploymentId: string, requestId: string, token: string, stored: number | undefined): Promise<number> {
    if (stored !== undefined) return stored;
    const taken = await deps.sequences.increment(deploymentId);
    if (await deps.dedupe.recordSequence(deploymentId, requestId, token, taken)) return taken;
    // Not recorded: the claim is no longer ours, or a sequence was stored meanwhile (our number becomes a gap).
    const current = await deps.dedupe.get(deploymentId, requestId);
    if (current?.claimToken === token && current.sequence !== undefined) return current.sequence;
    throw new ClaimInProgressError(deploymentId, requestId);
  }

  async function deployRequested(input: AcceptedDeployRequest): Promise<DeployRequestedOutcome> {
    const { request, senderRef } = input;
    const { deploymentId, requestId } = request;

    // 1. Definition-derived checks (X2: no claim, no sequence).
    const info = await deps.catalog.getDeployment(deploymentId);
    if (info === undefined) {
      const reason = x2Reason({ deploymentKnown: false });
      await record({ deploymentId, requestId }, reason, senderRef, deploymentId);
      return { outcome: "REJECTED", reason };
    }
    if (!unitSetsEqual(Object.keys(request.artifacts), info.units)) {
      const reason = x2Reason({ consistencyOk: false });
      await record({ deploymentId, requestId }, reason, senderRef, deploymentId);
      return { outcome: "REJECTED", reason };
    }

    // 2. Dedupe claim (DD-20). Nothing below runs without owning it.
    const claim = await acquireClaim(deploymentId, requestId);
    if (!claim.owned) {
      return { outcome: "DUPLICATE", ...(claim.executionId === undefined ? {} : { executionId: claim.executionId }) };
    }

    // 3. Sequence: only after the claim, never for rejections or lost claims.
    const sequence = await resolveSequence(deploymentId, requestId, claim.token, claim.storedSequence);
    const executionId = `${deploymentId}-${String(sequence)}`;

    // 4. X1: QUEUED, `attribute_not_exists` (a repeat after a crash is idempotent), then bind the claim.
    const created = applyTransition(null, { kind: "CREATE", checks: ALL_PASSED });
    if (!created.accepted || created.transitionId !== "X1") throw new Error("execution-service: X1 was not accepted by the state machine");
    const nowMs = deps.clock.now().getTime();
    const order = { sourceRef: buildSourceRef(info.source), runNumber: request.ci.runNumber, runAttempt: request.ci.runAttempt };
    const item: ExecutionItem = {
      executionId,
      deploymentId,
      definitionRef: info.definitionRef,
      requestId,
      commitSha: request.commitSha,
      artifacts: request.artifacts,
      order,
      ci: { repository: request.ci.repository, runId: request.ci.runId, workflowRef: request.ci.workflowRef },
      senderRef,
      lockKey: info.lockKey,
      sequence,
      status: "QUEUED",
      version: 1,
      attempt: created.next.attempt,
      contentionCount: created.next.contentionCount,
      deadlineAt: nowMs + QUEUED_DEADLINE_MS,
      activeStatus: "EXECUTION",
      startedAt: nowMs,
      expiresAt: Math.floor(nowMs / 1000) + EXECUTION_TTL_SECONDS,
    };
    await deps.executions.create(item);
    if (!(await deps.dedupe.bind(deploymentId, requestId, claim.token, executionId))) {
      // The claim was taken over meanwhile; the new owner completes the same idempotent path.
      return { outcome: "DUPLICATE", executionId };
    }

    // 5. highestAccepted: a separate conditional raise (E2). A refusal is expected for an older request.
    const value: OrderingValue = { sourceRef: order.sourceRef, runNumber: order.runNumber };
    const raise = await deps.target.raiseHighestAccepted(info.lockKey, { ...value, executionId });
    if (!raise.accepted && raise.reason === "SOURCE_MISMATCH") throw new OrderingSourceMismatchError(executionId);

    // 6. S1 (cheap, non-authoritative): older than lastDeployed / highestDispatched / highestAccepted -> X3.
    const decision = evaluateS1(value, await deps.target.readOrdering(info.lockKey));
    if (decision.decision === "REJECTED_SOURCE_MISMATCH") throw new OrderingSourceMismatchError(executionId);
    if (decision.decision === "PROCEED") return { outcome: "CREATED", executionId, sequence, status: "QUEUED" };

    const x3 = applyTransition(newExecutionSnapshot("QUEUED"), { kind: "SUPERSEDE_QUEUED", superseded: true });
    if (!x3.accepted || x3.transitionId !== "X3") throw new Error("execution-service: X3 was not accepted by the state machine");
    const applied = await deps.executions.update(
      executionId,
      { status: "QUEUED", version: 1 },
      {
        status: x3.next.status,
        ...(x3.next.error === undefined ? {} : { error: x3.next.error }),
        finishedAt: nowMs,
        activeStatus: undefined,
        deadlineAt: undefined,
      },
    );
    // A lost race here means another writer (the reconciler) already moved it: report what is persisted.
    const status = applied ? "SUPERSEDED" : (await deps.executions.get(executionId))?.status;
    return { outcome: "CREATED", executionId, sequence, status: status === "SUPERSEDED" ? "SUPERSEDED" : "QUEUED" };
  }

  async function rejected(input: RejectionInput): Promise<boolean> {
    return record(rejectionRef(input), input.reason, input.senderRef, input.deploymentId);
  }

  return { deployRequested, rejected };
}
