// @akili-spec changes/cicd-executor-poc requirements FR-02, NFR-01; design DD-23, §6.4, §7.7 (amended 2026-10-05)
//
// definition-service.validateForStartup: resolves every ALLOWLISTED logical
// reference via SecretProvider before the Executor is allowed to start.
// Covers:
//   - a fully-resolvable registry/definition passes and returns the
//     resolved externalDeployers list;
//   - ANY unresolved (allowlisted) reference aborts startup with a clear,
//     named error;
//   - containers[].envSecretRef (the application's own runtime secret,
//     design §6.4 OD-Q5) is NEVER resolved — a provider that throws on it
//     must not abort startup (NFR-01);
//   - a `required` target whose resolved externalDeployers list is empty
//     is rejected (design §7.7 amended 2026-10-05);
//   - duplicate ports/names/hosts become visible over RESOLVED values even
//     when the two targets used different logical refs, different users on
//     an otherwise-identical host, or port mappings that only share the
//     published HOST port (the CI/logical check cannot see any of this — it
//     is exactly what startup mode adds).
import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, beforeAll } from "vitest";
import {
  pipelineSchemaPath,
  targetsSchemaPath,
  prmsReportingDevYamlPath,
  targetsDevYamlPath,
} from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";
import type { SecretProvider } from "../../src/ports/secret-provider.js";
import {
  validateForStartup,
  DefinitionValidationError,
  UnresolvedReferenceError,
} from "../../src/application/definition-service/index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Resolves everything `refs` declares via `getSecret`, but throws (like a
 * real provider that cannot/should not serve it) for any ref in `forbidden`
 * — used to prove the Executor never even calls `getSecret` for
 * containers[].envSecretRef (NFR-01) or for a CREDENTIAL reference (owner
 * ruling, execution.md 2026-10-05: existence-checked only). `exists()`
 * reports every forbidden ref as present — the ref genuinely resolves in
 * the real world, the Executor just must never read its VALUE here. */
class ThrowsOnSecretProvider implements SecretProvider {
  private readonly forbidden: ReadonlySet<string>;
  constructor(
    private readonly refs: Readonly<Record<string, string>>,
    forbidden: string | Iterable<string>,
  ) {
    this.forbidden = new Set(typeof forbidden === "string" ? [forbidden] : forbidden);
  }
  async getSecret(secretRef: string): Promise<string> {
    if (this.forbidden.has(secretRef)) {
      throw new Error(`must never call getSecret for "${secretRef}" — its value must never be read here`);
    }
    if (!Object.prototype.hasOwnProperty.call(this.refs, secretRef)) {
      throw new Error(`no value registered for "${secretRef}"`);
    }
    return this.refs[secretRef]!;
  }
  async exists(secretRef: string): Promise<boolean> {
    if (this.forbidden.has(secretRef)) return true;
    return Object.prototype.hasOwnProperty.call(this.refs, secretRef);
  }
}

