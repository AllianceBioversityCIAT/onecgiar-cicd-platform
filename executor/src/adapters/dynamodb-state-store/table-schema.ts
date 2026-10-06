// @akili-spec changes/cicd-executor-poc design §5.1
// Table/index key-attribute names and a `CreateTable` input builder. Creating
// the REAL table is Gate B (out of this task's scope) — this module exists so
// the schema is written exactly once and both a future IaC definition and the
// DynamoDB Local test harness (test/support) read the same source of truth,
// instead of the test table silently drifting from design §5.1's index table.
import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";
import { TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";

/** Sparse index (design §5.1): only items carrying `activeStatus` appear here. */
export const GSI2_NAME = "GSI2";
export const GSI2_PK_ATTR = "activeStatus";
export const GSI2_SK_ATTR = "deadlineAt";

export const TTL_ATTR = "expiresAt";

/**
 * `CreateTable` input for DynamoDB Local (on-demand billing, matching design
 * §5.1's "DynamoDB on-demand"). GSI2's key attributes are declared here (GSI1 was dropped: design §5.1, AC-01);
 * every OTHER item attribute stays schemaless, as DynamoDB requires.
 */
export function buildCreateTableInput(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: TABLE_PK_ATTR, AttributeType: "S" },
      { AttributeName: TABLE_SK_ATTR, AttributeType: "S" },
      { AttributeName: GSI2_PK_ATTR, AttributeType: "S" },
      { AttributeName: GSI2_SK_ATTR, AttributeType: "N" },
    ],
    KeySchema: [
      { AttributeName: TABLE_PK_ATTR, KeyType: "HASH" },
      { AttributeName: TABLE_SK_ATTR, KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: GSI2_NAME,
        KeySchema: [
          { AttributeName: GSI2_PK_ATTR, KeyType: "HASH" },
          { AttributeName: GSI2_SK_ATTR, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  };
}
