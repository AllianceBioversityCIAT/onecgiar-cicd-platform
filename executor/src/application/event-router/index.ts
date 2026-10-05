// @akili-spec changes/cicd-executor-poc design §6.1, §7 (event-router row); requirements FR-04, FR-07
// Validates the envelope, normalizes AWS-native sources, detects orphan
// events, routes by eventType (FR-04). No business logic beyond that
// (design §7's event-router row lists nothing forbidden beyond its own
// listed responsibilities) — handlers own everything that happens once an
// event is routed to them.
import {
  MalformedEventError,
  isCodeBuildStateChangeEvent,
  isLambdaDestinationsRecord,
  normalizeCodeBuildStateChangeEvent,
  normalizeLambdaDestinationsRecord,
  type EventEnvelope,
  type EventType,
  type NormalizedEventDraft,
} from "../../domain/events/index.js";
import type { StepState } from "../../domain/state-machine/index.js";
import type { EnvelopeValidator } from "./schema-validation.js";

export { MalformedEventError } from "../../domain/events/index.js";
export { createEnvelopeValidator, type EnvelopeValidator, type EnvelopeValidationResult } from "./schema-validation.js";

// ---------------------------------------------------------------------------
// StateStore-backed lookup seam (design §6.1 "Orphan events"): a small
// interface over the StateStore port (DD-03). Only the seam is defined here
// — a concrete adapter composing the real StateStore and its persisted key
// scheme (design §5.1) is a later task's job (step-dispatcher/reconciler
// wiring), out of this task's reading scope.
// ---------------------------------------------------------------------------

export type OrphanReason = "EXECUTION_NOT_FOUND" | "STEP_NOT_FOUND" | "STALE_ATTEMPT";

export type StepAttemptLookupResult =
  | { readonly found: false; readonly reason: Exclude<OrphanReason, "STALE_ATTEMPT"> }
  | {
      readonly found: true;
      readonly pipelineId: string;
      /** The execution's environment (design §6.1 envelope field; the PoC's semantic validation accepts no value other than `"dev"`). Taken from the execution record, never hardcoded by this module. */
      readonly environment: "dev";
      readonly attempt: number;
      /**
       * The step's own state-machine status (design §7.3's `StepState`:
       * `PENDING`/`WAITING_LOCK`/`DISPATCHING`/`RUNNING`/a terminal state) —
       * NOT the envelope's business `status` field (e.g. `"PASSED"` or
       * `"SUCCEEDED"`, design §6.1's envelope table). Used only to tell the
       * CodeBuild early-arrival race (`DISPATCHING`, `externalRef` not yet
       * registered — see `routeEvent`'s `RETRY_LATER` outcome) apart from a
       * genuinely stale/orphan attempt.
       */
      readonly status: StepState;
      /**
       * Lambda's correlation key (design §6.1: `requestPayload.executionId`
       * + `stepId` + `dispatchToken`). Minted and persisted the moment the
       * step enters `DISPATCHING` (design §6.4's decision: "register
       * DISPATCHING + dispatchToken before calling AWS") and echoed straight
       * back by the worker in its own request payload (design §6.2) — so,
       * unlike `externalRef`, it is always available once `found` is true
       * for a step that has ever dispatched. `undefined` only for a step
       * that has never dispatched (`attempt === 0`).
       */
      readonly dispatchToken?: string;
      /** The current attempt's external identifier for CodeBuild (design §6.1: `buildId == externalRef`). `undefined` before CodeBuild's `StartBuild` response has been persisted — the early-arrival race window `routeEvent` resolves as `RETRY_LATER`, not `ORPHAN`, while `status === "DISPATCHING"`. */
      readonly externalRef?: string;
    };

export interface StepAttemptLookup {
  findCurrentAttempt(executionId: string, stepId: string): Promise<StepAttemptLookupResult>;
}

// ---------------------------------------------------------------------------
// Logging / metrics seams (design §6.1: "log with every identifier
// received" + metric `OrphanEvents`). Narrow interfaces — this module does
// not depend on the (not yet implemented) observability module.
// ---------------------------------------------------------------------------

export interface OrphanEventDetails {
  readonly reason: OrphanReason;
  readonly executionId: string;
  readonly stepId: string;
  readonly externalId?: string;
  readonly currentExternalRef?: string;
}

export interface EventRouterLogger {
  orphanEvent(details: OrphanEventDetails): void;
}

export interface EventRouterMetrics {
  recordOrphanEvent(): void;
}

// ---------------------------------------------------------------------------
// Handler map (design §7's event-router row: "...and routes"). One handler per
// eventType, looked up and invoked — this module decides WHICH handler runs,
// never what the handler does.
// ---------------------------------------------------------------------------

