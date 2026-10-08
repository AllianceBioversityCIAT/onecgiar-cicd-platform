// @akili-spec changes/cicd-executor-poc design §1.2, §3.3, §6.1, §6.3, §6.4, §7 (message-router and execution-service rows), §7.2, §7.3 (X1, X2), DD-25; requirements FR-02, FR-03, FR-04, FR-21, RL-3; tasks R-4 (AC-02 V1)
// Message router (Model B, AC-02 V1). Parses a raw message body and routes it
// by `eventType` to injected handlers. It decides ONLY whether the message is
// acknowledged:
//   - unparseable (not JSON, not an object, > 8 KB) -> NO ack, left for the
//     DLQ after 5 receptions (RL-3);
//   - parseable DEPLOY_REQUESTED that fails sender authorization, schema,
//     requestId (CC-2), or the target checks (unknown, invalid, not authorized
//     for the source repository) -> X2 REJECTED via the closed state machine,
//     acknowledged, never retried (FR-04);
//   - parseable + valid -> the matching handler, acknowledged when it
//     resolves; a handler error propagates (no ack, SQS redelivery);
//   - an unknown eventType, or an internal event that fails its schema, has
//     no execution to reject: NO ack, left for the DLQ and its alarm.
// Check order (design §3.3, §6.3): sender -> schema -> requestId -> target
// lookup (one GetItem, R-3) -> target validity -> source authorization (the
// IAM-enforced SenderId session = the record's `sourceRepositoryId`, option A).
// Every one of them runs BEFORE any dedupe claim, sequence, `highestAccepted`,
// `highestDispatched`, lock or window write, so an unauthorized request never
// touches the target's operational state. Every DEPLOY_REQUESTED rejection is
// recorded under the SQS message identity (`REJECT#MSG#`, design §5.1, §6.3).
// Redelivery: before rejecting for TARGET_UNKNOWN or TARGET_INVALID (never for
// TARGET_NOT_AUTHORIZED), the router reads (no claim) the dedupe item: BOUND ->
// no-op; CLAIMED with a live lease -> left to redelivery (DD-20); absent or an
// expired claim -> rejected.
// Out of scope here: dedupe claim, sequence, X1 creation, S1 (execution-service).
// The router never reads the body `source` or `ci.*` fields to authorize.
import {
  DEPLOY_REQUESTED,
  isInternalEventType,
  isMessageEventType,
  parseMessageBody,
  requestIdMatches,
  type DeployRequest,
  type InternalEvent,
  type InternalEventType,
  type MessageEventType,
  type UnparseableReason,
} from "../../domain/request-contract/index.js";
import type { RejectReason } from "../../domain/errors/index.js";
import { applyTransition, type CreationChecks, type TransitionResult } from "../../domain/state-machine/index.js";
import type { Clock } from "../../ports/clock.js";
import type { TargetRecord, TargetRegistry } from "../../ports/target-registry.js";
import type { MessageValidators } from "./schema-validation.js";

export {
  createMessageValidators,
  DEPLOY_REQUEST_SCHEMA_NAME,
  EVENT_SCHEMA_NAME,
  type MessageValidators,
  type MessageSchemaValidator,
  type SchemaValidationResult,
} from "./schema-validation.js";

// ---------------------------------------------------------------------------
// Ports/hooks the router depends on (implemented elsewhere).
// ---------------------------------------------------------------------------

/**
 * Sender-authorization hook (DD-25, FR-21). The decision comes from the
 * AWS-provided `senderId` and trusted configuration only: the router passes NO
 * body field.
 */
export interface SenderAuthorizer {
  /**
   * Synchronous, fail-closed decision. `senderRef` is the role-ID prefix only. For an
   * authorized DEPLOY_REQUESTED, `sourceRepositoryId` is the IAM-enforced session name
   * (the sender's GitHub repository_id, option A); it is absent for every other type.
   */
  decide(request: {
    /** SQS `SenderId` system attribute (`ROLEID:session`), undefined when absent. */
    readonly senderId: string | undefined;
    readonly eventType: MessageEventType;
  }): { readonly authorized: boolean; readonly senderRef?: string; readonly sourceRepositoryId?: string };
}

