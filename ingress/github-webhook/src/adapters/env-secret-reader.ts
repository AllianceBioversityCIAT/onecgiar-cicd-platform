// @akili-spec changes/cicd-executor-poc design §6.6
// Secret reader adapter: reads the already-resolved webhook secret from the
// Lambda's own environment. Gate B (T-30, deployment) is responsible for
// injecting the real value at deploy time from the secret store referenced
// logically as `<WEBHOOK_SECRET_REF>` — this file never names a real
// secret, and never calls a secrets-manager SDK itself (that wiring is a
// deployment concern, not this code-only task's).
import type { SecretReader } from "../core/ports.js";

export class MissingWebhookSecretError extends Error {
  constructor(envVarName: string) {
    super(
      `refusing to start: environment variable "${envVarName}" is not set. ` +
        "Gate B's deployment must inject the webhook signing secret (ref <WEBHOOK_SECRET_REF>) into this variable.",
    );
    this.name = "MissingWebhookSecretError";
  }
}

export interface EnvSecretReaderOptions {
  /** Name of the environment variable carrying the resolved secret value. Defaults to WEBHOOK_SECRET. */
  readonly envVarName?: string;
  /** Override environment lookup (tests only); defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

export class EnvSecretReader implements SecretReader {
  private readonly envVarName: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: EnvSecretReaderOptions = {}) {
    this.envVarName = options.envVarName ?? "WEBHOOK_SECRET";
    this.env = options.env ?? process.env;
  }

  async getWebhookSecret(): Promise<string> {
    const value = this.env[this.envVarName];
    if (!value || value.trim().length === 0) {
      throw new MissingWebhookSecretError(this.envVarName);
    }
    return value;
  }
}
