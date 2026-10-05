// @akili-spec changes/cicd-executor-poc requirements NFR-08; design §4.2, §7, DD-19
// Hand-written ambient declarations for extensibility-fixture.mjs — see
// dockerfile-boundary.d.mts for the pattern this mirrors.
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface ExtensibilityFixtureGuardOverrides {
  readonly pipelineYamlPath?: string;
  readonly targetRegistryYamlPath?: string;
}

export declare function runExtensibilityFixtureGuard(
  repoRoot: string,
  overrides?: ExtensibilityFixtureGuardOverrides,
): Promise<readonly Violation[]>;
