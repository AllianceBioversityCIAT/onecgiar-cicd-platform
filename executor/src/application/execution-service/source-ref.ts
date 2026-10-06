// @akili-spec changes/cicd-executor-poc design DD-27 (implementation detail 1), §5.1
// The ONE place that builds the supersede-ordering `sourceRef` (DD-27): the
// logical identity of a deployment's bound source = repository + workflow +
// environment, as resolved from the definition (never from the request body).
// `order.sourceRef` on EXEC# and the `sourceRef` of every TARGET# ordering
// value (`highestAccepted`, `highestDispatched`, `lastDeployed`) MUST come from
// this function, so two values compare as the same source iff the resolved
// triple is identical (supersede-policy compares `sourceRef` by string equality
// and never compares `runNumber` across sources).

/** Resolved bound source of a deployment (definition-service `ResolvedSource`, DD-27). */
export interface BoundSource {
  readonly repository: string;
  readonly workflow: string;
  readonly environment: string;
}

/**
 * Shape: `repository=<r>;workflow=<w>;environment=<e>` with every part
 * percent-encoded, so the mapping is injective (a `;` or `=` inside a value
 * cannot make two different triples collide). Opaque to every consumer.
 */
export function buildSourceRef(source: BoundSource): string {
  return (
    `repository=${encodeURIComponent(source.repository)}` +
    `;workflow=${encodeURIComponent(source.workflow)}` +
    `;environment=${encodeURIComponent(source.environment)}`
  );
}
