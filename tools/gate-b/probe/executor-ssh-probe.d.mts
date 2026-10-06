// @akili-spec changes/cicd-executor-poc gate-b-plan K-7
// Hand-written declarations so tests can import the plain-JS owner tool under strict TypeScript.
export interface ProbeOptions {
  readonly connectionRef: string;
  readonly hostKeyRef: string;
  readonly credentialRef: string;
  readonly dryRun: boolean;
  readonly timeoutSeconds: number;
  readonly secretIdPrefix?: string;
  readonly region?: string;
}
export interface ProbeSink {
  write(text: string): unknown;
}
export interface ProbeExecutor {
  Ssh2DeployTransport: new (options: unknown) => { connect(targetRef: string): Promise<unknown> };
  SecretsManagerSecretProvider: new (deps: unknown) => unknown;
  createSecretsManagerClient(region: string): unknown;
  redactString?(text: string): string;
}
export interface ProbeDeps {
  stdout?: ProbeSink;
  stderr?: ProbeSink;
  env?: Record<string, string | undefined>;
  scriptPath?: string;
  loadExecutor?(): Promise<ProbeExecutor>;
  createSecrets?(args: { secretIdPrefix: string; region: string; executor: ProbeExecutor }): unknown;
}
export declare const USAGE: string;
export declare function parseArgs(argv: readonly string[], env?: Record<string, string | undefined>): ProbeOptions;
export declare function loadExecutor(): Promise<ProbeExecutor>;
export declare function runProbe(argv: readonly string[], deps?: ProbeDeps): Promise<number>;
