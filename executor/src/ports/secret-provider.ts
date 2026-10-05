// @akili-spec changes/cicd-executor-poc design NFR-02, §7
// Port: resolves the Executor's OWN operational secrets (e.g. SSH
// credential, Slack token) by logical reference. NFR-01 boundary: this is
// never a path to application secrets — those are out of scope for the
// Executor entirely. AWS credentials are out of scope too (DD-16: default
// SDK credential chain, no custom mechanism).

export interface SecretProvider {
  getSecret(secretRef: string): Promise<string>;
}