/** Audit sender reference recorded when the SenderId could not be parsed at all (no role-ID prefix exists). */
export const UNKNOWN_SENDER_REF = "UNKNOWN";

/** Read-only view of the dedupe item, for the redelivery check of a target rejection (design §6.3). */
export interface DedupeLookup {
  get(targetId: string, requestId: string): Promise<{ readonly state: "CLAIMED" | "BOUND"; readonly claimLeaseExpiresAt: number } | undefined>;
}

/** A live dedupe claim owns this request: do NOT acknowledge, SQS redelivers (DD-20). */
export class DedupeClaimPendingError extends Error {
  public constructor() {
    super("a live dedupe claim owns this request; leaving it for redelivery");
    this.name = "DedupeClaimPendingError";
  }
}

type CreationChecksWithoutClaim = Omit<CreationChecks, "dedupeClaimOwned">;

/** A rejection to persist (REJECT#MSG#, design §5.1): X2 computed by the state machine. */
export interface Rejection {
  readonly transitionId: "X2";
  readonly reason: RejectReason;
  /** Violated rules (schema errors) or a short explanation; never a secret, never a stored target value. */
  readonly details: readonly string[];
  /** Best-effort identifiers read from the (possibly invalid) body, for audit only. Strings only. */
  readonly requestId?: string;
  readonly targetId?: string;
  /** Audit sender reference (role-ID prefix only, DD-25); `UNKNOWN_SENDER_REF` when the SenderId did not parse. */
  readonly senderRef: string;
  /** SQS MessageId: the `REJECT#MSG#` key of every DEPLOY_REQUESTED rejection (AC-02 V1). */
  readonly sqsMessageId: string;
}

/** Accepted, contract-valid deploy request, ready for execution-service (dedupe claim, sequence, X1). */
export interface ValidatedDeployRequest {
  readonly request: DeployRequest;
  /** The validated target record (R-3); its non-secret fields become the execution snapshot at X1. */
  readonly target: TargetRecord;
  /** Audit sender reference (role-ID prefix only, DD-25), persisted to `EXEC#.senderRef` (FR-21). */
  readonly senderRef: string;
  /** All checks passed except the dedupe claim, which execution-service owns (DD-20). */
  readonly checks: CreationChecksWithoutClaim;
}

type EventOf<T extends InternalEventType> = Extract<InternalEvent, { eventType: T }>;

export interface MessageHandlers {
  deployRequested(validated: ValidatedDeployRequest): Promise<void>;
  rejected(rejection: Rejection): Promise<void>;
  /** An internal event whose sender is not authorized (DD-25): audit/metric/alarm. */
  unauthorizedInternalEvent(info: { readonly eventType: InternalEventType; readonly senderId: string | undefined }): Promise<void>;
  lockRetryRequested(event: EventOf<"LOCK_RETRY_REQUESTED">): Promise<void>;
  reconcileTick(event: EventOf<"RECONCILE_TICK">): Promise<void>;
  deployWindowOpenRequested(event: EventOf<"DEPLOY_WINDOW_OPEN_REQUESTED">): Promise<void>;
  deployWindowCloseRequested(event: EventOf<"DEPLOY_WINDOW_CLOSE_REQUESTED">): Promise<void>;
  /** `context.senderRef` is the operator principal's role-ID prefix (audit data, DD-25). */
  targetResolutionRecorded(event: EventOf<"TARGET_RESOLUTION_RECORDED">, context: { readonly senderRef: string }): Promise<void>;
}

export interface MessageRouterDeps {
  readonly validators: MessageValidators;
  readonly authorizer: SenderAuthorizer;
  /** Read-only Target Registry (R-3). */
  readonly targets: TargetRegistry;
  readonly dedupe: DedupeLookup;
  readonly clock: Clock;
  readonly handlers: MessageHandlers;
}

