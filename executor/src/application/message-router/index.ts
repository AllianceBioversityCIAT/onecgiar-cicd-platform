// @akili-spec changes/cicd-executor-poc design §6.1, §6.4, §7 (message-router and execution-service rows), §3.3; requirements FR-03, FR-04, RL-3
// Message router (Model B). Parses a raw message body and routes it by
// `eventType` to injected handlers. It decides ONLY whether the message is
// acknowledged:
//   - unparseable (not JSON, not an object, > 8 KB) -> NO ack, left for the
//     DLQ after 5 receptions (RL-3);
//   - parseable DEPLOY_REQUESTED that fails sender authorization, schema,
//     requestId (CC-2), deployment lookup or consistency -> X2 REJECTED via
//     the closed state machine (CREATE with the failed check), acknowledged,
//     never retried (FR-04);
//   - parseable + valid -> the matching handler, acknowledged when it
//     resolves; a handler error propagates (no ack, SQS redelivery);
//   - an unknown eventType, or an internal event that fails its schema, has
//     no execution to reject: NO ack, left for the DLQ and its alarm.
// Check order follows design §3.3 (sender -> schema -> requestId -> definition
// lookup -> consistency); only the FIRST failing check is evaluated, the rest
// are reported as passed because the state machine reports the first reason.
//
// Out of scope here: dedupe claim, sequence, X1 creation, S1 (execution-service),
// sender mapping (N-06, DD-25), orphan events and RETRY_LATER (removed by
// AC-01). The router never reads the body `source` field to authorize.
import {
  DEPLOY_REQUESTED,
  consistentWithSource,
  isInternalEventType,
  isMessageEventType,
  parseMessageBody,
  requestIdMatches,
  type DeployRequest,
  type InternalEvent,
  type InternalEventType,
  type MessageEventType,
  type ResolvedSource,
  type UnparseableReason,
} from "../../domain/request-contract/index.js";
import type { RejectReason } from "../../domain/errors/index.js";
import { applyTransition, type CreationChecks, type TransitionResult } from "../../domain/state-machine/index.js";
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
 * Sender-authorization hook (DD-25, FR-21). N-06's `sender-authorizer` plugs in
 * here. The decision must come from the AWS-provided `senderId` and trusted
 * configuration only: the router passes NO body field except the lookup key
 * `deploymentId` (never an authorization input by itself), and never the body
 * `source` field.
 */
export interface SenderAuthorizer {
  authorize(request: {
    /** SQS `SenderId` system attribute (`ROLEID:session`), undefined when absent. */
    readonly senderId: string | undefined;
    readonly eventType: MessageEventType;
    /** Only for DEPLOY_REQUESTED, and only when the body carries a string; unvalidated lookup key. */
    readonly deploymentId?: string;
  }): Promise<boolean>;
}

/** Resolves a deployment's bound source (DD-27) from its definition; `undefined` when no definition exists. */
export interface DeploymentSourceLookup {
  resolveSource(deploymentId: string): Promise<ResolvedSource | undefined>;
}

type CreationChecksWithoutClaim = Omit<CreationChecks, "dedupeClaimOwned">;

/** A rejection to persist (REJECT#MSG#, design §5.1): X2 computed by the state machine. */
export interface Rejection {
  readonly transitionId: "X2";
  readonly reason: RejectReason;
  /** Violated rules (schema errors) or a short explanation; never a secret. */
  readonly details: readonly string[];
  /** Best-effort identifiers read from the (possibly invalid) body, for audit only. Strings only. */
  readonly requestId?: string;
  readonly deploymentId?: string;
}

/** Accepted, contract-valid deploy request, ready for execution-service (dedupe claim, sequence, X1). */
export interface ValidatedDeployRequest {
  readonly request: DeployRequest;
  readonly source: ResolvedSource;
  /** All checks passed except the dedupe claim, which execution-service owns (DD-20); feed these plus the claim to `applyTransition` CREATE (X1). */
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
  targetResolutionRecorded(event: EventOf<"TARGET_RESOLUTION_RECORDED">): Promise<void>;
}

export interface MessageRouterDeps {
  readonly validators: MessageValidators;
  readonly authorizer: SenderAuthorizer;
  readonly sources: DeploymentSourceLookup;
  readonly handlers: MessageHandlers;
}

export interface IncomingMessage {
  /** Raw SQS body. */
  readonly body: string;
  /** SQS `SenderId` system attribute (P-A4). */
  readonly senderId?: string;
}

export type UnroutableReason = UnparseableReason | "UNKNOWN_EVENT_TYPE" | "INVALID_INTERNAL_EVENT";

export type RouteResult =
  /** Leave the message on the queue: SQS redelivers and, after 5 receptions, moves it to the DLQ (RL-3). */
  | { readonly ack: false; readonly outcome: "UNROUTABLE"; readonly reason: UnroutableReason; readonly details: readonly string[] }
  /** Acknowledge: X2 persisted through the `rejected` handler. */
  | { readonly ack: true; readonly outcome: "REJECTED"; readonly reason: RejectReason }
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
  deploymentKnown: true,
  consistencyOk: true,
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
  deps: MessageRouterDeps,
  failed: Partial<CreationChecksWithoutClaim>,
  details: readonly string[],
  body: Readonly<Record<string, unknown>>,
): Promise<RouteResult> {
  const reason = x2Reason(applyTransition(null, { kind: "CREATE", checks: { ...PASSED, ...failed, dedupeClaimOwned: false } }));
  const requestId = stringField(body, "requestId");
  const deploymentId = stringField(body, "deploymentId");
  await deps.handlers.rejected({
    transitionId: "X2",
    reason,
    details,
    ...(requestId === undefined ? {} : { requestId }),
    ...(deploymentId === undefined ? {} : { deploymentId }),
  });
  return { ack: true, outcome: "REJECTED", reason };
}

async function routeDeployRequest(
  message: IncomingMessage,
  body: Readonly<Record<string, unknown>>,
  deps: MessageRouterDeps,
): Promise<RouteResult> {
  const lookupKey = stringField(body, "deploymentId");
  const authorized = await deps.authorizer.authorize({
    senderId: message.senderId,
    eventType: DEPLOY_REQUESTED,
    ...(lookupKey === undefined ? {} : { deploymentId: lookupKey }),
  });
  if (!authorized) return reject(deps, { senderAuthorized: false }, ["sender is not authorized for this request"], body);

  const schema = deps.validators.deployRequest.validate(body);
  if (!schema.valid) return reject(deps, { schemaValid: false }, schema.errors, body);
  const request = body as unknown as DeployRequest;

  if (!requestIdMatches(request)) {
    return reject(deps, { requestIdMatches: false }, ["requestId must equal ci.runId-ci.runAttempt"], body);
  }

  const source = await deps.sources.resolveSource(request.deploymentId);
  if (source === undefined) return reject(deps, { deploymentKnown: false }, ["no definition for deploymentId"], body);

  if (!consistentWithSource(request, source)) {
    return reject(deps, { consistencyOk: false }, ["ci.repository or ci.workflowRef does not match the resolved source"], body);
  }

  await deps.handlers.deployRequested({ request, source, checks: PASSED });
  return { ack: true, outcome: "HANDLED", eventType: DEPLOY_REQUESTED };
}

async function routeInternalEvent(
  message: IncomingMessage,
  eventType: InternalEventType,
  body: Readonly<Record<string, unknown>>,
  deps: MessageRouterDeps,
): Promise<RouteResult> {
  const authorized = await deps.authorizer.authorize({ senderId: message.senderId, eventType });
  if (!authorized) {
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
      await h.targetResolutionRecorded(event);
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
