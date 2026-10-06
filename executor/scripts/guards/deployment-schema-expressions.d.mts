// @akili-spec changes/cicd-executor-poc requirements FR-01, NFR-01; design DD-19
// Hand-written ambient declarations for deployment-schema-expressions.mjs —
// see dockerfile-boundary.d.mts for the pattern this mirrors.
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface DeploymentSchemaExpressionGuardOverrides {
  readonly schemaPath?: string;
  readonly yamlPath?: string;
  readonly schemaValidationTsPath?: string;
}

export declare function runDeploymentSchemaExpressionGuard(
  repoRoot: string,
  overrides?: DeploymentSchemaExpressionGuardOverrides,
): Promise<readonly Violation[]>;
