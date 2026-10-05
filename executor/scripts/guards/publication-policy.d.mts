// @akili-spec changes/cicd-executor-poc design §4.1, DD-23; requirements NFR-02
// Hand-written ambient declarations for publication-policy.mjs — see
// dockerfile-boundary.d.mts for the pattern this mirrors.
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export declare function runPublicationPolicyGuard(repoRoot: string): Promise<readonly Violation[]>;
