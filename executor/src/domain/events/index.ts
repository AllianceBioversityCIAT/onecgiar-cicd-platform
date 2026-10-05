// @akili-spec changes/cicd-executor-poc design §6.1, §6.2, §6.3; requirements FR-04, FR-09, FR-10
// Event envelope types and pure normalizers (design §6.1 "Normalization on
// receipt"). Pure, no I/O: no Date.now(), no randomness, no port calls —
// every id/timestamp a normalizer needs comes from the native AWS record
// itself (Lambda's own requestId/timestamp, EventBridge's own id/time), never
// generated here. This mirrors the state-machine's domain-purity boundary
// (design §3.2): application/event-router owns the impure parts (schema I/O
// via DefinitionSource, the StateStore-backed attempt lookup, logging,
// metrics) and calls into this module only for shape recognition and
// field-mapping decisions.
//
// What this module does NOT do: it does not validate an envelope against
// schemas/event.schema.json (design says "reuse it, do not duplicate the
// rules" — that validation runs once, via ajv, in
// application/event-router/schema-validation.ts) and it does not decide
// ORPHAN_EVENT (that needs the current attempt's state, which lives in
// StateStore — application/event-router's job, design §6.1 "Orphan
// events").
import type { DomainErrorCode } from "../errors/index.js";

// ---------------------------------------------------------------------------
// Envelope shape (design §6.1 table), transcribed as TypeScript types for
// ergonomics only. The closed vocabularies (eventType, source) are repeated
// here only because they are useful at the type level for the normalizers in
// this file and for event-router's handler map; the actual VALIDATION rules
// (which fields are required per eventType, format checks, etc.) live solely
// in schemas/event.schema.json and are enforced by ajv against that file, not
// by this type.
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "PIPELINE_REQUESTED",
  "QUALITY_COMPLETED",
  "QUALITY_FAILED",
  "QUALITY_TIMED_OUT",
  "BUILD_COMPLETED",
  "BUILD_FAILED",
  "BUILD_TIMED_OUT",
  "DEPLOYMENT_COMPLETED",
  "DEPLOYMENT_FAILED",
  "PIPELINE_COMPLETED",
  "PIPELINE_FAILED",
  "STEP_RETRY_REQUESTED",
  "LOCK_RETRY_REQUESTED",
  "RECONCILE_TICK",
  "DEPLOY_WINDOW_OPEN_REQUESTED",
  "DEPLOY_WINDOW_CLOSE_REQUESTED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SOURCES = ["executor", "lambda", "codebuild", "ingress", "scheduler", "operator"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** design §6.1 field table. Optional fields are optional here; schema-level "required per eventType" is ajv's job. */
export interface EventEnvelope {
  readonly specVersion: 1;
  readonly eventId: string;
  readonly eventType: EventType;
  readonly executionId?: string;
  readonly pipelineId?: string;
  readonly environment?: "dev";
  readonly lockKey?: string;
  readonly stepId?: string;
  readonly status?: string;
  readonly attempt?: number;
  readonly timestamp: string;
  readonly source: EventSource;
  readonly payload?: Record<string, unknown>;
  readonly requestId?: string;
  readonly openedBy?: string;
  readonly externalJobsDisabled?: readonly string[];
}

/**
 * Thrown for a message that is neither a valid envelope nor a recognizable
 * AWS-native shape, or whose recognized shape is missing a field this module
 * needs to normalize it (e.g. a CodeBuild event without an EXECUTION_ID
 * override). The consumer (T-18) MUST treat this as NOT acknowledged (poison
 * path to the DLQ, FR-04 "poisoned message") — never caught and swallowed
 * here or in event-router.
 */
export class MalformedEventError extends Error {
  readonly rawMessage: unknown;
  /**
   * Ajv's own `instancePath` + `message` pairs for a schema-validation
   * failure, when that is the cause (`undefined` for a shape-recognition
   * failure, which never reached ajv). Safe for DLQ triage: ajv is never run
   * with `verbose`, so `err.data` — the actual instance value — is never
   * populated here, only paths and messages, never payload values.
   */
  readonly schemaErrors?: readonly string[];
  constructor(message: string, rawMessage: unknown, schemaErrors?: readonly string[]) {
    super(message);
    this.name = "MalformedEventError";
    this.rawMessage = rawMessage;
    this.schemaErrors = schemaErrors;
  }
}

