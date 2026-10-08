// @akili-spec changes/cicd-executor-poc design §1.2, §4.2, §7 (platform-config row), DD-19 (superseded in V1), DD-23, DD-25; architecture-change-02 AC2-6, AC2-7; tasks R-6
// AC-02 V1 startup (R-6): the Executor starts with NO Deployment Definitions, no bundled registry and zero targets.
// It reads only the bundled `schemas/`, resolves the platform identifier references (the four principals) through
// the SecretProvider and checks that the platform Slack channel and token secrets exist (AC2-6, AC2-7). A missing
// platform reference still fails fast naming the reference, before any consumer, poller, heartbeat or queue call
// exists. Tested at bootstrap level over a temporary root that holds `schemas/` only (local validation with fakes;
// it says nothing about a real AWS startup).
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BundledSchemaSource } from "../../src/adapters/bundled-schema-source/index.js";
import { UnresolvedReferenceError } from "../../src/application/platform-config/index.js";
import { bootstrap } from "../../src/main/bootstrap.js";
import { describeStartupFailure } from "../../src/main/startup-diagnosis.js";
import type { SecretProvider } from "../../src/ports/secret-provider.js";
import { repoRoot } from "../contract/support/schema-paths.js";
import { CI_ROLE, PLATFORM_REFS, validEnv } from "../support/composition-fixtures.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";

/** A root that holds ONLY `schemas/`: no `deployment-definitions/`, no target registry file, no `deploy-scripts/`. */
function schemasOnlyRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cicd-startup-v1-"));
  cpSync(path.join(repoRoot, "schemas"), path.join(root, "schemas"), { recursive: true });
  return root;
}

/** Records every secret access so a test can prove which refs are read by value and which are existence-checked only. */
class RecordingSecrets implements SecretProvider {
  public readonly values: string[] = [];
  public readonly existence: string[] = [];
  public constructor(private readonly inner: SecretProvider) {}
  public async getSecret(ref: string): Promise<string> {
    this.values.push(ref);
    return this.inner.getSecret(ref);
  }
  public async exists(ref: string): Promise<boolean> {
    this.existence.push(ref);
    return this.inner.exists(ref);
  }
}

function attempt(root: string, secrets: SecretProvider = new FakeSecretProvider(PLATFORM_REFS)) {
  const touched: string[] = [];
  const dynamoCalls: unknown[] = [];
  const result = bootstrap({
    env: validEnv({ CICD_DEFINITIONS_ROOT: root }),
    secrets,
    // Any DynamoDB call during startup would be recorded here: startup reads no target.
    documentClient: { send: async (command: unknown) => (dynamoCalls.push(command), {}) } as never,
    publisher: { publish: async () => (touched.push("publish"), { messageId: "x" }) },
    createConsumer: () => (touched.push("createConsumer"), { start: async () => void touched.push("start"), stop: async () => {} }),
    healthcheckWriter: { write: () => undefined },
    logSink: { write: () => undefined },
    metricsSink: { write: () => undefined },
  });
  return { result, touched, dynamoCalls };
}

const PLATFORM_ENV_REFS = [
  ["CICD_CI_PRINCIPAL_REF", "<CI_PRINCIPAL_REF>"],
  ["CICD_EXECUTOR_PRINCIPAL_REF", "<EXECUTOR_PRINCIPAL_REF>"],
  ["CICD_SCHEDULER_PRINCIPAL_REF", "<SCHEDULER_PRINCIPAL_REF>"],
  ["CICD_OPERATOR_PRINCIPAL_REF", "<OPERATOR_PRINCIPAL_REF>"],
  ["CICD_PLATFORM_SLACK_CHANNEL_REF", "<PLATFORM_SLACK_CHANNEL_REF>"],
  ["CICD_PLATFORM_SLACK_TOKEN_REF", "<PLATFORM_SLACK_TOKEN_REF>"],
] as const;

