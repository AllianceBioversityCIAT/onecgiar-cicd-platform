// @akili-spec changes/cicd-executor-poc design §5.1 (T-08 integration tests)
// Shared DynamoDB Local wiring for this directory's test files: the table
// schema comes from the adapter itself (table-schema.ts) so the test table
// can never silently drift from design §5.1's real index definitions.
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { buildCreateTableInput } from "../../src/adapters/dynamodb-state-store/table-schema.js";

/**
 * `true` only when run through `npm run test:integration` (the orchestrator
 * sets this once DynamoDB Local is confirmed up). Every test file in this
 * directory gates its `describe` block on this so a bare `npx vitest run
 * test/integration` (or the project-wide `npm test`) skips with a clear
 * reason instead of hanging or failing on a connection refused.
 */
export function dynamoDbLocalAvailable(): boolean {
  return Boolean(process.env.DYNAMODB_LOCAL_ENDPOINT);
}

export function requireLocalDynamoEndpoint(): string {
  const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;
  if (endpoint === undefined) {
    throw new Error(
      "DYNAMODB_LOCAL_ENDPOINT is not set. Run these tests via `npm run test:integration`, " +
        "which starts DynamoDB Local (no Docker, Java 17 + the on-demand jar) and sets it automatically.",
    );
  }
  return endpoint;
}

export function testTableName(): string {
  return process.env.DYNAMODB_TEST_TABLE ?? "cicd-executor-test";
}

let tableEnsured = false;

/** Idempotent: safe to call from every test file's `beforeAll` — `ResourceInUseException` means another file already created it. */
export async function ensureTestTable(): Promise<void> {
  if (tableEnsured) return;
  const endpoint = requireLocalDynamoEndpoint();
  const client = new DynamoDBClient({ region: "us-east-1", endpoint });
  try {
    await client.send(new CreateTableCommand(buildCreateTableInput(testTableName())));
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) {
      throw error;
    }
  } finally {
    client.destroy();
  }
  tableEnsured = true;
}

export function createTestDocumentClient(): DynamoDBDocumentClient {
  const endpoint = requireLocalDynamoEndpoint();
  const base = new DynamoDBClient({ region: "us-east-1", endpoint });
  return DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
}