/**
 * Output of a normalizer: everything derivable PURELY from the native AWS
 * record. Deliberately missing `pipelineId`, `environment` and `attempt` —
 * design §6.1's envelope table requires them, but they are not present on
 * either native AWS shape; they can only come from the step's persisted
 * state (StateStore), which is an application-layer, I/O-bound lookup
 * (event-router's job, same lookup that performs the orphan check below).
 * `externalId` is the normalizer's own correlation key (design §6.1
 * "Correlation" column) that event-router compares against the current
 * attempt's `externalRef` to detect a stale/superseded result.
 */
export interface NormalizedEventDraft {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly executionId: string;
  readonly stepId: string;
  readonly status: string;
  readonly timestamp: string;
  readonly source: EventSource;
  /** Correlation id for the orphan check (design §6.1): `dispatchToken` for Lambda, `build-id` for CodeBuild. */
  readonly externalId: string;
  readonly payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lambda Destinations (design §6.1 row 1; §6.2 worker contract; FR-09)
// ---------------------------------------------------------------------------

/** design §6.2 "Input (Executor → worker)" — the subset this module needs back for correlation. */
export interface LambdaWorkerRequestPayload {
  readonly executionId: string;
  readonly stepId: string;
  readonly dispatchToken: string;
  readonly [key: string]: unknown;
}

/**
 * design §6.2 "Output (worker → Destinations)": `status, failedCommand,
 * exitCode, error, logS3Uri, logUrl` (P-1, UNVERIFIED). `status` is assumed
 * to be the literal string `"PASSED"` on success per this task's brief;
 * anything else is a business failure (FR-09's "failing status" row). This
 * assumption is PROVISIONAL (P-1) and must be confirmed at the worker's
 * actual source before T-27 relies on it.
 */
export interface LambdaWorkerSuccessPayload {
  readonly status: string;
  readonly failedCommand?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly logS3Uri?: string;
  readonly logUrl?: string;
}

/** Lambda's own unhandled-error response shape (not the worker's contract — the platform's). */
export interface LambdaInvocationErrorPayload {
  readonly errorMessage?: string;
  readonly errorType?: string;
  readonly trace?: readonly string[];
}

/**
 * design §6.1 row 1: "destination record shape (`requestContext`,
 * `requestPayload`, `responsePayload`)". Matches the AWS Lambda
 * Destinations-on-SQS message format (async invoke, `MaximumRetryAttempts=0`
 * per design §6.2 — so a failing invocation reaches `RetriesExhausted`
 * without an actual retry).
 */
export interface LambdaDestinationsRecord {
  readonly timestamp: string;
  readonly requestContext: {
    readonly requestId: string;
    readonly functionArn: string;
    readonly condition: string;
    readonly approximateInvokeCount?: number;
  };
  readonly requestPayload: LambdaWorkerRequestPayload;
  readonly responseContext?: {
    readonly statusCode?: number;
    readonly executedVersion?: string;
    readonly functionError?: string;
  };
  readonly responsePayload?: LambdaWorkerSuccessPayload | LambdaInvocationErrorPayload;
}

export function isLambdaDestinationsRecord(value: unknown): value is LambdaDestinationsRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.timestamp !== "string") return false;
  const requestContext = record.requestContext;
  if (requestContext === null || typeof requestContext !== "object") return false;
  const rc = requestContext as Record<string, unknown>;
  if (typeof rc.requestId !== "string" || typeof rc.condition !== "string") return false;
  const requestPayload = record.requestPayload;
  if (requestPayload === null || typeof requestPayload !== "object") return false;
  const rp = requestPayload as Record<string, unknown>;
  return typeof rp.executionId === "string" && typeof rp.stepId === "string" && typeof rp.dispatchToken === "string";
}

