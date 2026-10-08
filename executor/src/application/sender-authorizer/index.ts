// @akili-spec changes/cicd-executor-poc design DD-24, DD-25, §6.4, §7 (sender-authorizer row); requirements FR-21, RL-2; tasks R-4 (AC-02 V1, option A)
// Sender authorizer (DD-25). Authorization uses ONLY the AWS-provided SQS
// `SenderId` system attribute (`ROLEID:session`, P-A4) and the trusted role IDs
// resolved at startup (`principals`).
//   - The role-ID prefix is matched against the principal class the event type
//     requires. The message body (`source`, `ci.*`, `targetId`, ...) is never an
//     input.
//   - DEPLOY_REQUESTED (AC-02 V1, option A): the sender must be the CI role shared
//     by the authorized repositories, and its session name must be a GitHub
//     `repository_id` (digits only). The CI role trust policy forces that session
//     name (`sts:RoleSessionName` = the token's `repository_id`, DD-24), so it is
//     not caller-controlled and is returned as `sourceRepositoryId` for the
//     router's per-target source check. Premises P-R1/P-R2 (that IAM enforces it)
//     are validated in B2; if the session is not a repository_id the request is
//     not authorized (fail closed).
//   - Every other type: the session name is caller-chosen, is NEVER compared and
//     is never returned (untrusted audit data only, owner statement).
//   - Fail-closed: missing/malformed SenderId, unknown or recreated role ID,
//     empty configured ID -> not authorized.
import type { MessageEventType } from "../../domain/request-contract/index.js";
import type { ResolvedPrincipals } from "../platform-config/index.js";
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

export type DenyReason = "MISSING_SENDER_ID" | "MALFORMED_SENDER_ID" | "NOT_AUTHORIZED" | "SESSION_NOT_REPOSITORY_ID";

export interface AuthorizationRequest {
  readonly senderId: string | undefined;
  readonly eventType: MessageEventType;
}

export type AuthorizationDecision =
  | {
      readonly authorized: true;
      readonly senderRef: string;
      /** DEPLOY_REQUESTED only: the IAM-enforced session name, the GitHub repository_id of the sender (option A). */
      readonly sourceRepositoryId?: string;
    }
  | { readonly authorized: false; readonly reason: DenyReason; /** Role-ID prefix when the SenderId parsed; audit only. */ readonly senderRef?: string };

export interface SenderAuthorizerConfig {
  /** Resolved role IDs of the platform principals, including the shared CI role (DD-25). */
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
/** A GitHub repository_id: the session name the CI role trust policy enforces (option A). */
const REPOSITORY_ID = /^[0-9]{1,20}$/;

/** Splits `ROLEID:session` at the first colon. */
export function parseSenderId(
  senderId: string | undefined,
): { readonly roleId: string; readonly session: string } | { readonly reason: DenyReason } {
  if (senderId === undefined || senderId === "") return { reason: "MISSING_SENDER_ID" };
  const idx = senderId.indexOf(":");
  if (idx <= 0 || idx === senderId.length - 1) return { reason: "MALFORMED_SENDER_ID" };
  const roleId = senderId.slice(0, idx);
  if (!ROLE_ID.test(roleId)) return { reason: "MALFORMED_SENDER_ID" };
  return { roleId, session: senderId.slice(idx + 1) };
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
    const { roleId, session } = parsed;
    const required = REQUIRED_CLASS[request.eventType];
    if (required === undefined || !matches(deps.principals[required], roleId)) {
      return { authorized: false, reason: "NOT_AUTHORIZED", senderRef: roleId };
    }
    if (required !== "ci") return { authorized: true, senderRef: roleId };
    if (!REPOSITORY_ID.test(session)) return { authorized: false, reason: "SESSION_NOT_REPOSITORY_ID", senderRef: roleId };
    return { authorized: true, senderRef: roleId, sourceRepositoryId: session };
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
