// @akili-spec changes/cicd-executor-poc design §6.2, §6.5, §7 (main), DD-19, DD-23; requirements FR-01, FR-21, NFR-01
// Composition units that need no database: configuration fail-fast, startup validation over ALL bundled
// definitions (an invalid set prevents startup), the plan resolver's NFR-01 and argument-safety behavior, and
// the router carrying `senderRef` / `sqsMessageId` to the handlers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { loadConfig, ConfigError } from "../../src/composition/config.js";
import { bootstrap, type EnumerableDefinitionSource } from "../../src/main/bootstrap.js";
import { DefinitionValidationError, validateForStartup } from "../../src/application/definition-service/index.js";
import { createStartupCatalog } from "../../src/composition/catalog.js";
import { createPlanResolver } from "../../src/composition/plan-resolver.js";
import { DeployTransactions } from "../../src/adapters/dynamodb-state-store/deploy-transactions.js";
import { UnsafeArgumentError } from "../../src/adapters/ssh-deployer/index.js";
import { createMessageValidators, routeMessage, type MessageHandlers } from "../../src/application/message-router/index.js";
import { deployRequestSchemaPath, eventSchemaPath, prmsReportingDevDeploymentYamlPath, targetsDevYamlPath, deploymentSchemaPath, targetsSchemaPath } from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";
import { KNOWN_REFS, bundledDefinitions, fakeSecrets, validEnv } from "../support/composition-fixtures.js";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";

const read = (p: string): string => readFileSync(p, "utf8");

function inMemory(deployment: string): EnumerableDefinitionSource {
  const source = new InMemoryDefinitionSource({
    deployments: { "prms-reporting-dev": deployment },
    targetRegistry: read(targetsDevYamlPath),
    schemas: {
      "deployment.schema.json": read(deploymentSchemaPath),
      "targets.schema.json": read(targetsSchemaPath),
      "deploy-request.schema.json": read(deployRequestSchemaPath),
      "event.schema.json": read(eventSchemaPath),
    },
  });
  return Object.assign(source, { listDeploymentIds: async () => ["prms-reporting-dev"] });
}

describe("configuration (design §3.3, DD-16, DD-23)", () => {
  it("accepts a complete environment", () => {
    expect(loadConfig(validEnv()).principalRefs.operatorPrincipalRef).toBe("<OPERATOR_PRINCIPAL_REF>");
  });

  it("fails fast naming EVERY problem at once, including a principal ref that is not a logical reference", () => {
    const env = validEnv({ CICD_TABLE_NAME: undefined, CICD_QUEUE_URL: "", CICD_OPERATOR_PRINCIPAL_REF: "AROAREALROLEID", CICD_LOGS_URL_TEMPLATE: "https://logs.example.invalid/" });
    expect(() => loadConfig(env)).toThrowError(ConfigError);
    try {
      loadConfig(env);
    } catch (error) {
      const problems = (error as ConfigError).problems.join("\n");
      expect(problems).toContain("CICD_TABLE_NAME is required");
      expect(problems).toContain("CICD_QUEUE_URL is required");
      expect(problems).toContain("CICD_OPERATOR_PRINCIPAL_REF must be a logical");
      expect(problems).toContain("{executionId}");
    }
  });
});

describe("startup validation over ALL bundled definitions (design §6.2)", () => {
  it("enumerates the bundled definitions", async () => {
    expect(await bundledDefinitions().listDeploymentIds()).toContain("prms-reporting-dev");
  });

  it("an invalid definition set prevents startup (falsifier: skipping validateForStartup makes this red)", async () => {
    const invalid = parseYaml(read(prmsReportingDevDeploymentYamlPath)) as Record<string, unknown>;
    delete invalid["targetRef"];
    await expect(
      bootstrap({ env: validEnv(), secrets: fakeSecrets(), definitions: inMemory(stringifyYaml(invalid)), documentClient: {} as never, publisher: { publish: async () => ({ messageId: "x" }) }, createConsumer: () => ({ start: async () => {}, stop: async () => {} }) }),
    ).rejects.toBeInstanceOf(DefinitionValidationError);
  });

  it("an unresolved reference prevents startup", async () => {
    const partial = { ...KNOWN_REFS };
    delete partial["<PRMS_REPORTING_CI_ROLE_REF>"];
    await expect(
      bootstrap({ env: validEnv(), secrets: new FakeSecretProvider(partial), definitions: inMemory(read(prmsReportingDevDeploymentYamlPath)), documentClient: {} as never }),
    ).rejects.toThrow(/did not resolve/);
  });
});

async function startupCatalog() {
  const definitions = inMemory(read(prmsReportingDevDeploymentYamlPath));
  const secrets = fakeSecrets();
  const startup = await validateForStartup({ definitionSource: definitions, secretProvider: secrets, principalRefs: loadConfig(validEnv()).principalRefs }, ["prms-reporting-dev"]);
  return { catalog: createStartupCatalog(startup), secrets };
}

