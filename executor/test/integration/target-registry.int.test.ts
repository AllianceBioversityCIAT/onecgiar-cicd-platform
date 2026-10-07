// @akili-spec changes/cicd-executor-poc design §5.3, §6.3; requirements FR-02; tasks R-3
// The DynamoDB Target Registry adapter against DynamoDB Local: found, missing and
// invalid records in a table shaped like `cicd-registry-<stage>` (pk/sk strings,
// infra/sam/template.yaml), and a real DynamoDB error for a table that does not exist.
import { randomUUID } from "node:crypto";
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from "@aws-sdk/client-dynamodb";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DynamoDbTargetRegistry } from "../../src/adapters/dynamodb-target-registry/index.js";
import { readJsonSchema } from "../contract/support/ajv-factory.js";
import { targetRecordSchemaPath } from "../contract/support/schema-paths.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, requireLocalDynamoEndpoint } from "./setup.js";

const REGISTRY_TABLE = "cicd-registry-test";

function record(targetId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId,
    project: "example",
    environment: "dev",
    host: "target.example.internal",
    user: "deploy",
    hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
    credentialRef: "cicd-poc/dev/example/ssh",
    deployScript: "/opt/cicd/example/deploy.sh",
    deployWindowPolicy: "not-required",
    sourceRepositoryId: "123456789",
    schemaVersion: 1,
    version: 1,
    updatedAt: "2026-10-07T12:00:00Z",
    updatedBy: "platform-admin",
    ...overrides,
  };
}

async function ensureRegistryTable(): Promise<void> {
  const client = new DynamoDBClient({ region: "us-east-1", endpoint: requireLocalDynamoEndpoint() });
  try {
    await client.send(
      new CreateTableCommand({
        TableName: REGISTRY_TABLE,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  } finally {
    client.destroy();
  }
}

describe.skipIf(!dynamoDbLocalAvailable())("DynamoDbTargetRegistry (DynamoDB Local, R-3)", () => {
  let client: DynamoDBDocumentClient;
  let registry: DynamoDbTargetRegistry;
  const schema = readJsonSchema(targetRecordSchemaPath);

  beforeAll(async () => {
    await ensureRegistryTable();
    client = createTestDocumentClient();
    registry = new DynamoDbTargetRegistry({ client, tableName: REGISTRY_TABLE, schema });
  });

  afterAll(() => {
    client?.destroy();
  });

  const newTargetId = (): string => `it-${randomUUID().slice(0, 8)}`;
  const store = async (targetId: string, attributes: Record<string, unknown>): Promise<void> => {
    await client.send(new PutCommand({ TableName: REGISTRY_TABLE, Item: { pk: `TARGET#${targetId}`, sk: "META", ...attributes } }));
  };

  test("found: a valid record is returned without its key attributes", async () => {
    const targetId = newTargetId();
    await store(targetId, record(targetId));
    expect(await registry.getTarget(targetId)).toEqual({ kind: "found", target: record(targetId) });
  });

  test("missing: no item for the targetId", async () => {
    expect(await registry.getTarget(newTargetId())).toEqual({ kind: "missing" });
  });

  test("missing: an item under another sort key is not the target record", async () => {
    const targetId = newTargetId();
    await client.send(new PutCommand({ TableName: REGISTRY_TABLE, Item: { pk: `TARGET#${targetId}`, sk: "OTHER", ...record(targetId) } }));
    expect(await registry.getTarget(targetId)).toEqual({ kind: "missing" });
  });

  test("invalid: a schema-invalid record", async () => {
    const targetId = newTargetId();
    await store(targetId, record(targetId, { deployScript: "/opt/../bin/sh" }));
    expect((await registry.getTarget(targetId)).kind).toBe("invalid");
  });

  test("invalid: a record whose targetId differs from its key", async () => {
    const targetId = newTargetId();
    await store(targetId, record("someone-else"));
    expect((await registry.getTarget(targetId)).kind).toBe("invalid");
  });

  test("a real DynamoDB error (table does not exist) is propagated, not reported as missing", async () => {
    const broken = new DynamoDbTargetRegistry({ client, tableName: "cicd-registry-does-not-exist", schema });
    await expect(broken.getTarget(newTargetId())).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });
});