export interface IncomingMessage {
  /** Raw SQS body. */
  readonly body: string;
  /** SQS `SenderId` system attribute (P-A4). */
  readonly senderId?: string;
  /** SQS `MessageId`: the `REJECT#MSG#` key of a rejection. */
  readonly messageId?: string;
}

export type UnroutableReason = UnparseableReason | "UNKNOWN_EVENT_TYPE" | "INVALID_INTERNAL_EVENT";

export type RouteResult =
  /** Leave the message on the queue: SQS redelivers and, after 5 receptions, moves it to the DLQ (RL-3). */
  | { readonly ack: false; readonly outcome: "UNROUTABLE"; readonly reason: UnroutableReason; readonly details: readonly string[] }
  /** Acknowledge: X2 persisted through the `rejected` handler. */
  | { readonly ack: true; readonly outcome: "REJECTED"; readonly reason: RejectReason }
  /** Acknowledge: a redelivery of an already accepted request whose target record changed afterwards (design §6.3). */
  | { readonly ack: true; readonly outcome: "DUPLICATE" }
  /** Acknowledge: an internal event from an unauthorized sender. */
  | { readonly ack: true; readonly outcome: "UNAUTHORIZED"; readonly eventType: InternalEventType }
  /** Acknowledge: the handler for this type resolved. */
  | { readonly ack: true; readonly outcome: "HANDLED"; readonly eventType: MessageEventType };

function unroutable(reason: UnroutableReason, details: readonly string[] = []): RouteResult {
  return { ack: false, outcome: "UNROUTABLE", reason, details };
}

const PASSED: CreationChecksWithoutClaim = {
  senderAuthorized: true,
  schemaValid: true,
  requestIdMatches: true,
  targetKnown: true,
  targetValid: true,
  sourceAuthorized: true,
};

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = value[key];
  return typeof v === "string" ? v : undefined;
}

function x2Reason(transition: TransitionResult): RejectReason {
  // CREATE with a failed check is X2 by construction; anything else is a state-machine contract break.
  if (!transition.accepted || transition.transitionId !== "X2" || transition.rejectReason === undefined) {
    throw new Error("message-router: a failed creation check did not yield X2");
  }
  return transition.rejectReason;
}

async function reject(
  message: IncomingMessage,
  senderRef: string,
  deps: MessageRouterDeps,
  failed: Partial<CreationChecksWithoutClaim>,
  details: readonly string[],
  body: Readonly<Record<string, unknown>>,
): Promise<RouteResult> {
  const reason = x2Reason(applyTransition(null, { kind: "CREATE", checks: { ...PASSED, ...failed, dedupeClaimOwned: false } }));
  if (message.messageId === undefined || message.messageId === "") {
    // Every rejection is keyed by the SQS message id (REJECT#MSG#); without it nothing can be recorded: do not acknowledge.
    throw new Error("message-router: a rejection needs the SQS message id (REJECT#MSG#)");
  }
  const requestId = stringField(body, "requestId");
  const targetId = stringField(body, "targetId");
  await deps.handlers.rejected({
    transitionId: "X2",
    reason,
    details,
    ...(requestId === undefined ? {} : { requestId }),
    ...(targetId === undefined ? {} : { targetId }),
    senderRef,
    sqsMessageId: message.messageId,
  });
  return { ack: true, outcome: "REJECTED", reason };
}

/** Design §6.3 redelivery rule for TARGET_UNKNOWN / TARGET_INVALID: a read, never a claim. */
async function alreadyAccepted(deps: MessageRouterDeps, request: DeployRequest): Promise<boolean> {
  const dedupe = await deps.dedupe.get(request.targetId, request.requestId);
  if (dedupe === undefined) return false;
  if (dedupe.state === "BOUND") return true;
  if (dedupe.claimLeaseExpiresAt >= deps.clock.now().getTime()) throw new DedupeClaimPendingError();
  return false; // an expired claim created no execution: the request is rejected
}

