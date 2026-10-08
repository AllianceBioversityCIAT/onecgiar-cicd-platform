// @akili-spec changes/cicd-executor-poc design §5.3, §6.3, §11.2; architecture-change-02 AC2-4; tasks R-7
// The Target Registry tool against DynamoDB Local (no real AWS): a create is refused when the target exists,
// an update is refused from a stale version, a successful write bumps the version, and every written record
// is read back as `found` by the Executor's own read-only adapter (R-3) with the same schema.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from "@aws-sdk/client-dynamodb";
import { beforeAll, describe, expect, test } from "vitest";
import { DynamoDbTargetRegistry } from "../../src/adapters/dynamodb-target-registry/index.js";
import { runTargetRegistryTool, type TargetRegistryToolDeps } from "../../src/tools/target-registry/index.js";
import { targetRecordSchemaPath } from "../contract/support/schema-paths.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, requireLocalDynamoEndpoint } from "./setup.js";

const TABLE = `cicd-registry-tool-it-${randomUUID().slice(0, 8)}`;
const SCHEMA = JSON.parse(readFileSync(targetRecordSchemaPath, "utf8")) as object;

function record(targetId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId,
    project: "example",
    environment: "dev",
    host: "target.example.internal",
    user: "deploy",
    hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
    credentialRef: `cicd-poc/dev/${targetId}/ssh`,
    deployScript: "/opt/cicd/example/deploy.sh",
    deployWindowPolicy: "not-required",
    sourceRepositoryId: "123456789",
    ...overrides,
  };
}

function deps(file: Record<string, unknown>, errors: string[] = []): TargetRegistryToolDeps {
  const client = createTestDocumentClient();
  return {
    env: {},
    clock: { now: () => new Date("2026-10-07T12:00:00.000Z") },
    schema: SCHEMA,
    readFile: async () => JSON.stringify(file),
    createClient: () => client,
    out: () => undefined,
    err: (line) => void errors.push(line),
  };
}

const put = (extra: string[] = []): string[] => [
  "put", "--file", "record.json", "--updated-by", "platform-admin", "--secret-id-prefix", "cicd-poc/dev/",
  "--registry-table", TABLE, "--region", "us-east-1", "--profile", "cicd-admin", "--checklist-confirmed", ...extra,
];

describe.skipIf(!dynamoDbLocalAvailable())("target registry tool on DynamoDB Local (R-7)", () => {
  beforeAll(async () => {
    const client = new DynamoDBClient({ region: "us-east-1", endpoint: requireLocalDynamoEndpoint() });
    try {
      await client.send(
        new CreateTableCommand({
          TableName: TABLE,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        }),
      );
    } catch (error) {
      if (!(error instanceof ResourceInUseException)) throw error;
    } finally {
      client.destroy();
    }
  });

  const executorView = () => new DynamoDbTargetRegistry({ client: createTestDocumentClient(), tableName: TABLE, schema: SCHEMA });

  test("create, refused re-create, refused stale update, update; the Executor adapter reads each written version", async () => {
    const id = `t-${randomUUID().slice(0, 8)}`;
    expect(await runTargetRegistryTool(put(), deps(record(id)))).toBe(0);
    expect(await executorView().getTarget(id)).toMatchObject({ kind: "found", target: { targetId: id, version: 1, updatedBy: "platform-admin" } });

    const errors: string[] = [];
    expect(await runTargetRegistryTool(put(), deps(record(id, { host: "other.example.internal" }), errors))).toBe(1);
    expect(errors.join("\n")).toMatch(/already exists/);

    expect(await runTargetRegistryTool(put(["--expected-version", "1"]), deps(record(id, { deployWindowPolicy: "required" })))).toBe(0);
    const stale: string[] = [];
    expect(await runTargetRegistryTool(put(["--expected-version", "1"]), deps(record(id, { host: "other.example.internal" }), stale))).toBe(1);
    expect(stale.join("\n")).toMatch(/version is not 1/);

    expect(await executorView().getTarget(id)).toMatchObject({ kind: "found", target: { version: 2, deployWindowPolicy: "required", host: "target.example.internal" } });
  });

  test("an update of a target that does not exist is refused and creates nothing", async () => {
    const id = `t-${randomUUID().slice(0, 8)}`;
    expect(await runTargetRegistryTool(put(["--expected-version", "1"]), deps(record(id)))).toBe(1);
    expect(await executorView().getTarget(id)).toEqual({ kind: "missing" });
  });
});
