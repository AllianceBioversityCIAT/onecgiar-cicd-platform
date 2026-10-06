// @akili-spec changes/cicd-executor-poc design §4.2, DD-03
// Thin construction helper for the DynamoDB SDK clients this adapter shares
// across every repository. Kept to construction only — no business logic.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DynamoDbStateStoreConfig {
  readonly tableName: string;
  /** Set for DynamoDB Local (test harness) / unit doubles; omitted in AWS. */
  readonly endpoint?: string;
  readonly region?: string;
}

export function createDocumentClient(config: DynamoDbStateStoreConfig): DynamoDBDocumentClient {
  const base = new DynamoDBClient({
    region: config.region ?? "us-east-1",
    endpoint: config.endpoint,
  });
  return DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
