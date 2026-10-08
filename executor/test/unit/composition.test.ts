// @akili-spec changes/cicd-executor-poc design §1.2, §6.2, §6.5, §7 (main), DD-19, DD-23; requirements FR-01, FR-21, NFR-01; tasks R-4, R-5 (AC-02 V1)
// Composition units that need no database: configuration fail-fast (the V1 startup without definitions is
// covered by startup-fail-fast.test.ts, R-6), the V1 deploy plan built from the execution snapshot (no definition, no secret resolution), and the router carrying `senderRef` / `sqsMessageId` to the handlers.
import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "../../src/composition/config.js";
import { deployPlanOf } from "../../src/application/deploy-coordinator/index.js";
import { DeployTransactions } from "../../src/adapters/dynamodb-state-store/deploy-transactions.js";
import { createMessageValidators, routeMessage, type MessageHandlers } from "../../src/application/message-router/index.js";
import { bundledSchemas, validEnv } from "../support/composition-fixtures.js";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";

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

  it("requires CICD_REGISTRY_TABLE_NAME and exposes it as registryTableName (AC-02, R-2)", () => {
    expect(loadConfig(validEnv()).registryTableName).toBe("cicd-registry-test");
    expect(() => loadConfig(validEnv({ CICD_REGISTRY_TABLE_NAME: undefined }))).toThrowError(/CICD_REGISTRY_TABLE_NAME is required/);
    expect(() => loadConfig(validEnv({ CICD_REGISTRY_TABLE_NAME: " " }))).toThrowError(/CICD_REGISTRY_TABLE_NAME is required/);
  });

  it("defaults the secret id prefix to empty, accepts a valid one and rejects an invalid one", () => {
    expect(loadConfig(validEnv()).secretIdPrefix).toBe("");
    expect(loadConfig(validEnv({ CICD_SECRET_ID_PREFIX: "cicd-poc/dev/" })).secretIdPrefix).toBe("cicd-poc/dev/");
    expect(() => loadConfig(validEnv({ CICD_SECRET_ID_PREFIX: "bad prefix*" }))).toThrowError(/CICD_SECRET_ID_PREFIX/);
  });
});

const execution = (over: Partial<ExecutionItem> = {}): ExecutionItem =>
  ({
    executionId: "example-app-dev-1",
    targetId: "example-app-dev",
    commitSha: "a".repeat(40),
    artifacts: { server: `sha256:${"b".repeat(64)}`, client: `sha256:${"c".repeat(64)}` },
    targetSnapshot: {
      version: 1,
      project: "example",
      environment: "dev",
      host: "target.example.internal",
      user: "deploy",
      hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
      credentialRef: "cicd-poc/dev/example-app-dev/ssh",
      deployScript: "/opt/cicd/example-app/deploy.sh",
      deployWindowPolicy: "not-required",
      sourceRepositoryId: "123456789",
    },
    ...over,
  }) as ExecutionItem;

describe("V1 deploy plan from the execution snapshot (design §6.5, NFR-01)", () => {
  it("is the fixed argument vector: target, execution, fencing token, commit and one --artifact per unit (sorted); nothing application-specific", () => {
    const plan = deployPlanOf(execution());
    expect(plan.scriptPath).toBe("/opt/cicd/example-app/deploy.sh");
    expect(plan.timeoutMinutes).toBe(20);
    expect(plan.scriptArgs(7)).toEqual([
      "--target-id", "example-app-dev",
      "--execution-id", "example-app-dev-1",
      "--fencing-token", "7",
      "--commit-sha", "a".repeat(40),
      "--artifact", `client=sha256:${"c".repeat(64)}`,
      "--artifact", `server=sha256:${"b".repeat(64)}`,
    ]);
    for (const forbidden of ["--port", "--migrate", "--health", "--runtime-secret", "--lock-key", "--unit"]) {
      expect(plan.scriptArgs(7)).not.toContain(forbidden);
    }
  });

  it("connects with the snapshot's values and a credential REFERENCE (port absent -> left to the transport default)", () => {
    expect(deployPlanOf(execution()).target).toEqual({
      targetId: "example-app-dev",
      host: "target.example.internal",
      user: "deploy",
      hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
      credentialRef: "cicd-poc/dev/example-app-dev/ssh",
    });
    expect(deployPlanOf(execution()).window).toEqual({ targetId: "example-app-dev", deployWindowPolicy: "not-required" });
  });
});

describe("router carries audit data to the handlers (FR-21)", () => {
  it("passes senderRef (role-ID prefix) and the SQS messageId into the rejection", async () => {
    const validators = await createMessageValidators(bundledSchemas());
    const rejections: unknown[] = [];
    const handlers = { rejected: async (r: unknown) => void rejections.push(r) } as unknown as MessageHandlers;
    await routeMessage(
      { body: JSON.stringify({ eventType: "DEPLOY_REQUESTED", targetId: "x" }), senderId: "ROLEX:session", messageId: "sqs-1" },
      {
        validators,
        handlers,
        targets: { getTarget: async () => ({ kind: "missing" }) },
        dedupe: { get: async () => undefined },
        clock: { now: () => new Date(0) },
        authorizer: { decide: () => ({ authorized: false, senderRef: "ROLEX" }) },
      },
    );
    expect(rejections[0]).toMatchObject({ senderRef: "ROLEX", sqsMessageId: "sqs-1" });
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
