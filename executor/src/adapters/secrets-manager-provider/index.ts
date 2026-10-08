// @akili-spec changes/cicd-executor-poc design §4.2, §7, NFR-02, DD-16, DD-23
// SecretProvider over AWS Secrets Manager. Resolves the Executor's OWN
// operational secrets by logical reference (`<NAME>` -> `secretIdPrefix + NAME`)
// and a target record's `credentialRef` (AC-02 V1, design §6.3): a full secret
// name that must lie under `secretIdPrefix` (the onboarding tool enforces the
// same rule, R-7; checked again here, fail closed).
// - `exists` uses DescribeSecret ONLY, never GetSecretValue (owner ruling:
//   existence without reading; see ports/secret-provider.ts).
// - `getSecret` reads at the point of use and never caches the value.
// - Credentials come from the SDK default chain (DD-16): none are handled here.
// - Thrown errors are sanitized: logical ref, operation and AWS error name only.
//   The AWS message (may hold an ARN/account ID), the resolved secret id and the
//   original error (no `cause`) are deliberately never propagated.
import { DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretProvider } from "../../ports/secret-provider.js";

const LOGICAL_REF = /^<([A-Z][A-Z0-9_]*)>$/;
const SECRET_ID_PREFIX = /^[A-Za-z0-9/_+=.@-]*$/;
/** A Secrets Manager secret name (same charset as target-record.schema.json `credentialRef`; no ':' so never an ARN). */
const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

export type SecretProviderOperation = "exists" | "getSecret";

/** Sanitized failure: carries only the logical ref, the operation and an AWS error name. */
export class SecretProviderError extends Error {
  public readonly operation: SecretProviderOperation;
  public readonly secretRef: string;
  public readonly code: string;
  public constructor(operation: SecretProviderOperation, secretRef: string, code: string) {
    super(`secret provider ${operation} failed for ${secretRef}: ${code}`);
    this.name = "SecretProviderError";
    this.operation = operation;
    this.secretRef = secretRef;
    this.code = code;
  }
}

/** Minimal client surface (injectable; the real SecretsManagerClient satisfies it). */
export interface SecretsManagerSender {
  send(command: DescribeSecretCommand | GetSecretValueCommand): Promise<unknown>;
}

export interface SecretsManagerSecretProviderDeps {
  readonly client: SecretsManagerSender;
  readonly secretIdPrefix: string;
}

/** Validates a prefix against Secrets Manager name characters; returns a problem or undefined. */
export function secretIdPrefixProblem(prefix: string): string | undefined {
  return SECRET_ID_PREFIX.test(prefix) ? undefined : "must contain only letters, digits and /_+=.@-";
}

/**
 * The rule for a target record's `credentialRef` (design §6.3; tasks R-7): a secret name strictly under the
 * Executor's non-empty secret id prefix, so a new target needs no IAM change. Returns a problem or undefined.
 */
export function credentialRefProblem(secretIdPrefix: string, credentialRef: string): string | undefined {
  if (secretIdPrefix === "") return "the Executor secret id prefix is empty, so no credentialRef can be scoped to it";
  if (!SECRET_NAME.test(credentialRef)) return "is not a Secrets Manager secret name (letters, digits and /_+=.@- only)";
  if (!credentialRef.startsWith(secretIdPrefix) || credentialRef.length === secretIdPrefix.length) {
    return "must be a secret name under the Executor's secret id prefix";
  }
  return undefined;
}

export function createSecretsManagerClient(region: string): SecretsManagerSender {
  return new SecretsManagerClient({ region });
}

function awsCode(error: unknown): string {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return typeof name === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(name) ? name : "UnknownError";
}

export class SecretsManagerSecretProvider implements SecretProvider {
  private readonly client: SecretsManagerSender;
  private readonly secretIdPrefix: string;

  public constructor(deps: SecretsManagerSecretProviderDeps) {
    const problem = secretIdPrefixProblem(deps.secretIdPrefix);
    if (problem !== undefined) throw new Error(`invalid secret id prefix: ${problem}`);
    this.client = deps.client;
    this.secretIdPrefix = deps.secretIdPrefix;
  }

  public async exists(secretRef: string): Promise<boolean> {
    const secretId = this.toSecretId("exists", secretRef);
    try {
      const out = (await this.client.send(new DescribeSecretCommand({ SecretId: secretId }))) as { DeletedDate?: Date } | undefined;
      return out?.DeletedDate === undefined || out.DeletedDate === null ? true : false;
    } catch (error) {
      if (awsCode(error) === "ResourceNotFoundException") return false;
      throw new SecretProviderError("exists", secretRef, awsCode(error));
    }
  }

  public async getSecret(secretRef: string): Promise<string> {
    const secretId = this.toSecretId("getSecret", secretRef);
    let out: { SecretString?: string } | undefined;
    try {
      out = (await this.client.send(new GetSecretValueCommand({ SecretId: secretId }))) as { SecretString?: string } | undefined;
    } catch (error) {
      throw new SecretProviderError("getSecret", secretRef, awsCode(error));
    }
    if (typeof out?.SecretString !== "string") throw new SecretProviderError("getSecret", secretRef, "NoSecretString");
    return out.SecretString;
  }

  private toSecretId(operation: SecretProviderOperation, secretRef: string): string {
    const match = LOGICAL_REF.exec(secretRef);
    if (match !== null && match[1] !== undefined) return `${this.secretIdPrefix}${match[1]}`;
    if (credentialRefProblem(this.secretIdPrefix, secretRef) === undefined) return secretRef;
    throw new SecretProviderError(operation, "<invalid-ref>", "InvalidLogicalRef");
  }
}
