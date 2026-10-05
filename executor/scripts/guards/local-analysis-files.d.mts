// @akili-spec changes/cicd-executor-poc design §4.1
// Hand-written ambient declarations for local-analysis-files.mjs — see
// dockerfile-boundary.d.mts for the pattern this mirrors.
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export declare function runLocalAnalysisFilesGuard(repoRoot: string): Promise<readonly Violation[]>;
