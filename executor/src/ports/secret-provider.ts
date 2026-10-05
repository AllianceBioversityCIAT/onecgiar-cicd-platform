// @akili-spec changes/cicd-executor-poc design NFR-02, §7; owner ruling (execution.md 2026-10-05)
// Port: resolves the Executor's OWN operational secrets (e.g. SSH
// credential, Slack token) by logical reference. NFR-01 boundary: this is
// never a path to application secrets — those are out of scope for the
// Executor entirely. AWS credentials are out of scope too (DD-16: default
// SDK credential chain, no custom mechanism).
//
// Owner ruling (execution.md 2026-10-05, "existence without reading" /
// least privilege): CREDENTIAL references (repository.credentialRef,
// notifications.slack.tokenRef, the Target Registry's SSH credentialRef)
// are only ever checked for EXISTENCE at startup, never read with
// getSecret — definition-service is PROHIBITED from reading secret values
// (design §7 definition-service row). `exists` is how it proves a
// credential reference resolves without ever seeing the value.

export interface SecretProvider {
  getSecret(secretRef: string): Promise<string>;
  /**
   * Checks only that `secretRef` resolves to something, without reading its
   * value. The AWS adapter implements this with Secrets Manager
   * `DescribeSecret` — never `GetSecretValue` (TODO: AWS secret-provider
   * adapter task; no AWS code lands here).
   */
  exists(secretRef: string): Promise<boolean>;
}