/**
 * PROVISIONAL heuristic (P-1, P-17 UNVERIFIED): distinguishes a Lambda
 * function timeout from any other unhandled function error within a
 * non-`Success` Destinations record, since AWS does not expose a distinct
 * `requestContext.condition` value for "timed out" (only `Success`,
 * `RetriesExhausted`, `EventAgeExceeded`). AWS Lambda's own timeout error
 * carries `errorType: "Sandbox.Timeout"` and an `errorMessage` containing
 * "Task timed out" — this is documented Lambda runtime behavior (not a
 * CICD-specific invention), but must still be confirmed against the real
 * worker at T-27 before being relied upon in production.
 */
function isLambdaTimeoutError(payload: LambdaInvocationErrorPayload): boolean {
  if (payload.errorType === "Sandbox.Timeout") return true;
  return typeof payload.errorMessage === "string" && /task timed out/i.test(payload.errorMessage);
}

/**
 * design §6.1 row 1 + §6.2 + FR-09's classification table:
 *   - `condition: "Success"` and worker `status === "PASSED"` -> QUALITY_COMPLETED
 *   - `condition: "Success"` and any other worker `status`      -> QUALITY_FAILED (business, no retry)
 *   - non-`Success` condition, timeout heuristic                -> QUALITY_TIMED_OUT
 *   - non-`Success` condition, otherwise                        -> QUALITY_FAILED, failureCode INFRA (FR-09: 1 re-dispatch)
 *
 * Correlation (design §6.1): `requestPayload.executionId` + `stepId` +
 * `dispatchToken` — `externalId` on the returned draft is `dispatchToken`.
 */
export function normalizeLambdaDestinationsRecord(record: LambdaDestinationsRecord): NormalizedEventDraft {
  const { executionId, stepId, dispatchToken } = record.requestPayload;

  if (record.requestContext.condition === "Success") {
    const success = record.responsePayload as LambdaWorkerSuccessPayload | undefined;
    if (success === undefined || typeof success.status !== "string") {
      throw new MalformedEventError(
        "Lambda Destinations record has condition=Success but no usable responsePayload.status (design §6.2)",
        record,
      );
    }
    const payload: Record<string, unknown> = {};
    if (success.failedCommand !== undefined) payload.failedCommand = success.failedCommand;
    if (success.exitCode !== undefined) payload.exitCode = success.exitCode;
    if (success.error !== undefined) payload.error = success.error;
    if (success.logS3Uri !== undefined) payload.logS3Uri = success.logS3Uri;
    if (success.logUrl !== undefined) payload.logUrl = success.logUrl;

    const isPassed = success.status === "PASSED";
    if (!isPassed) payload.failureCode = "QUALITY" satisfies DomainErrorCode;

    return {
      eventId: record.requestContext.requestId,
      eventType: isPassed ? "QUALITY_COMPLETED" : "QUALITY_FAILED",
      executionId,
      stepId,
      status: success.status,
      timestamp: record.timestamp,
      source: "lambda",
      externalId: dispatchToken,
      payload: Object.keys(payload).length > 0 ? payload : undefined,
    };
  }

  // Non-Success condition: the function never produced its own output —
  // this is the platform's (Lambda's) own error shape, not the worker's.
  const errorPayload = (record.responsePayload ?? {}) as LambdaInvocationErrorPayload;
  const timedOut = isLambdaTimeoutError(errorPayload);
  const payload: Record<string, unknown> = {};
  if (errorPayload.errorMessage !== undefined) payload.error = errorPayload.errorMessage;
  if (errorPayload.errorType !== undefined) payload.errorType = errorPayload.errorType;
  if (!timedOut) payload.failureCode = "INFRA" satisfies DomainErrorCode;

  return {
    eventId: record.requestContext.requestId,
    eventType: timedOut ? "QUALITY_TIMED_OUT" : "QUALITY_FAILED",
    executionId,
    stepId,
    status: timedOut ? "TIMED_OUT" : "FAILED",
    timestamp: record.timestamp,
    source: "lambda",
    externalId: dispatchToken,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
  };
}

// ---------------------------------------------------------------------------
// EventBridge "CodeBuild Build State Change" (design §6.1 row 2; §6.3; FR-10)
// ---------------------------------------------------------------------------

export interface CodeBuildEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
}

