// @akili-spec changes/cicd-executor-poc design §3.2, §5.3, §6.3; requirements FR-02; tasks R-3
// Port: the runtime Target Registry (AC-02 V1). Read-only by construction: the
// Executor resolves one target by its id and never writes the registry (design
// §11.2; writes come from the administrative onboarding principal). Storage-agnostic:
// no DynamoDB SDK types here — those belong to the `dynamodb-target-registry` adapter.

/** One validated target record (design §6.3). Non-secret values only; `credentialRef` is a reference, never the credential. */
export interface TargetRecord {
  readonly targetId: string;
  readonly project: string;
  readonly environment: string;
  readonly host: string;
  /** SSH port; absent means 22 (design §6.3). */
  readonly port?: number;
  readonly user: string;
  /** Pinned host key: one or more OpenSSH public-key lines. */
  readonly hostKey: readonly string[];
  readonly credentialRef: string;
  readonly deployScript: string;
  readonly deployWindowPolicy: "required" | "not-required";
  readonly sourceRepositoryId: string;
  readonly schemaVersion: 1;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * Outcome of a lookup. `missing` and `invalid` map to `TARGET_UNKNOWN` and
 * `TARGET_INVALID` (design §6.3); `problems` name the violated rules and paths,
 * never a stored value. A storage failure is not an outcome: it is thrown.
 */
export type TargetLookup =
  | { readonly kind: "found"; readonly target: TargetRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly problems: readonly string[] };

export interface TargetRegistry {
  getTarget(targetId: string): Promise<TargetLookup>;
}
