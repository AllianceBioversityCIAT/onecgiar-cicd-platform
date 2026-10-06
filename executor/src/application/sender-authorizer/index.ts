// @akili-spec changes/cicd-executor-poc design DD-25, §6.4, §7 (sender-authorizer row); requirements FR-21, RL-2
// Sender authorizer (DD-25). Authorization uses ONLY the AWS-provided SQS
// `SenderId` system attribute (`ROLEID:session`, P-A4) and the trusted role IDs
// resolved at startup (`resolvedAllowedSenders`, `resolvedPrincipals`).
//   - The role-ID prefix is matched against the principal class the event type
//     requires; the session-name suffix is caller-chosen, is NEVER compared and is
//     never returned (untrusted audit data only, per the owner statement).
//   - The message body (`source`, `ci.*`, ...) is never an input; the only body
//     value that reaches this module is the `deploymentId` lookup key.
//   - Fail-closed: missing/malformed SenderId, unknown or recreated role ID,
//     unknown deployment, empty configured ID -> not authorized.
import type { MessageEventType } from "../../domain/request-contract/index.js";
import type { ResolvedPrincipals } from "../definition-service/index.js";
import type { SenderAuthorizer } from "../message-router/index.js";

/** Principal class a message type must come from (design §6.4). */
export type PrincipalClass = "ci" | "executor" | "scheduler" | "operator";

const REQUIRED_CLASS: Readonly<Record<MessageEventType, PrincipalClass>> = {
  DEPLOY_REQUESTED: "ci",
  LOCK_RETRY_REQUESTED: "executor",
  RECONCILE_TICK: "scheduler",
  DEPLOY_WINDOW_OPEN_REQUESTED: "operator",
  DEPLOY_WINDOW_CLOSE_REQUESTED: "operator",
  TARGET_RESOLUTION_RECORDED: "operator",
};

export type DenyReason = "MISSING_SENDER_ID" | "MALFORMED_SENDER_ID" | "NOT_AUTHORIZED";

export interface AuthorizationRequest {
  readonly senderId: string | undefined;
  readonly eventType: MessageEventType;
  /** Unvalidated lookup key, only for DEPLOY_REQUESTED. */
  readonly deploymentId?: string;
}

export type AuthorizationDecision =
  | { readonly authorized: true; readonly senderRef: string }
  | { readonly authorized: false; readonly reason: DenyReason; /** Role-ID prefix when the SenderId parsed; audit only. */ readonly senderRef?: string };

export interface SenderAuthorizerConfig {
  /** deploymentId -> CI role ID (`resolvedAllowedSenders`). */
  readonly allowedSenders: Readonly<Record<string, string>>;
  readonly principals: ResolvedPrincipals;
}

/** Narrow metrics seam: the observability `Metrics` object satisfies it. */
export interface RejectedRequestMetrics {
  recordRejectedRequest(reason: "UNAUTHORIZED_SENDER"): void;
}

export interface SenderAuthorizerDeps extends SenderAuthorizerConfig {
  readonly metrics?: RejectedRequestMetrics;
}

const ROLE_ID = /^[A-Za-z0-9]+$/;

/** Splits `ROLEID:session`; the session part is discarded (never an authorization input). */
export function parseSenderId(senderId: string | undefined): { readonly roleId: string } | { readonly reason: DenyReason } {
  if (senderId === undefined || senderId === "") return { reason: "MISSING_SENDER_ID" };
  const idx = senderId.indexOf(":");
  if (idx <= 0 || idx === senderId.length - 1) return { reason: "MALFORMED_SENDER_ID" };
  const roleId = senderId.slice(0, idx);
  if (!ROLE_ID.test(roleId)) return { reason: "MALFORMED_SENDER_ID" };
  return { roleId };
}

function matches(configured: string | undefined, roleId: string): boolean {
  // roleId is non-empty by construction (parseSenderId), so an empty configured ID can never match.
  return configured === roleId;
}

export interface DecidingSenderAuthorizer extends SenderAuthorizer {
  /** Same rule as `authorize`, with audit data (`senderRef` = role-ID prefix) for the caller to record. */
  decide(request: AuthorizationRequest): AuthorizationDecision;
  authorize(request: AuthorizationRequest): Promise<boolean>;
}

export function createSenderAuthorizer(deps: SenderAuthorizerDeps): DecidingSenderAuthorizer {
  function evaluate(request: AuthorizationRequest): AuthorizationDecision {
    const parsed = parseSenderId(request.senderId);
    if ("reason" in parsed) return { authorized: false, reason: parsed.reason };
    const { roleId } = parsed;
    const required = REQUIRED_CLASS[request.eventType];
    let ok = false;
    if (required === "ci") {
      const id = request.deploymentId;
      ok =
        typeof id === "string" &&
        Object.prototype.hasOwnProperty.call(deps.allowedSenders, id) &&
        matches(deps.allowedSenders[id], roleId);
    } else if (required !== undefined) {
      ok = matches(deps.principals[required], roleId);
    }
    return ok ? { authorized: true, senderRef: roleId } : { authorized: false, reason: "NOT_AUTHORIZED", senderRef: roleId };
  }

  function decide(request: AuthorizationRequest): AuthorizationDecision {
    const decision = evaluate(request);
    if (!decision.authorized) deps.metrics?.recordRejectedRequest("UNAUTHORIZED_SENDER");
    return decision;
  }

  return {
    decide,
    authorize: (request) => Promise.resolve(decide(request).authorized),
  };
}