describe("AC-02 V1 startup without Deployment Definitions (R-6)", () => {
  it("starts with no definitions and zero targets: consumers start, no target is read and no DynamoDB call is made", async () => {
    const { result, touched, dynamoCalls } = attempt(schemasOnlyRoot());
    const executor = await result;
    await executor.start();
    expect(touched).toContain("createConsumer");
    expect(touched).toContain("start");
    expect(dynamoCalls).toEqual([]);
    await executor.stop();
  });

  it("ignores a deployment-definitions/ directory entirely, even an unparsable one (definitions are not loaded)", async () => {
    const root = schemasOnlyRoot();
    mkdirSync(path.join(root, "deployment-definitions", "targets"), { recursive: true });
    writeFileSync(path.join(root, "deployment-definitions", "broken.yaml"), "key: [unclosed\n");
    writeFileSync(path.join(root, "deployment-definitions", "targets", "dev.yaml"), "not: [a registry\n");
    const { result, touched } = attempt(root);
    await result;
    expect(touched).toContain("createConsumer");
  });

  it("reads by value only the four principal refs; the Slack channel and token are existence-checked and the token is never read", async () => {
    const secrets = new RecordingSecrets(new FakeSecretProvider(PLATFORM_REFS));
    await attempt(schemasOnlyRoot(), secrets).result;
    expect([...secrets.values].sort()).toEqual(["<CI_PRINCIPAL_REF>", "<EXECUTOR_PRINCIPAL_REF>", "<OPERATOR_PRINCIPAL_REF>", "<SCHEDULER_PRINCIPAL_REF>"]);
    expect(secrets.existence).toEqual(expect.arrayContaining(["<PLATFORM_SLACK_CHANNEL_REF>", "<PLATFORM_SLACK_TOKEN_REF>"]));
    expect(secrets.values).not.toContain("<PLATFORM_SLACK_TOKEN_REF>");
  });

  it("does not need a definition reference (CICD_DEFINITION_REF) even in production", async () => {
    const touched: string[] = [];
    const executor = await bootstrap({
      env: validEnv({ CICD_DEFINITIONS_ROOT: schemasOnlyRoot(), CICD_DEFINITION_REF: undefined, NODE_ENV: "production" }),
      secrets: new FakeSecretProvider(PLATFORM_REFS),
      documentClient: {} as never,
      publisher: { publish: async () => ({ messageId: "x" }) },
      createConsumer: () => (touched.push("createConsumer"), { start: async () => {}, stop: async () => {} }),
    });
    expect(executor.config.registryTableName).toBe("cicd-registry-test");
    expect(touched).toContain("createConsumer");
  });

  it.each(PLATFORM_ENV_REFS)("a missing platform ref (%s) fails fast naming the ref, before any consumer or queue call", async (_name, ref) => {
    const partial: Record<string, string> = { ...PLATFORM_REFS };
    delete partial[ref];
    const { result, touched, dynamoCalls } = attempt(schemasOnlyRoot(), new FakeSecretProvider(partial));
    const error = (await result.catch((e: unknown) => e)) as UnresolvedReferenceError;
    expect(error).toBeInstanceOf(UnresolvedReferenceError);
    expect(error.ref).toBe(ref);
    expect(error.message).toContain(ref);
    expect(touched).toEqual([]);
    expect(dynamoCalls).toEqual([]);
  });

  it("a principal ref whose secret exists but cannot be read fails fast naming the ref, never an already resolved value", async () => {
    const resolved: string[] = [];
    const secrets: SecretProvider = {
      getSecret: async (ref) => {
        if (ref === "<SCHEDULER_PRINCIPAL_REF>") throw new Error("AccessDeniedException");
        const value = await new FakeSecretProvider(PLATFORM_REFS).getSecret(ref);
        resolved.push(value);
        return value;
      },
      exists: async () => true,
    };
    const { result, touched } = attempt(schemasOnlyRoot(), secrets);
    const error = (await result.catch((e: unknown) => e)) as UnresolvedReferenceError;
    expect(error).toBeInstanceOf(UnresolvedReferenceError);
    expect(error.ref).toBe("<SCHEDULER_PRINCIPAL_REF>");
    expect(resolved).toContain(CI_ROLE); // the CI ref resolved before the failing one
    for (const value of resolved) expect(error.message).not.toContain(value);
    expect(touched).toEqual([]);
  });

  it("a root without the bundled schemas fails fast naming the missing schema", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cicd-startup-v1-empty-"));
    const { result, touched } = attempt(root);
    await expect(result).rejects.toThrow(/deploy-request\.schema\.json|event\.schema\.json|target-record\.schema\.json/);
    expect(touched).toEqual([]);
  });
});

describe("bundled schema source (design DD-19 V1: `schemas/` stays bundled)", () => {
  it("serves a bundled schema by name", async () => {
    const source = new BundledSchemaSource({ root: repoRoot });
    expect(JSON.parse((await source.getSchema("target-record.schema.json")).content)).toHaveProperty("$id");
  });

  it.each(["../package.json", "schemas/../x.schema.json", "sub/target-record.schema.json", "target-record.json", ""])("refuses an unsafe schema name %j", async (name) => {
    await expect(new BundledSchemaSource({ root: repoRoot }).getSchema(name)).rejects.toThrow(/schema name/);
  });
});

describe("startup refusal message (main prints it and exits 1)", () => {
  it("is one safe line", () => {
    expect(describeStartupFailure(new UnresolvedReferenceError("<CI_PRINCIPAL_REF>"))).toEqual([
      'executor refused to start: unresolved reference at startup: "<CI_PRINCIPAL_REF>" did not resolve via SecretProvider',
    ]);
    expect(describeStartupFailure(new Error("boom"))).toEqual(["executor refused to start: boom"]);
    expect(describeStartupFailure("text")).toEqual(["executor refused to start: text"]);
  });
});
