// @akili-spec changes/cicd-executor-poc design DD-23; owner ruling (execution.md 2026-10-05)
// Fake SecretProvider for startup-mode definition-service tests: resolves
// only the references it was explicitly given, and throws a named error for
// anything else — exactly the "unresolved reference aborts" contract.
//
// `existsOnly` models a CREDENTIAL reference (owner ruling, execution.md
// 2026-10-05): `exists()` reports it as present, but it carries NO value —
// calling `getSecret` on it throws UnknownReferenceError, exactly like any
// other unregistered reference. This lets a test prove definition-service
// never calls `getSecret` for a credential ref: if it did, the test would
// see this provider throw.
import type { SecretProvider } from "../../src/ports/secret-provider.js";

export class UnknownReferenceError extends Error {
  constructor(secretRef: string) {
    super(`FakeSecretProvider: no value registered for reference "${secretRef}"`);
    this.name = "UnknownReferenceError";
  }
}

export class FakeSecretProvider implements SecretProvider {
  constructor(
    private readonly values: Readonly<Record<string, string>>,
    private readonly existsOnly: ReadonlySet<string> = new Set(),
  ) {}

  async getSecret(secretRef: string): Promise<string> {
    if (!Object.prototype.hasOwnProperty.call(this.values, secretRef)) {
      throw new UnknownReferenceError(secretRef);
    }
    return this.values[secretRef]!;
  }

  async exists(secretRef: string): Promise<boolean> {
    if (this.existsOnly.has(secretRef)) return true;
    return Object.prototype.hasOwnProperty.call(this.values, secretRef);
  }
}
