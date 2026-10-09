// @akili-spec changes/cicd-executor-poc design §1.2, §3.3, §5.1, §6.3, §7 (execution-service row), §7.1, §7.3 (X1, X2, X3), DD-20, DD-25, DD-27; requirements FR-02, FR-03, FR-07, FR-21, FR-23; tasks R-4 (AC-02 V1)
// Identity, dedupe and execution creation. Receives a request already
// validated by the message-router (sender, schema, requestId, target lookup,
// target validity and source authorization, option A) and:
//   1. claims the dedupe key `{targetId, requestId}` (DD-20, leased claim);
//   2. ONLY AFTER owning the claim, takes the per-target sequence (a rejection
//      or a lost claim never consumes a number, RL-5);
//   3. creates the execution in QUEUED (X1, `attribute_not_exists`) with the
//      non-secret snapshot of the target record (design §5.1, §6.3) and binds
//      the claim;
//   4. raises `TARGET.highestAccepted` in a SEPARATE conditional write (E2: not
//      a condition of X1; a refused raise is the expected outcome for an older
//      request);
//   5. evaluates S1 and, when superseded, applies X3 (QUEUED -> SUPERSEDED).
// AC-02 V1: the deploy identity and lock key is the `targetId` (design §1.2);
// there are no Deployment Definitions, so nothing here reads a definition.
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
// Rejections (X2) are recorded under the SQS message identity only
// (`REJECT#MSG#`, design §5.1, §6.3): no item keyed by a target is written.
import { randomUUID } from "node:crypto";
import { applyTransition, newExecutionSnapshot, type CreationChecks } from "../../domain/state-machine/index.js";
import { evaluateS1, type OrderingValue } from "../../domain/supersede-policy/index.js";
import type { Clock } from "../../ports/clock.js";
import type { ValidatedDeployRequest, Rejection } from "../message-router/index.js";
import type { ExecutionItem, RejectionItem, TargetSnapshot } from "../../adapters/dynamodb-state-store/types.js";
import type { TargetRecord } from "../../ports/target-registry.js";
import type {
  DedupePort,
  ExecutionStorePort,
  RejectionStorePort,
  SequencePort,
  TargetOrderingPort,
} from "./ports.js";
import { buildSourceRef } from "./source-ref.js";

