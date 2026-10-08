// @akili-spec changes/cicd-executor-poc design DD-27 (implementation detail 1, V1), §5.1; tasks R-4 (AC-02 V1)
// The ONE place that builds the supersede-ordering `sourceRef` (DD-27). AC-02
// V1: the repository is verified per target before the request gets here (the
// IAM-enforced SenderId session = the record's `sourceRepositoryId`, option A);
// `order.sourceRef` records the request's `ci.repository` and `ci.workflowRef`
// (design §5.1), so two different caller workflows of one repository never
// have their `runNumber` values compared (a mismatch fails safe, V1-R2).
// `order.sourceRef` on EXEC# and the `sourceRef` of every TARGET# ordering value
// MUST come from this function; supersede-policy compares it by string equality.

/** Source of a request's ordering values (V1: repository + workflow, from the request's audit fields). */
export interface BoundSource {
  readonly repository: string;
  readonly workflow: string;
}

/**
 * Shape: `repository=<r>;workflow=<w>` with every part percent-encoded, so the
 * mapping is injective (a `;` or `=` inside a value cannot make two different
 * pairs collide). Opaque to every consumer.
 */
export function buildSourceRef(source: BoundSource): string {
  return `repository=${encodeURIComponent(source.repository)};workflow=${encodeURIComponent(source.workflow)}`;
}
