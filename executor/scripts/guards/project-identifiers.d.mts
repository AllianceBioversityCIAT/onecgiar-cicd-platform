// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
// Hand-written ambient declarations for project-identifiers.mjs — see
// dockerfile-boundary.d.mts for the pattern this mirrors.
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface DenylistEntry {
  readonly term: string;
  readonly mode?: "word" | "quoted";
  readonly citation: string;
}

export declare const DENYLIST: readonly DenylistEntry[];

export interface ScanForProjectIdentifiersOptions {
  readonly isCommentLine?: (line: string) => boolean;
  readonly fileFilter?: (absPath: string) => boolean;
}

export declare function scanForProjectIdentifiers(
  targetDir: string,
  denylist?: readonly DenylistEntry[],
  options?: ScanForProjectIdentifiersOptions,
): readonly Violation[];

export declare function runProjectIdentifiersGuard(repoRoot: string): Promise<readonly Violation[]>;