/**
 * design §6.1 row 2: recognized by `detail-type = "CodeBuild Build State
 * Change"`. design §6.3 "Overrides" puts `EXECUTION_ID` and `STEP_ID` on the
 * build's environment variables — the same overrides CodeBuild echoes back
 * on `detail.additional-information.environment.environment-variables` — so
 * this is also how the normalizer recovers the fields the envelope needs
 * that the native CodeBuild event does not otherwise carry.
 */
export interface CodeBuildStateChangeEvent {
  readonly id: string;
  readonly "detail-type": string;
  readonly time: string;
  readonly detail: {
    readonly "build-status": string;
    readonly "project-name": string;
    readonly "build-id": string;
    readonly "additional-information"?: {
      readonly environment?: {
        readonly "environment-variables"?: readonly CodeBuildEnvironmentVariable[];
      };
      readonly "exported-environment-variables"?: readonly CodeBuildEnvironmentVariable[];
    };
  };
}

export function isCodeBuildStateChangeEvent(value: unknown): value is CodeBuildStateChangeEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (event["detail-type"] !== "CodeBuild Build State Change") return false;
  if (typeof event.id !== "string" || typeof event.time !== "string") return false;
  const detail = event.detail;
  if (detail === null || typeof detail !== "object") return false;
  const d = detail as Record<string, unknown>;
  return typeof d["build-status"] === "string" && typeof d["build-id"] === "string";
}

const BUILD_EVENT_TYPE_BY_STATUS: Readonly<Record<string, EventType>> = {
  SUCCEEDED: "BUILD_COMPLETED",
  FAILED: "BUILD_FAILED",
  // design §7.2 row "Build FAILED/STOPPED" -> classification BUILD, same as FAILED.
  STOPPED: "BUILD_FAILED",
  TIMED_OUT: "BUILD_TIMED_OUT",
};

function findEnvVar(
  vars: readonly CodeBuildEnvironmentVariable[] | undefined,
  name: string,
): string | undefined {
  return vars?.find((v) => v.name === name)?.value;
}

/**
 * design §6.1 row 2 + §6.3 + §7.2: maps a finished build's `build-status` to
 * its envelope eventType (SUCCEEDED/FAILED/STOPPED/TIMED_OUT only — any other
 * status, e.g. IN_PROGRESS, is not a finalization event and is treated as
 * malformed here, since the EventBridge rule filtering this queue is
 * supposed to only forward finished builds, design §6.3 "Finalization").
 * Correlation (design §6.1): `buildId == externalRef` — `externalId` on the
 * returned draft is `detail["build-id"]`.
 */
export function normalizeCodeBuildStateChangeEvent(event: CodeBuildStateChangeEvent): NormalizedEventDraft {
  const eventType = BUILD_EVENT_TYPE_BY_STATUS[event.detail["build-status"]];
  if (eventType === undefined) {
    throw new MalformedEventError(
      `CodeBuild state-change event has a non-terminal or unrecognized build-status: "${event.detail["build-status"]}"`,
      event,
    );
  }

  const envVars = event.detail["additional-information"]?.environment?.["environment-variables"];
  const executionId = findEnvVar(envVars, "EXECUTION_ID");
  const stepId = findEnvVar(envVars, "STEP_ID");
  if (executionId === undefined || stepId === undefined) {
    throw new MalformedEventError(
      "CodeBuild state-change event is missing EXECUTION_ID/STEP_ID among its environment-variables overrides (design §6.3)",
      event,
    );
  }

  const payload: Record<string, unknown> = {};
  if (eventType === "BUILD_COMPLETED") {
    const exported = event.detail["additional-information"]?.["exported-environment-variables"];
    const imageUri = findEnvVar(exported, "imageUri");
    const digest = findEnvVar(exported, "digest");
    if (imageUri !== undefined) payload.imageUri = imageUri;
    if (digest !== undefined) payload.digest = digest;
  } else if (eventType === "BUILD_FAILED") {
    payload.failureCode = "BUILD" satisfies DomainErrorCode;
  }

  return {
    eventId: event.id,
    eventType,
    executionId,
    stepId,
    status: event.detail["build-status"],
    timestamp: event.time,
    source: "codebuild",
    externalId: event.detail["build-id"],
    payload: Object.keys(payload).length > 0 ? payload : undefined,
  };
}
