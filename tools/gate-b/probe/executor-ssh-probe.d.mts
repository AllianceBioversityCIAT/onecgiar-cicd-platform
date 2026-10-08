// @akili-spec changes/cicd-executor-poc gate-b-plan K-7; tasks R-5 (AC-02 V1)
// Hand-written declarations so tests can import the plain-JS owner tool under strict TypeScript.
export interface ProbeOptions {
  readonly targetId: string;
  readonly probeScript: string;
  readonly dryRun: boolean;
  readonly timeoutSeconds: number;
  readonly secretIdPrefix?: string;
  readonly region?: string;
  readonly registryTable?: string;
}
export interface ProbeSink {
  write(text: string): unknown;
}
export interface ProbeTargetRegistry {
  getTarget(targetId: string): Promise<unknown>;
}
export interface ProbeExecutor {
  Ssh2DeployTransport: new (options: unknown) => { connect(target: unknown): Promise<unknown> };
  SecretsManagerSecretProvider: new (deps: unknown) => unknown;
  createSecretsManagerClient(region: string): unknown;
  DynamoDbTargetRegistry: new (options: unknown) => ProbeTargetRegistry;
  createDocumentClient(config: { tableName: string; region: string }): unknown;
  redactString?(text: string): string;
}
export interface ProbeDeps {
  stdout?: ProbeSink;
  stderr?: ProbeSink;
  env?: Record<string, string | undefined>;
  referenceScriptPath?: string;
  loadExecutor?(): Promise<ProbeExecutor>;
  createSecrets?(args: { secretIdPrefix: string; region: string; executor: ProbeExecutor }): unknown;
  createRegistry?(args: { registryTable: string; region: string; executor: ProbeExecutor }): ProbeTargetRegistry;
}
export declare const USAGE: string;
export declare function parseArgs(argv: readonly string[], env?: Record<string, string | undefined>): ProbeOptions;
export declare function loadExecutor(): Promise<ProbeExecutor>;
export declare function runProbe(argv: readonly string[], deps?: ProbeDeps): Promise<number>;