export type EventHandler = (envelope: EventEnvelope) => Promise<void> | void;
export type EventHandlerMap = Partial<Record<EventType, EventHandler>>;

export interface RouteEventDeps {
  readonly envelopeValidator: EnvelopeValidator;
  readonly attemptLookup: StepAttemptLookup;
  readonly logger: EventRouterLogger;
  readonly metrics: EventRouterMetrics;
  readonly handlers: EventHandlerMap;
}

export type RouteEventOutcome =
  | { readonly kind: "ROUTED"; readonly envelope: EventEnvelope }
  | { readonly kind: "NO_HANDLER"; readonly envelope: EventEnvelope }
  | { readonly kind: "ORPHAN"; readonly reason: OrphanReason }
  /**
   * The CodeBuild early-arrival race (design §6.1/§6.4): a real, current
   * attempt whose `externalRef` has not been persisted yet because the
   * build finished faster than the `StartBuild` response could be written
   * to the StateStore. This is NOT an orphan — the attempt is real — so the
   * consumer (T-18) MUST leave the message unacknowledged so SQS redelivers
   * it (never ack, never route to a handler; DD-02 gives no ordering
   * guarantee that would let this module simply wait).
   */
  | { readonly kind: "RETRY_LATER"; readonly reason: "EXTERNAL_REF_NOT_YET_REGISTERED" };

function normalizeNativeRecord(rawMessage: unknown): NormalizedEventDraft {
  if (isLambdaDestinationsRecord(rawMessage)) {
    return normalizeLambdaDestinationsRecord(rawMessage);
  }
  if (isCodeBuildStateChangeEvent(rawMessage)) {
    return normalizeCodeBuildStateChangeEvent(rawMessage);
  }
  throw new MalformedEventError(
    "message is neither a valid event envelope nor a recognized AWS-native shape " +
      "(Lambda Destinations record / EventBridge CodeBuild Build State Change)",
    rawMessage,
  );
}

type AttemptLookupFound = Extract<StepAttemptLookupResult, { found: true }>;
type CorrelationOutcome = "MATCH" | "STALE" | "PENDING";

/**
 * Compares a normalized AWS-native result against the current attempt per
 * design §6.1's correlation column, source by source — NOT uniformly,
 * because Lambda and CodeBuild register their correlation key at different
 * points in the dispatch lifecycle (design §6.4's decision table):
 *
 *   - Lambda: `dispatchToken` is minted and persisted the moment the step
 *     enters `DISPATCHING`, before the invocation is even made, and the
 *     worker's own request payload echoes it straight back. There is no
 *     window where a Lambda result can arrive before its correlation key is
 *     known — match on `dispatchToken` always.
 *   - CodeBuild: the correlation key is `buildId == externalRef`, but
 *     `externalRef` is only persisted once `StartBuild`'s response comes
 *     back (T6). A build that finishes fast enough can have its completion
 *     event reach this router BEFORE that write lands (the early-arrival
 *     race) — that is `PENDING` (design §6.1/§6.4), not stale: the attempt
 *     is real, just not correlatable yet.
 *
 * (FR-04's scenario text says "requestId or buildId"; design §6.1's table is
 * more specific for Lambda — `dispatchToken` — and wins as the more specific
 * source; Leader decision 2026-10-05.)
 */
function correlateAttempt(draft: NormalizedEventDraft, lookup: AttemptLookupFound): CorrelationOutcome {
  if (draft.source === "lambda") {
    return lookup.dispatchToken === draft.externalId ? "MATCH" : "STALE";
  }

  if (lookup.externalRef === undefined) {
    return lookup.status === "DISPATCHING" ? "PENDING" : "STALE";
  }
  return lookup.externalRef === draft.externalId ? "MATCH" : "STALE";
}

function reportOrphan(deps: RouteEventDeps, details: OrphanEventDetails): void {
  // design §6.1: "log with every identifier received" under
  // ORPHAN_EVENT + metric `OrphanEvents`, then ack WITHOUT effects — no
  // handler is ever invoked for an orphan (the caller returns right after
  // this call, never reaching `dispatch`).
  deps.logger.orphanEvent(details);
  deps.metrics.recordOrphanEvent();
}

async function dispatch(envelope: EventEnvelope, deps: RouteEventDeps): Promise<RouteEventOutcome> {
  const handler = deps.handlers[envelope.eventType];
  if (handler === undefined) {
    return { kind: "NO_HANDLER", envelope };
  }
  await handler(envelope);
  return { kind: "ROUTED", envelope };
}

