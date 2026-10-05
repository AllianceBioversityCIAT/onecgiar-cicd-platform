// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
//
// Hand-written ambient declarations for inspect-image.mjs's exported pure
// functions, so test/unit/inspect-image.test.ts can import them under
// strict TypeScript (NodeNext module resolution looks for a sibling
// `*.d.mts` file for an `*.mjs` specifier). The script itself stays plain
// JavaScript (no build step) per its own "no dependencies beyond Node's
// standard library" design; this file is the only TypeScript-facing
// artifact and is not emitted/compiled.

export declare const FORBIDDEN_NAMES: readonly string[];
export declare const PRUNE_PATHS: readonly string[];

export declare function buildInContainerScript(): string;

export declare function buildSweepRunArgs(tag: string, script: string): readonly string[];

export interface InspectionVerdict {
  readonly status: "PASS" | "FAIL";
  readonly reasons: readonly string[];
}

export declare function parseInspectionOutput(result: {
  readonly stdout: string | null | undefined;
  readonly exitCode: number | null | undefined;
}): InspectionVerdict;

export interface VolumesVerdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export declare function evaluateVolumes(
  volumes: Readonly<Record<string, unknown>> | null | undefined,
): VolumesVerdict;

export interface UserVerdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export declare function evaluateUser(configUser: string | null | undefined): UserVerdict;

export declare function describeDockerUnavailable(result: {
  readonly error?: { readonly code?: string; readonly message: string } | undefined;
  readonly status?: number | null | undefined;
  readonly stderr?: string | null | undefined;
}): string;
