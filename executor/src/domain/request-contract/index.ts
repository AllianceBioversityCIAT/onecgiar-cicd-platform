// @akili-spec changes/cicd-executor-poc design §6.1, §6.4, §7 (message-router row); requirements FR-03, FR-04, RL-3
// Domain side of the message contract (Model B, AC-01). Pure: no I/O, no
// clock, no randomness, no ajv. It owns the types of DEPLOY_REQUESTED and of
// the internal events, the 8 KB body limit, message parsing into the
// "unparseable" vs "parseable" classes (RL-3), and the pure cross-field checks
// JSON Schema cannot express (requestId == `${ci.runId}-${ci.runAttempt}`,
// CC-2; consistency of `ci.repository`/`ci.workflowRef` with the resolved
// source). Schema validation itself runs in application/message-router
// against schemas/deploy-request.schema.json and schemas/event.schema.json
// (reuse the schemas, never duplicate their rules).
//
// This module never authorizes anything: no field of the body (including the
// `source` envelope field and `ci.*`) is an authorization input (DD-25).

/** Maximum accepted message body, in bytes (design §6.1: 8 KB). */
export const MAX_BODY_BYTES = 8 * 1024;

export const DEPLOY_REQUESTED = "DEPLOY_REQUESTED" as const;

export const INTERNAL_EVENT_TYPES = [
  "LOCK_RETRY_REQUESTED",
  "RECONCILE_TICK",
  "DEPLOY_WINDOW_OPEN_REQUESTED",
  "DEPLOY_WINDOW_CLOSE_REQUESTED",
  "TARGET_RESOLUTION_RECORDED",
] as const;
export type InternalEventType = (typeof INTERNAL_EVENT_TYPES)[number];

export const MESSAGE_EVENT_TYPES = [DEPLOY_REQUESTED, ...INTERNAL_EVENT_TYPES] as const;
export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number];

export function isMessageEventType(value: unknown): value is MessageEventType {
  return typeof value === "string" && (MESSAGE_EVENT_TYPES as readonly string[]).includes(value);
}

export function isInternalEventType(value: MessageEventType): value is InternalEventType {
  return value !== DEPLOY_REQUESTED;
}

/** `DEPLOY_REQUESTED` after schema validation (design §6.1). */
export interface DeployRequest {
  readonly specVersion: 1;
  readonly eventType: typeof DEPLOY_REQUESTED;
  readonly requestId: string;
  readonly deploymentId: string;
  readonly commitSha: string;
  /** Artifact unit -> `sha256:<64 hex>` digest. */
  readonly artifacts: Readonly<Record<string, string>>;
  /** Audit-only (DD-25): never an authorization input; `runNumber` is the DD-27 ordering input. */
  readonly ci: {
    readonly repository: string;
    readonly workflowRef: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly runNumber: number;
  };
}

interface InternalEventEnvelope {
  readonly specVersion: 1;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface LockRetryRequestedEvent extends InternalEventEnvelope {
  readonly eventType: "LOCK_RETRY_REQUESTED";
  readonly source: "executor";
  readonly executionId: string;
  readonly attempt: number;
}

export interface ReconcileTickEvent extends InternalEventEnvelope {
  readonly eventType: "RECONCILE_TICK";
  readonly source: "scheduler";
}

export interface DeployWindowOpenRequestedEvent extends InternalEventEnvelope {
  readonly eventType: "DEPLOY_WINDOW_OPEN_REQUESTED";
  readonly source: "operator";
  readonly lockKey: string;
  readonly openedBy: string;
  readonly externalJobsDisabled: readonly string[];
  readonly closesAt: string;
  readonly note?: string;
}

export interface DeployWindowCloseRequestedEvent extends InternalEventEnvelope {
  readonly eventType: "DEPLOY_WINDOW_CLOSE_REQUESTED";
  readonly source: "operator";
  readonly lockKey: string;
  readonly closedBy: string;
  readonly note?: string;
}

export interface TargetResolutionRecordedEvent extends InternalEventEnvelope {
  readonly eventType: "TARGET_RESOLUTION_RECORDED";
  readonly source: "operator";
  readonly lockKey: string;
  readonly executionId: string;
  readonly resolvedBy: string;
  readonly observedDigests: Readonly<Record<string, string>>;
  readonly note?: string;
}

export type InternalEvent =
  | LockRetryRequestedEvent
  | ReconcileTickEvent
  | DeployWindowOpenRequestedEvent
  | DeployWindowCloseRequestedEvent
  | TargetResolutionRecordedEvent;

// ---------------------------------------------------------------------------
// Parsing (RL-3): unparseable -> left for the DLQ; parseable -> routed.
// ---------------------------------------------------------------------------

export type UnparseableReason = "BODY_TOO_LARGE" | "NOT_JSON" | "NOT_AN_OBJECT";

export type ParsedMessage =
  | { readonly parseable: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly parseable: false; readonly reason: UnparseableReason };

/**
 * Splits a raw body into "unparseable" (not valid JSON, not a JSON object, or
 * larger than 8 KB measured in UTF-8 bytes) and "parseable". The size check
 * runs BEFORE `JSON.parse`, so an oversized body is never parsed. Never
 * throws.
 */
export function parseMessageBody(body: string): ParsedMessage {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return { parseable: false, reason: "BODY_TOO_LARGE" };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { parseable: false, reason: "NOT_JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { parseable: false, reason: "NOT_AN_OBJECT" };
  }
  return { parseable: true, value: value as Readonly<Record<string, unknown>> };
}

// ---------------------------------------------------------------------------
// Cross-field checks for a schema-valid DEPLOY_REQUESTED.
// ---------------------------------------------------------------------------

/** CC-2: `requestId` must equal `${ci.runId}-${ci.runAttempt}` (mismatch -> X2 REQUEST_ID_MISMATCH). */
export function requestIdMatches(request: Pick<DeployRequest, "requestId" | "ci">): boolean {
  return request.requestId === `${request.ci.runId}-${request.ci.runAttempt}`;
}

/** The bound source of a deployment as resolved from its definition (DD-27; logical refs already resolved). */
export interface ResolvedSource {
  readonly repository: string;
  readonly workflowRef: string;
}

/**
 * Consistency check only (audit fields never authorize, DD-25): the request's
 * `ci.repository` and `ci.workflowRef` must equal the definition's resolved
 * source, by exact string equality (fail closed).
 */
export function consistentWithSource(request: Pick<DeployRequest, "ci">, source: ResolvedSource): boolean {
  return request.ci.repository === source.repository && request.ci.workflowRef === source.workflowRef;
}
