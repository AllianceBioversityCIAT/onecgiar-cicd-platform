// @akili-spec changes/cicd-executor-poc design §6.6; requirements FR-20, FR-03
// Pure core: decides what the GitHub webhook contract requires given an
// already-extracted raw body + headers. No AWS SDK, no fs — every effect
// (secret lookup, definition listing, enqueueing, clock, id generation) is
// injected, so this function is driven entirely by fakes in unit tests
// (AWS adapter wiring lives in ../adapters/).
import { verifySignature as defaultVerifySignature } from "./verify-signature.js";
import type {
  GithubPushPipelineDefinition,
  Logger,
  PipelineDefinitionReader,
  PipelineRequestedEnvelope,
  QueuePublisher,
  SecretReader,
} from "./ports.js";

export interface WebhookRequest {
  /** Exact bytes GitHub signed — never a re-encoded/re-serialized string (design §6.6: "HMAC-SHA256 of the raw body"). */
  readonly rawBody: Buffer;
  /** Header lookup is case-insensitive (HTTP headers are case-insensitive; Function URLs may lower-case them). */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type WebhookOutcomeReason =
  | "PING"
  | "EVENT_IGNORED"
  | "BRANCH_DELETED"
  | "WEBHOOK_UNMATCHED"
  | "ENQUEUED"
  | "INVALID_SIGNATURE"
  | "MALFORMED_PAYLOAD"
  | "MISSING_DELIVERY_ID";

export interface WebhookResult {
  readonly statusCode: 200 | 202 | 401;
  readonly reason: WebhookOutcomeReason;
  readonly body: string;
}

export interface HandleWebhookDeps {
  readonly secretReader: SecretReader;
  readonly definitionReader: PipelineDefinitionReader;
  readonly queuePublisher: QueuePublisher;
  /** Structured operational log sink (design §6.6; NFR-02: never given the secret, the signature header, or the raw body). */
  readonly logger: Logger;
  /** Injected so the core never reads the wall clock itself (mirrors executor/src/domain's purity bar). */
  readonly clock: () => Date;
  /** Injected so the core never generates randomness itself. */
  readonly newEventId: () => string;
  /** Test-only seam; defaults to the real constant-time verifier (node:crypto's timingSafeEqual). */
  readonly verifySignature?: typeof defaultVerifySignature;
}

function getHeader(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function jsonBody(reason: WebhookOutcomeReason, extra?: Record<string, unknown>): string {
  return JSON.stringify({ reason, ...extra });
}

const BRANCH_REF_PREFIX = "refs/heads/";

function extractBranch(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(BRANCH_REF_PREFIX)) return undefined;
  const branch = ref.slice(BRANCH_REF_PREFIX.length);
  return branch.length > 0 ? branch : undefined;
}

/**
 * Candidate repo-identity strings from a GitHub push payload's `repository`
 * object. design §6.6 only says "repository.url" matches the pipeline
 * definition's `repository.url` without naming the exact GitHub payload
 * field, so every URL-shaped field GitHub sends is accepted as a match
 * target (ASSUMPTION — see this task's completion report).
 */
function collectRepositoryUrlCandidates(repository: unknown): readonly string[] {
  if (repository === null || typeof repository !== "object") return [];
  const r = repository as Record<string, unknown>;
  const candidates = [r.html_url, r.clone_url, r.ssh_url, r.url, r.git_url];
  return candidates.filter((c): c is string => typeof c === "string" && c.length > 0);
}

function buildRequestId(deliveryId: string, pipelineId: string): string {
  return `${deliveryId}:${pipelineId}`;
}

function buildEnvelope(
  definition: GithubPushPipelineDefinition,
  deliveryId: string,
  after: string | undefined,
  triggeredBy: string,
  deps: Pick<HandleWebhookDeps, "clock" | "newEventId">,
): PipelineRequestedEnvelope {
  return {
    specVersion: 1,
    eventId: deps.newEventId(),
    eventType: "PIPELINE_REQUESTED",
    pipelineId: definition.pipelineId,
    environment: definition.environment,
    requestId: buildRequestId(deliveryId, definition.pipelineId),
    timestamp: deps.clock().toISOString(),
    source: "ingress",
    payload: after === undefined ? { triggeredBy } : { after, triggeredBy },
  };
}

/**
 * design §6.6 contract, in order:
 *  1. Missing/invalid X-Hub-Signature-256 -> 401, nothing enqueued.
 *  2. `ping` -> 200, no effect.
 *  3. Any event other than `push` (and not `ping`) -> 202, ignored + logged.
 *  4. `push` with `deleted: true` -> 202, ignored.
 *  5. `push` to a branch with no matching github-push definition (repo+branch) -> 202, WEBHOOK_UNMATCHED, nothing enqueued.
 *  6. `push` matching one or more definitions -> one PIPELINE_REQUESTED per match, then 202.
 */
export async function handleGithubWebhook(request: WebhookRequest, deps: HandleWebhookDeps): Promise<WebhookResult> {
  const secret = await deps.secretReader.getWebhookSecret();
  const signatureHeader = getHeader(request.headers, "x-hub-signature-256");
  const verify = deps.verifySignature ?? defaultVerifySignature;

  if (!verify(request.rawBody, signatureHeader, secret)) {
    return { statusCode: 401, reason: "INVALID_SIGNATURE", body: jsonBody("INVALID_SIGNATURE") };
  }

  const githubEvent = getHeader(request.headers, "x-github-event")?.toLowerCase();

  if (githubEvent === "ping") {
    return { statusCode: 200, reason: "PING", body: jsonBody("PING") };
  }

  // Read once, up front, purely for the structured log entries below — GitHub
  // always sets this header, so it is the natural log correlation key even
  // before the MISSING_DELIVERY_ID check later confirms its presence.
  const deliveryIdHeader = getHeader(request.headers, "x-github-delivery");

  if (githubEvent !== "push") {
    deps.logger.log({ event: "EVENT_IGNORED", deliveryId: deliveryIdHeader, githubEvent });
    return { statusCode: 202, reason: "EVENT_IGNORED", body: jsonBody("EVENT_IGNORED", { githubEvent }) };
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(request.rawBody.toString("utf8"));
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    // Never logs the raw body: a malformed body already failed to parse, so
    // only the delivery id (never payload contents) is logged (NFR-02).
    deps.logger.log({ event: "MALFORMED_PAYLOAD", deliveryId: deliveryIdHeader });
    return { statusCode: 202, reason: "MALFORMED_PAYLOAD", body: jsonBody("MALFORMED_PAYLOAD") };
  }

  if (payload.deleted === true) {
    return { statusCode: 202, reason: "BRANCH_DELETED", body: jsonBody("BRANCH_DELETED") };
  }

  const deliveryId = deliveryIdHeader;
  if (!deliveryId) {
    // GitHub always sets this header; its absence means the request did not
    // actually come through GitHub's delivery path. Nothing can be safely
    // deduped/enqueued without it (design §6.6 requestId = delivery id + pipelineId).
    // Logs only the (already-ignored-or-not) event name, never payload contents (NFR-02).
    deps.logger.log({ event: "MISSING_DELIVERY_ID", githubEvent });
    return { statusCode: 202, reason: "MISSING_DELIVERY_ID", body: jsonBody("MISSING_DELIVERY_ID") };
  }

  const branch = extractBranch(payload.ref);
  const repoCandidates = collectRepositoryUrlCandidates(payload.repository);

  const definitions = await deps.definitionReader.listGithubPushDefinitions();
  const matches =
    branch === undefined
      ? []
      : definitions.filter((d) => d.branch === branch && repoCandidates.includes(d.repositoryUrl));

  if (matches.length === 0) {
    deps.logger.log({ event: "WEBHOOK_UNMATCHED", deliveryId, repositoryCandidates: repoCandidates, branch });
    return { statusCode: 202, reason: "WEBHOOK_UNMATCHED", body: jsonBody("WEBHOOK_UNMATCHED") };
  }

  const after = typeof payload.after === "string" ? payload.after : undefined;
  const pusher = payload.pusher;
  const triggeredBy =
    pusher !== null && typeof pusher === "object" && typeof (pusher as Record<string, unknown>).name === "string"
      ? ((pusher as Record<string, unknown>).name as string)
      : "";

  for (const definition of matches) {
    const envelope = buildEnvelope(definition, deliveryId, after, triggeredBy, deps);
    await deps.queuePublisher.publish(envelope);
  }

  return {
    statusCode: 202,
    reason: "ENQUEUED",
    body: jsonBody("ENQUEUED", { pipelineIds: matches.map((m) => m.pipelineId) }),
  };
}