describe("definition-service.validateForStartup — reference resolution (DD-23, §7.7 amended)", () => {
  let pipelineSchemaContent: string;
  let targetsSchemaContent: string;
  let pipelineDefinitionContent: string;
  let baseEntry: Record<string, unknown>;

  const MAIN_HOST_CONNECTION = JSON.stringify({ host: "resolved-main-host", port: 22, user: "deploy" });

  // Every ALLOWLISTED logical ref that the real, unmodified fixtures
  // contain. Startup mode must resolve all of them for the happy-path cases
  // to pass. `<PRMS_REPORTING_SERVER_RUNTIME_SECRET_REF>` (containers[].envSecretRef)
  // is DELIBERATELY ABSENT — it must never be requested (NFR-01).
  const KNOWN_REFS: Record<string, string> = {
    "<PRMS_REPORTING_REPO_URL>": "resolved-repo-url",
    "<PRMS_REPORTING_DEV_BRANCH>": "resolved-branch",
    "<GITHUB_CREDENTIAL_REF>": "resolved-github-credential",
    "<PRMS_REPORTING_SLACK_CHANNEL>": "resolved-slack-channel",
    "<SLACK_TOKEN_REF>": "resolved-slack-token",
    "<PRMS_REPORTING_SERVER_DIR>": "resolved-server-dir",
    "<PRMS_REPORTING_CLIENT_DIR>": "resolved-client-dir",
    "<QUALITY_WORKER_FUNCTION>": "resolved-quality-function",
    "<PRMS_REPORTING_DEV_CONNECTION_REF>": MAIN_HOST_CONNECTION,
    "<PRMS_REPORTING_DEV_HOST_KEY_REF>": "resolved-host-key",
    // CREDENTIAL reference (owner ruling, execution.md 2026-10-05): existence-
    // checked only, never passed to getSecret. Present here so exists()
    // reports it as resolvable for happy-path cases.
    "<PRMS_REPORTING_DEV_SSH_CREDENTIAL_REF>": "resolved-ssh-credential-must-never-be-read-here",
    "<PRMS_REPORTING_DEV_EXTERNAL_DEPLOYERS_REF>": JSON.stringify(["<JENKINS_JOB_A>", "<JENKINS_JOB_B>"]),
    "<SERVER_CONTAINER>": "resolved-server-container-name",
    "<PRMS_REPORTING_SERVER_IMAGE_REPOSITORY_REF>": "resolved-server-image-repo",
    "<PRMS_REPORTING_SERVER_PORT_REF>": "8080:3000",
    "<CLIENT_CONTAINER>": "resolved-client-container-name",
    "<PRMS_REPORTING_CLIENT_IMAGE_REPOSITORY_REF>": "resolved-client-image-repo",
    "<PRMS_REPORTING_CLIENT_PORT_REF>": "8081:4001",
  };

  beforeAll(() => {
    pipelineSchemaContent = readFileSync(pipelineSchemaPath, "utf8");
    targetsSchemaContent = readFileSync(targetsSchemaPath, "utf8");
    pipelineDefinitionContent = readFileSync(prmsReportingDevYamlPath, "utf8");
    const registry = parseYaml(readFileSync(targetsDevYamlPath, "utf8")) as Record<string, Record<string, unknown>>;
    baseEntry = registry["prms-reporting-dev"]!;
  });

  function sourceWithRegistry(registry: Record<string, unknown>): InMemoryDefinitionSource {
    return new InMemoryDefinitionSource({
      pipelines: { "prms-reporting-dev": pipelineDefinitionContent },
      targetRegistry: stringifyYaml(registry),
      schemas: {
        "pipeline.schema.json": pipelineSchemaContent,
        "targets.schema.json": targetsSchemaContent,
      },
      definitionRef: "test-fixture-ref",
    });
  }

  it("resolves every allowlisted reference, and returns a non-empty resolved externalDeployers list for a required target", async () => {
    const registry = { "prms-reporting-dev": clone(baseEntry) };
    const result = await validateForStartup(
      { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(KNOWN_REFS) },
      ["prms-reporting-dev"],
    );
    expect(result.resolvedExternalDeployers["prms-reporting-dev"]).toEqual(["<JENKINS_JOB_A>", "<JENKINS_JOB_B>"]);
  });

  it("never resolves containers[].envSecretRef — the application's own runtime secret (NFR-01, design §6.4 OD-Q5) — a provider that throws on it does not abort startup", async () => {
    const registry = { "prms-reporting-dev": clone(baseEntry) };
    const provider = new ThrowsOnSecretProvider(KNOWN_REFS, "<PRMS_REPORTING_SERVER_RUNTIME_SECRET_REF>");

    const result = await validateForStartup(
      { definitionSource: sourceWithRegistry(registry), secretProvider: provider },
      ["prms-reporting-dev"],
    );
    expect(result.resolvedExternalDeployers["prms-reporting-dev"]).toEqual(["<JENKINS_JOB_A>", "<JENKINS_JOB_B>"]);
  });

  describe("CREDENTIAL references are existence-checked only (owner ruling, execution.md 2026-10-05)", () => {
    const CREDENTIAL_REFS = [
      "<GITHUB_CREDENTIAL_REF>", // repository.credentialRef
      "<SLACK_TOKEN_REF>", // notifications.slack.tokenRef
      "<PRMS_REPORTING_DEV_SSH_CREDENTIAL_REF>", // target registry credentialRef
    ];

    it("never calls getSecret for repository.credentialRef, slack.tokenRef or the target's credentialRef — only exists()", async () => {
      const registry = { "prms-reporting-dev": clone(baseEntry) };
      const provider = new ThrowsOnSecretProvider(KNOWN_REFS, CREDENTIAL_REFS);

      const result = await validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: provider },
        ["prms-reporting-dev"],
      );
      expect(result.resolvedExternalDeployers["prms-reporting-dev"]).toEqual(["<JENKINS_JOB_A>", "<JENKINS_JOB_B>"]);
    });

    it("aborts startup naming only the ref when the target's credentialRef does not exist", async () => {
      const registry = { "prms-reporting-dev": clone(baseEntry) };
      const refsWithoutCredential = { ...KNOWN_REFS };
      delete refsWithoutCredential["<PRMS_REPORTING_DEV_SSH_CREDENTIAL_REF>"];

      await expect(
        validateForStartup(
          { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refsWithoutCredential) },
          ["prms-reporting-dev"],
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof UnresolvedReferenceError && error.ref === "<PRMS_REPORTING_DEV_SSH_CREDENTIAL_REF>",
      );
    });

    it("aborts startup naming only the ref when repository.credentialRef does not exist", async () => {
      const registry = { "prms-reporting-dev": clone(baseEntry) };
      const refsWithoutCredential = { ...KNOWN_REFS };
      delete refsWithoutCredential["<GITHUB_CREDENTIAL_REF>"];

      await expect(
        validateForStartup(
          { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refsWithoutCredential) },
          ["prms-reporting-dev"],
        ),
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof UnresolvedReferenceError && error.ref === "<GITHUB_CREDENTIAL_REF>",
      );
    });
  });

  it("aborts with a clear error, naming only the ref, when the resolved connection value carries a credential-looking field", async () => {
    const registry = { "prms-reporting-dev": clone(baseEntry) };
    const SECRET_VALUE_THAT_MUST_NEVER_BE_ECHOED = "super-secret-private-key-material-ABC123";
    const refs = {
      ...KNOWN_REFS,
      "<PRMS_REPORTING_DEV_CONNECTION_REF>": JSON.stringify({
        host: "resolved-main-host",
        privateKey: SECRET_VALUE_THAT_MUST_NEVER_BE_ECHOED,
      }),
    };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof Error)) return false;
      return (
        error.message.includes("credential-looking field") &&
        error.message.includes("<PRMS_REPORTING_DEV_CONNECTION_REF>") &&
        !error.message.includes(SECRET_VALUE_THAT_MUST_NEVER_BE_ECHOED)
      );
    });
  });

  it("aborts startup with a clear, named error when an allowlisted reference does not resolve", async () => {
    const registry = { "prms-reporting-dev": clone(baseEntry) };
    const incompleteRefs = { ...KNOWN_REFS };
    delete incompleteRefs["<PRMS_REPORTING_DEV_HOST_KEY_REF>"];

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(incompleteRefs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof UnresolvedReferenceError && error.ref === "<PRMS_REPORTING_DEV_HOST_KEY_REF>",
    );
  });

  it("rejects a required target whose resolved externalDeployers list is empty", async () => {
    const entry = clone(baseEntry);
    const registry = { "prms-reporting-dev": entry };
    const refsWithEmptyList = { ...KNOWN_REFS, "<PRMS_REPORTING_DEV_EXTERNAL_DEPLOYERS_REF>": JSON.stringify([]) };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refsWithEmptyList) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError && error.issues.some((i) => i.rule === "external-deployers-empty"),
    );
  });

  it("aborts with a clear error, naming only the ref, when the resolved externalDeployers value is not valid JSON — never echoing the resolved value itself (NFR-02, DD-23)", async () => {
    const entry = clone(baseEntry);
    const registry = { "prms-reporting-dev": entry };
    const SECRET_VALUE_THAT_MUST_NEVER_BE_ECHOED = "unpublished-jenkins-job-id-XYZ123-not-json";
    const refs = {
      ...KNOWN_REFS,
      "<PRMS_REPORTING_DEV_EXTERNAL_DEPLOYERS_REF>": SECRET_VALUE_THAT_MUST_NEVER_BE_ECHOED,
    };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof Error)) return false;
      return (
        error.message.includes("<PRMS_REPORTING_DEV_EXTERNAL_DEPLOYERS_REF>") &&
        !error.message.includes(SECRET_VALUE_THAT_MUST_NEVER_BE_ECHOED)
      );
    });
  });

  it("surfaces a duplicate HOST-PORT collision over RESOLVED values even when the container-side ports differ (8080:3000 vs 8080:4000)", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    // Different logical connectionRef/portRef strings from entryA's, but
    // they will resolve to the SAME real host / SAME published host port —
    // undetectable by the logical/CI-mode check, which is exactly what
    // startup mode adds.
    entryB.connectionRef = "<ALIAS_HOST_CONNECTION_REF>";
    (entryB.containers as Array<Record<string, unknown>>)[0]!.name = "<OTHER_SERVER_CONTAINER>";
    (entryB.containers as Array<Record<string, unknown>>)[0]!.portRef = "<ALIAS_SERVER_PORT_REF>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.name = "<OTHER_CLIENT_CONTAINER>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.portRef = "<CLIENT_PORT_REF_UNUSED>";
    entryB.lockKey = "deployment#<PRMS_REPORTING_DEV_TARGET>#other-unit";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    const refs = {
      ...KNOWN_REFS,
      "<ALIAS_HOST_CONNECTION_REF>": MAIN_HOST_CONNECTION, // same resolved host
      "<ALIAS_SERVER_PORT_REF>": "8080:4000", // SAME host port 8080 as entryA's server container, DIFFERENT container port
      "<CLIENT_PORT_REF_UNUSED>": "9090:5000",
      "<OTHER_SERVER_CONTAINER>": "resolved-other-server-container-name",
      "<OTHER_CLIENT_CONTAINER>": "resolved-other-client-container-name",
    };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError &&
        error.issues.some((i) => i.rule === "duplicate-port" && i.field.includes("other-target")),
    );
  });

  it("does NOT flag a collision when the resolved host ports genuinely differ (8080:3000 vs 9090:3000)", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    entryB.connectionRef = "<ALIAS_HOST_CONNECTION_REF_2>";
    (entryB.containers as Array<Record<string, unknown>>)[0]!.name = "<OTHER_SERVER_CONTAINER_2>";
    (entryB.containers as Array<Record<string, unknown>>)[0]!.portRef = "<ALIAS_SERVER_PORT_REF_2>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.name = "<OTHER_CLIENT_CONTAINER_2>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.portRef = "<CLIENT_PORT_REF_UNUSED_2>";
    entryB.lockKey = "deployment#<PRMS_REPORTING_DEV_TARGET>#other-unit-2";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    const refs = {
      ...KNOWN_REFS,
      "<ALIAS_HOST_CONNECTION_REF_2>": MAIN_HOST_CONNECTION, // same host — ports are the only thing under test here
      "<ALIAS_SERVER_PORT_REF_2>": "9090:3000", // DIFFERENT host port, same container-side port as entryA's server
      "<CLIENT_PORT_REF_UNUSED_2>": "9091:4001",
      "<OTHER_SERVER_CONTAINER_2>": "resolved-distinct-server-container-name-2",
      "<OTHER_CLIENT_CONTAINER_2>": "resolved-distinct-client-container-name-2",
    };

    const result = await validateForStartup(
      { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
      ["prms-reporting-dev"],
    );
    expect(Object.keys(result.registry.entries)).toHaveLength(2);
  });

  it("surfaces a duplicate-container-name collision over RESOLVED values even though the two targets used DIFFERENT logical name refs", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    entryB.connectionRef = "<ALIAS_HOST_CONNECTION_REF_3>";
    // Different logical container-name ref, but resolves to the SAME real
    // name as entryA's server container — caught only at the resolved level.
    (entryB.containers as Array<Record<string, unknown>>)[0]!.name = "<ALIAS_SERVER_CONTAINER_NAME>";
    (entryB.containers as Array<Record<string, unknown>>)[0]!.portRef = "<UNIQUE_PORT_REF_A>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.name = "<ALIAS_CLIENT_CONTAINER_NAME>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.portRef = "<UNIQUE_PORT_REF_B>";
    entryB.lockKey = "deployment#<PRMS_REPORTING_DEV_TARGET>#other-unit-3";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    const refs = {
      ...KNOWN_REFS,
      "<ALIAS_HOST_CONNECTION_REF_3>": MAIN_HOST_CONNECTION,
      "<ALIAS_SERVER_CONTAINER_NAME>": KNOWN_REFS["<SERVER_CONTAINER>"]!, // SAME resolved name as entryA's server container
      "<ALIAS_CLIENT_CONTAINER_NAME>": "resolved-distinct-client-container-name-3",
      "<UNIQUE_PORT_REF_A>": "7100:7100",
      "<UNIQUE_PORT_REF_B>": "7101:7101",
    };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError &&
        error.issues.some((i) => i.rule === "duplicate-container-name" && i.field.includes("other-target")),
    );
  });

  it("groups by host IDENTITY only — two entries whose resolved connections share the same host but differ in port/user still collide (DD-23)", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    entryB.connectionRef = "<ALIAS_HOST_DIFFERENT_USER_CONNECTION_REF>";
    entryB.lockKey = "deployment#<PRMS_REPORTING_DEV_TARGET>#other-unit-user";
    // Keep entryB's container names IDENTICAL to entryA's (the duplicate
    // under test); give it fresh ports so only the name collides.
    (entryB.containers as Array<Record<string, unknown>>)[0]!.portRef = "<UNIQUE_PORT_REF_C>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.portRef = "<UNIQUE_PORT_REF_D>";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    const refs = {
      ...KNOWN_REFS,
      "<ALIAS_HOST_DIFFERENT_USER_CONNECTION_REF>": JSON.stringify({
        host: "resolved-main-host", // SAME host as MAIN_HOST_CONNECTION
        port: 2222, // DIFFERENT ssh port
        user: "other-deploy-user", // DIFFERENT user/credential
      }),
      "<UNIQUE_PORT_REF_C>": "7200:7200",
      "<UNIQUE_PORT_REF_D>": "7201:7201",
    };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError &&
        error.issues.some((i) => i.rule === "duplicate-container-name" && i.field.includes("other-target")),
    );
  });

  it("aborts with a clear error when the resolved connection value is not the contracted JSON shape", async () => {
    const registry = { "prms-reporting-dev": clone(baseEntry) };
    const refs = { ...KNOWN_REFS, "<PRMS_REPORTING_DEV_CONNECTION_REF>": "not-json-at-all" };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("aborts with a clear error when the resolved port value is not a <host>:<container> mapping", async () => {
    const registry = { "prms-reporting-dev": clone(baseEntry) };
    const refs = { ...KNOWN_REFS, "<PRMS_REPORTING_SERVER_PORT_REF>": "not-a-port-mapping" };

    await expect(
      validateForStartup(
        { definitionSource: sourceWithRegistry(registry), secretProvider: new FakeSecretProvider(refs) },
        ["prms-reporting-dev"],
      ),
    ).rejects.toThrow(/host.*container.*mapping/);
  });
});
