// @akili-spec changes/cicd-executor-poc design §6.6, DD-19
// Ports the webhook core depends on. The core never performs I/O directly
// (no fs, no AWS SDK, no crypto randomness/clock reads) — every external
// effect or read is injected through one of these interfaces, so the core
// stays a pure function the unit tests can drive with fakes (design's
// "pure core function separated from the AWS adapter").

/**
 * Resolves the webhook signing secret (logical ref `<WEBHOOK_SECRET_REF>` —
 * the actual secret name/value is never in code; design §6.6).
 */
export interface SecretReader {
  getWebhookSecret(): Promise<string>;
}

/**
 * The subset of a pipeline definition the webhook mapping needs (design
 * §6.6 "Mapping": repository.url + branch + the github-push trigger).
 * `repositoryUrl` and `branch` are the YAML's literal string values,
 * verbatim — the committed YAML may carry a logical ref like
 * `<PRMS_REPORTING_REPO_URL>` (DD-23 publication policy) and this package's
 * `PipelineDefinitionReader` does not resolve it. Resolving logical `<…>`
 * refs to their real deployed values is a Gate B (T-30) concern: a decorator
 * wrapping `PipelineDefinitionReader` at deployment time, not something the
 * core (or this reader) does.
 */
export interface GithubPushPipelineDefinition {
  readonly pipelineId: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  /** PoC schema closes this to "dev" (schemas/pipeline.schema.json); carried through so the core never hardcodes it. */
  readonly environment: "dev";
}

/**
 * Minimal read interface for this package (DD-19-compatible in spirit: the
 * only path to pipeline definitions). It is NOT the Executor's
 * `DefinitionSource` port verbatim: that port only resolves a single
 * already-known `pipelineId` (`getPipelineDefinition(pipelineId)`), which
 * cannot answer "which definitions declare a github-push trigger for this
 * repo+branch" without already knowing every pipelineId up front. This
 * package therefore defines its own minimal reader with the one listing
 * capability the mapping in design §6.6 actually needs, keeping the same
 * "core never touches fs directly" discipline DD-19 establishes.
 */
export interface PipelineDefinitionReader {
  listGithubPushDefinitions(): Promise<readonly GithubPushPipelineDefinition[]>;
}

/**
 * design §6.1 event envelope, PIPELINE_REQUESTED shape only (schemas/event.schema.json).
 */
export interface PipelineRequestedEnvelope {
  readonly specVersion: 1;
  readonly eventId: string;
  readonly eventType: "PIPELINE_REQUESTED";
  readonly pipelineId: string;
  readonly environment: "dev";
  readonly requestId: string;
  readonly timestamp: string;
  readonly source: "ingress";
  readonly payload: {
    /** Omitted (not sent as `""`) when the push payload carried no `after` commit. */
    readonly after?: string;
    readonly triggeredBy: string;
  };
}

/** Publishes one envelope to the execution-request queue (the Executor's inbound queue). */
export interface QueuePublisher {
  publish(envelope: PipelineRequestedEnvelope): Promise<void>;
}

/**
 * Structured operational log sink (design §6.6: "WEBHOOK_UNMATCHED log",
 * "ignored and logged"). The core passes only plain, pre-selected fields
 * here — never the raw request body or headers wholesale — so NFR-02 ("no
 * secrets ... in logs") holds by construction: nothing the core logs can
 * carry the signing secret, the `X-Hub-Signature-256` header, or the raw
 * payload bytes.
 */
export interface Logger {
  log(entry: Readonly<Record<string, unknown>>): void;
}