const execution = (over: Partial<ExecutionItem> = {}): ExecutionItem =>
  ({
    executionId: "prms-reporting-dev-1",
    deploymentId: "prms-reporting-dev",
    lockKey: "deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit",
    artifacts: { server: `sha256:${"b".repeat(64)}`, client: `sha256:${"c".repeat(64)}` },
    ...over,
  }) as ExecutionItem;

describe("plan resolver (design §6.5, NFR-01)", () => {
  it("builds the argument vector from the VALIDATED definition and never resolves the runtime secret reference", async () => {
    const { catalog, secrets } = await startupCatalog();
    const asked: string[] = [];
    const spying = { getSecret: (r: string) => (asked.push(r), secrets.getSecret(r)), exists: (r: string) => secrets.exists(r) };
    const plan = await createPlanResolver({ catalog, secrets: spying }).resolve(execution());
    const args = plan.scriptArgs(7);
    expect(plan.targetRef).toBe("prms-reporting-dev");
    expect(args).toEqual(expect.arrayContaining(["--lock-key", "--fencing-token", "7", "--migrate", "server-container", "--port", "server-container=8080:3000"]));
    expect(asked.some((r) => r.includes("RUNTIME_SECRET") || r.includes("SSH_CREDENTIAL") || r.includes("SLACK_TOKEN"))).toBe(false);
  });

  it("rejects an argument with a line break BEFORE any dispatch intent (assertSafeScriptArgs at resolve time)", async () => {
    const { catalog, secrets } = await startupCatalog();
    const hostile = new FakeSecretProvider({ ...KNOWN_REFS, "<PRMS_REPORTING_SERVER_HEALTH_URL_REF>": "http://x\nrm -rf" });
    await expect(createPlanResolver({ catalog, secrets: hostile }).resolve(execution())).rejects.toBeInstanceOf(UnsafeArgumentError);
    expect(secrets).toBeDefined();
  });
});

describe("router carries audit data to the handlers (FR-21)", () => {
  it("passes senderRef (role-ID prefix) and the SQS messageId into the rejection", async () => {
    const validators = await createMessageValidators(inMemory(read(prmsReportingDevDeploymentYamlPath)));
    const rejections: unknown[] = [];
    const handlers = { rejected: async (r: unknown) => void rejections.push(r) } as unknown as MessageHandlers;
    await routeMessage(
      { body: JSON.stringify({ eventType: "DEPLOY_REQUESTED", deploymentId: "x" }), senderId: "ROLEX:session", messageId: "sqs-1" },
      { validators, handlers, sources: { resolveSource: async () => undefined }, authorizer: { decide: () => ({ authorized: false, senderRef: "ROLEX" }) } },
    );
    expect(rejections[0]).toMatchObject({ senderRef: "ROLEX", sqsMessageId: "sqs-1" });
  });
});

describe("startup refuses an unsafe resolved script argument (design §6.2)", () => {
  it("a resolved identifier with a trailing newline prevents startup, naming no value", async () => {
    const hostile = new FakeSecretProvider({ ...KNOWN_REFS, "<PRMS_REPORTING_SERVER_HEALTH_URL_REF>": "http://health.example.invalid/\n" });
    const attempt = bootstrap({ env: validEnv(), secrets: hostile, definitions: inMemory(read(prmsReportingDevDeploymentYamlPath)), documentClient: {} as never });
    await expect(attempt).rejects.toThrow(/refusing to start: deployment "prms-reporting-dev" cannot produce a safe deploy plan/);
    await expect(attempt).rejects.not.toThrow(/health\.example/);
  });
});

describe("X9/X16 transactions: a TransactionConflict is a retry, never a verdict (FR-11)", () => {
  const conflictClient = (reasons: Array<{ Code: string }>) => ({
    send: async () => {
      throw Object.assign(new Error("canceled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    },
  });
  const executions = { updateSpec: () => ({}) } as never;
  const targets = { highestDispatchedUpdate: () => ({}), unresolvedAppendUpdate: () => ({}) } as never;

  it("beginDispatch and markUnknownTargetState rethrow when the cancellation is a TransactionConflict (e.g. a concurrent setAuditOnce)", async () => {
    const tx = new DeployTransactions(conflictClient([{ Code: "TransactionConflict" }, { Code: "None" }]) as never, executions, targets);
    await expect(tx.beginDispatch({ now: 1 } as never)).rejects.toThrow("canceled");
    await expect(tx.markUnknownTargetState({ now: 1 } as never)).rejects.toThrow("canceled");
  });

  it("a real condition failure is still a verdict", async () => {
    const tx = new DeployTransactions(conflictClient([{ Code: "None" }, { Code: "ConditionalCheckFailed" }]) as never, executions, targets);
    expect(await tx.beginDispatch({ now: 1 } as never)).toEqual({ outcome: "TARGET_CONDITION_FAILED" });
  });
});