export { buildSourceRef, type BoundSource } from "./source-ref.js";
export type {
  DedupePort,
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

/** A validated request plus the audit sender reference (role-ID prefix only, DD-25), carried from the authorizer result. */
export interface AcceptedDeployRequest extends ValidatedDeployRequest {
  readonly senderRef: string;
}

/** A router rejection (it carries the sender reference and the SQS message id, the record key). */
export type RejectionInput = Rejection;

export type DeployRequestedOutcome =
  | { readonly outcome: "CREATED"; readonly executionId: string; readonly sequence: number; readonly status: "QUEUED" | "SUPERSEDED" }
  | { readonly outcome: "DUPLICATE"; readonly executionId?: string };

/** A foreign, live (or just-taken-over) claim owns this request: do NOT acknowledge, SQS redelivers (DD-20). */
export class ClaimInProgressError extends Error {
  public constructor(targetId: string, requestId: string) {
    super(`dedupe claim for ${targetId}#${requestId} is owned by another processing; retry on redelivery`);
    this.name = "ClaimInProgressError";
  }
}

/** Ordering values of different sources met (V1: two caller workflows on one target, V1-R2): fail safe loudly instead of guessing (DD-27). */
export class OrderingSourceMismatchError extends Error {
  public constructor(executionId: string) {
    super(`supersede ordering for ${executionId} met a value of another source; refusing to compare (DD-27)`);
    this.name = "OrderingSourceMismatchError";
  }
}

export interface ExecutionServiceDeps {
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
  targetKnown: true,
  targetValid: true,
  sourceAuthorized: true,
  dedupeClaimOwned: true,
};

/** The non-secret copy of the target record written on the execution at X1 (design §5.1, §6.3). Deep copy: never aliases the caller's object. */
export function snapshotOf(target: TargetRecord): TargetSnapshot {
  return {
    version: target.version,
    project: target.project,
    environment: target.environment,
    host: target.host,
    ...(target.port === undefined ? {} : { port: target.port }),
    user: target.user,
    hostKey: [...target.hostKey],
    credentialRef: target.credentialRef,
    deployScript: target.deployScript,
    deployWindowPolicy: target.deployWindowPolicy,
    sourceRepositoryId: target.sourceRepositoryId,
    // The effective mode is recorded, so the audit shows how the script was invoked (AC-03 G-D1).
    scriptArguments: target.scriptArguments ?? "standard",
  };
}

type ClaimResult =
  | { readonly owned: true; readonly token: string; readonly storedSequence?: number }
  | { readonly owned: false; readonly executionId?: string };

export function createExecutionService(deps: ExecutionServiceDeps): ExecutionService {
  const newClaimToken = deps.newClaimToken ?? randomUUID;

  async function record(input: RejectionInput): Promise<boolean> {
    const item: Omit<RejectionItem, "expiresAt"> = {
      reason: input.reason,
      senderRef: input.senderRef,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      receivedAt: deps.clock.now().getTime(),
    };
    return deps.rejections.record({ sqsMessageId: input.sqsMessageId }, item);
  }

  /** DD-20: returns the owned claim (with an already stored sequence when taken over), or a no-op outcome. */
  async function acquireClaim(targetId: string, requestId: string): Promise<ClaimResult> {
    const token = newClaimToken();
    // Two attempts: the item can only vanish between claim and get through TTL expiry (7 d), which is not worth more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nowMs = deps.clock.now().getTime();
      const leaseUntil = nowMs + DEDUPE_CLAIM_LEASE_MS;
      const expiresAt = Math.floor(nowMs / 1000) + DEDUPE_TTL_SECONDS;
      if (await deps.dedupe.claim(targetId, requestId, token, leaseUntil, expiresAt)) return { owned: true, token };

      const existing = await deps.dedupe.get(targetId, requestId);
      if (existing === undefined) continue;
      if (existing.state === "BOUND") {
        return { owned: false, ...(existing.executionId === undefined ? {} : { executionId: existing.executionId }) };
      }
      if (existing.claimLeaseExpiresAt >= nowMs) throw new ClaimInProgressError(targetId, requestId);
      const tookOver = await deps.dedupe.takeOverExpiredClaim(targetId, requestId, existing.claimToken, token, leaseUntil, nowMs);
      if (!tookOver) throw new ClaimInProgressError(targetId, requestId);
      return { owned: true, token, ...(existing.sequence === undefined ? {} : { storedSequence: existing.sequence }) };
    }
    throw new ClaimInProgressError(targetId, requestId);
  }

  /** DD-20 step 2: reuse a stored sequence, else increment (only here, after the claim) and record it conditional on the claim. */
  async function resolveSequence(targetId: string, requestId: string, token: string, stored: number | undefined): Promise<number> {
    if (stored !== undefined) return stored;
    const taken = await deps.sequences.increment(targetId);
    if (await deps.dedupe.recordSequence(targetId, requestId, token, taken)) return taken;
    // Not recorded: the claim is no longer ours, or a sequence was stored meanwhile (our number becomes a gap).
    const current = await deps.dedupe.get(targetId, requestId);
    if (current?.claimToken === token && current.sequence !== undefined) return current.sequence;
    throw new ClaimInProgressError(targetId, requestId);
  }

  async function deployRequested(input: AcceptedDeployRequest): Promise<DeployRequestedOutcome> {
    const { request, senderRef, target } = input;
    const { targetId, requestId } = request;
    if (target.targetId !== targetId) throw new Error("execution-service: the validated target does not match the request's targetId");

    // 1. Dedupe claim (DD-20). Nothing below runs without owning it; every target check already passed in the router.
    const claim = await acquireClaim(targetId, requestId);
    if (!claim.owned) {
      return { outcome: "DUPLICATE", ...(claim.executionId === undefined ? {} : { executionId: claim.executionId }) };
    }

    // 2. Sequence: only after the claim, never for rejections or lost claims.
    const sequence = await resolveSequence(targetId, requestId, claim.token, claim.storedSequence);
    const executionId = `${targetId}-${String(sequence)}`;

    // 3. X1: QUEUED, `attribute_not_exists` (a repeat after a crash is idempotent), then bind the claim.
    const created = applyTransition(null, { kind: "CREATE", checks: ALL_PASSED });
    if (!created.accepted || created.transitionId !== "X1") throw new Error("execution-service: X1 was not accepted by the state machine");
    const nowMs = deps.clock.now().getTime();
    const order = {
      sourceRef: buildSourceRef({ repository: request.ci.repository, workflow: request.ci.workflowRef }),
      runNumber: request.ci.runNumber,
      runAttempt: request.ci.runAttempt,
    };
    const item: ExecutionItem = {
      executionId,
      targetId,
      targetSnapshot: snapshotOf(target),
      requestId,
      commitSha: request.commitSha,
      artifacts: request.artifacts ?? {},
      order,
      ci: { repository: request.ci.repository, runId: request.ci.runId, workflowRef: request.ci.workflowRef },
      senderRef,
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
    if (!(await deps.dedupe.bind(targetId, requestId, claim.token, executionId))) {
      // The claim was taken over meanwhile; the new owner completes the same idempotent path.
      return { outcome: "DUPLICATE", executionId };
    }

    // 4. highestAccepted: a separate conditional raise (E2). A refusal is expected for an older request.
    const value: OrderingValue = { sourceRef: order.sourceRef, runNumber: order.runNumber };
    const raise = await deps.target.raiseHighestAccepted(targetId, { ...value, executionId });
    if (!raise.accepted && raise.reason === "SOURCE_MISMATCH") throw new OrderingSourceMismatchError(executionId);

    // 5. S1 (cheap, non-authoritative): older than lastDeployed / highestDispatched / highestAccepted -> X3.
    const decision = evaluateS1(value, await deps.target.readOrdering(targetId));
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
    return record(input);
  }

  return { deployRequested, rejected };
}