async function routeDeployRequest(
  message: IncomingMessage,
  body: Readonly<Record<string, unknown>>,
  deps: MessageRouterDeps,
): Promise<RouteResult> {
  const decision = deps.authorizer.decide({ senderId: message.senderId, eventType: DEPLOY_REQUESTED });
  const senderRef = decision.senderRef ?? UNKNOWN_SENDER_REF;
  if (!decision.authorized || decision.sourceRepositoryId === undefined) {
    return reject(message, senderRef, deps, { senderAuthorized: false }, ["sender is not authorized for this request"], body);
  }

  const schema = deps.validators.deployRequest.validate(body);
  if (!schema.valid) return reject(message, senderRef, deps, { schemaValid: false }, schema.errors, body);
  const request = body as unknown as DeployRequest;

  if (!requestIdMatches(request)) {
    return reject(message, senderRef, deps, { requestIdMatches: false }, ["requestId must equal ci.runId-ci.runAttempt"], body);
  }

  const lookup = await deps.targets.getTarget(request.targetId);
  if (lookup.kind === "missing") {
    if (await alreadyAccepted(deps, request)) return { ack: true, outcome: "DUPLICATE" };
    return reject(message, senderRef, deps, { targetKnown: false }, ["no target record for targetId"], body);
  }
  if (lookup.kind === "invalid") {
    if (await alreadyAccepted(deps, request)) return { ack: true, outcome: "DUPLICATE" };
    return reject(message, senderRef, deps, { targetValid: false }, lookup.problems, body);
  }
  if (lookup.target.sourceRepositoryId !== decision.sourceRepositoryId) {
    // Never a dedupe read here: an unauthorized request must not touch, or depend on, the target's state.
    return reject(message, senderRef, deps, { sourceAuthorized: false }, ["the sender's repository is not the target's source repository"], body);
  }

  await deps.handlers.deployRequested({ request, target: lookup.target, checks: PASSED, senderRef });
  return { ack: true, outcome: "HANDLED", eventType: DEPLOY_REQUESTED };
}

async function routeInternalEvent(
  message: IncomingMessage,
  eventType: InternalEventType,
  body: Readonly<Record<string, unknown>>,
  deps: MessageRouterDeps,
): Promise<RouteResult> {
  const decision = deps.authorizer.decide({ senderId: message.senderId, eventType });
  if (!decision.authorized) {
    await deps.handlers.unauthorizedInternalEvent({ eventType, senderId: message.senderId });
    return { ack: true, outcome: "UNAUTHORIZED", eventType };
  }
  const schema = deps.validators.internalEvent.validate(body);
  if (!schema.valid) return unroutable("INVALID_INTERNAL_EVENT", schema.errors);

  const h = deps.handlers;
  const event = body as unknown as InternalEvent;
  switch (event.eventType) {
    case "LOCK_RETRY_REQUESTED":
      await h.lockRetryRequested(event);
      break;
    case "RECONCILE_TICK":
      await h.reconcileTick(event);
      break;
    case "DEPLOY_WINDOW_OPEN_REQUESTED":
      await h.deployWindowOpenRequested(event);
      break;
    case "DEPLOY_WINDOW_CLOSE_REQUESTED":
      await h.deployWindowCloseRequested(event);
      break;
    case "TARGET_RESOLUTION_RECORDED":
      await h.targetResolutionRecorded(event, { senderRef: decision.senderRef ?? UNKNOWN_SENDER_REF });
      break;
  }
  return { ack: true, outcome: "HANDLED", eventType };
}

/**
 * Routes one message. Resolves to whether the consumer must acknowledge it; a
 * rejected promise (handler/port failure) means "do not acknowledge".
 */
export async function routeMessage(message: IncomingMessage, deps: MessageRouterDeps): Promise<RouteResult> {
  const parsed = parseMessageBody(message.body);
  if (!parsed.parseable) return unroutable(parsed.reason);

  const eventType = parsed.value["eventType"];
  if (!isMessageEventType(eventType)) {
    return unroutable("UNKNOWN_EVENT_TYPE", [`unrecognized eventType (${typeof eventType})`]);
  }
  return isInternalEventType(eventType)
    ? routeInternalEvent(message, eventType, parsed.value, deps)
    : routeDeployRequest(message, parsed.value, deps);
}