/**
 * FR-04's whole pipeline for one inbound SQS message body:
 *
 * 1. If it already validates as a full envelope (schemas/event.schema.json),
 *    use it as-is (FR-04 "valid envelope"). If it is step-scoped (carries
 *    `executionId` + `stepId`), it still gets the existence half of the
 *    orphan check — unknown execution/step is checked for every step-scoped
 *    event, not only AWS-native ones — but not the external-id match (an
 *    already-full envelope carries no separate external correlation id to
 *    compare; that check only applies to the AWS-native path below).
 * 2. Otherwise, recognize + normalize an AWS-native shape (FR-04 "native AWS
 *    results") into a draft, look up the current attempt
 *    (StepAttemptLookup), and:
 *      - unknown execution / unknown step -> ORPHAN_EVENT, no effects
 *        (FR-04 "orphan event").
 *      - a known execution/step whose current attempt does not correlate
 *        with the draft (`correlateAttempt` "STALE") -> ORPHAN_EVENT, no
 *        effects (design §6.1: "the result of a previous,
 *        already-superseded attempt" — an event from a superseded attempt
 *        never mutates the current one).
 *      - a known, CURRENT CodeBuild attempt whose `externalRef` has not been
 *        persisted yet (`correlateAttempt` "PENDING", the early-arrival
 *        race) -> `RETRY_LATER`, no effects, NOT acknowledged (the consumer,
 *        T-18, must leave it for SQS to redeliver — acking it here would
 *        lose a valid result, design §6.1/§6.4).
 *      - otherwise, complete the envelope with the looked-up
 *        `pipelineId`/`attempt`/`environment` (from the execution record,
 *        never hardcoded), re-validate it against the schema as a defense
 *        in depth, and proceed.
 * 3. Route to the matching handler in `deps.handlers`, if one is registered.
 *
 * Anything that is neither a valid envelope nor a recognizable AWS-native
 * shape throws `MalformedEventError` (FR-04 "poisoned message") — the
 * caller (the SQS consumer, T-18) MUST NOT catch this as a normal outcome:
 * it must leave the message unacknowledged so SQS redelivers it, eventually
 * to the DLQ after 5 receives.
 */
export async function routeEvent(rawMessage: unknown, deps: RouteEventDeps): Promise<RouteEventOutcome> {
  const directValidation = deps.envelopeValidator.validate(rawMessage);

  if (directValidation.valid) {
    const envelope = rawMessage as EventEnvelope;
    if (envelope.executionId !== undefined && envelope.stepId !== undefined) {
      const lookup = await deps.attemptLookup.findCurrentAttempt(envelope.executionId, envelope.stepId);
      if (!lookup.found) {
        reportOrphan(deps, { reason: lookup.reason, executionId: envelope.executionId, stepId: envelope.stepId });
        return { kind: "ORPHAN", reason: lookup.reason };
      }
    }
    return dispatch(envelope, deps);
  }

  const draft = normalizeNativeRecord(rawMessage);
  const lookup = await deps.attemptLookup.findCurrentAttempt(draft.executionId, draft.stepId);

  if (!lookup.found) {
    reportOrphan(deps, {
      reason: lookup.reason,
      executionId: draft.executionId,
      stepId: draft.stepId,
      externalId: draft.externalId,
    });
    return { kind: "ORPHAN", reason: lookup.reason };
  }

  const correlation = correlateAttempt(draft, lookup);

  if (correlation === "PENDING") {
    return { kind: "RETRY_LATER", reason: "EXTERNAL_REF_NOT_YET_REGISTERED" };
  }

  if (correlation === "STALE") {
    reportOrphan(deps, {
      reason: "STALE_ATTEMPT",
      executionId: draft.executionId,
      stepId: draft.stepId,
      externalId: draft.externalId,
      currentExternalRef: lookup.externalRef,
    });
    return { kind: "ORPHAN", reason: "STALE_ATTEMPT" };
  }

  const envelope: EventEnvelope = {
    specVersion: 1,
    eventId: draft.eventId,
    eventType: draft.eventType,
    executionId: draft.executionId,
    pipelineId: lookup.pipelineId,
    environment: lookup.environment,
    stepId: draft.stepId,
    status: draft.status,
    attempt: lookup.attempt,
    timestamp: draft.timestamp,
    source: draft.source,
    payload: draft.payload,
  };

  const enrichedValidation = deps.envelopeValidator.validate(envelope);
  if (!enrichedValidation.valid) {
    throw new MalformedEventError(
      `normalized envelope failed schema validation: ${enrichedValidation.errors.join("; ")}`,
      rawMessage,
      enrichedValidation.errors,
    );
  }

  return dispatch(envelope, deps);
}
