// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
// Hand-written ambient declarations for dockerfile-boundary.mjs, so
// test/unit/boundary-guards.test.ts can import it under strict TypeScript
// (NodeNext looks for a sibling *.d.mts for an *.mjs specifier) — mirrors
// scripts/inspect-image.d.mts's established pattern. The guard script
// itself stays plain JavaScript (no build step).
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export declare function runDockerfileBoundaryGuard(
  repoRoot: string,
  dockerfilePath?: string,
): Promise<readonly Violation[]>;
