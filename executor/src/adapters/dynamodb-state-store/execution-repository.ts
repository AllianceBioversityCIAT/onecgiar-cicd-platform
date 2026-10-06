// @akili-spec changes/cicd-executor-poc design §5.1, §7.3; requirements FR-05, FR-07; DD-03
// Repository for the Execution item. Every state change is a conditional
// write on `status` + `version` (design §5.1: "Conditional on `status` +
// `version`"), and additionally on `dispatchToken` for the X10-X16 family
// (design §7.3, DD-28), so a stale attempt can never overwrite a newer one.
// GSI2's sparse attributes (`activeStatus`, `deadlineAt`) are removed in the
// SAME write that reaches a terminal status: a terminal execution can never
// appear in the reconciler's GSI2 Query again.
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TERMINAL_EXECUTION_STATUSES, type ExecutionStatus } from "../../domain/state-machine/index.js";
import { executionKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";
import type { ExecutionItem } from "./types.js";

type PatchableField = Exclude<keyof ExecutionItem, "executionId" | "version" | "activeStatus" | "deadlineAt">;

/**
 * Fields set to a value are written; fields set to `undefined` are REMOVED
 * (X9/X14 clear the per-attempt fields this way). `activeStatus`/`deadlineAt`
 * are required-but-nullable: the caller always states whether the execution
 * stays in GSI2's sparse index or leaves it, and `update` rejects a patch
 * that contradicts the target status (see below).
 */
export type ExecutionUpdatePatch = { readonly [F in PatchableField]?: ExecutionItem[F] | undefined } & {
  readonly activeStatus: "EXECUTION" | undefined;
  readonly deadlineAt: number | undefined;
};

/** Optimistic-concurrency guard of one transition. */
export interface ExecutionTransitionExpected {
  readonly status: ExecutionStatus;
  readonly version: number;
  /** Required by X10-X16: the write applies only if the persisted token still matches (DD-28). */
  readonly dispatchToken?: string;
}

/** GSI2 sparse rule: non-terminal requires activeStatus + deadlineAt; terminal forbids both. */
function assertSparseIndexCovenant(status: ExecutionStatus, activeStatus: unknown, deadlineAt: unknown): void {
  if (TERMINAL_EXECUTION_STATUSES.has(status)) {
    if (activeStatus !== undefined || deadlineAt !== undefined) {
      throw new Error(`terminal status "${status}" must remove activeStatus and deadlineAt (GSI2 is sparse)`);
    }
  } else if (activeStatus !== "EXECUTION" || deadlineAt === undefined) {
    throw new Error(`non-terminal status "${status}" must keep activeStatus = EXECUTION and a deadlineAt`);
  }
}

export class ExecutionRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async get(executionId: string): Promise<ExecutionItem | undefined> {
    const key = executionKey(executionId);
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk } }),
    );
    return result.Item as ExecutionItem | undefined;
  }

  /** Initial creation (DD-20 step 3: `attribute_not_exists`, idempotent to repeat). Throws, before any write, if the item contradicts GSI2's sparse rule. */
  public async create(item: ExecutionItem): Promise<boolean> {
    assertSparseIndexCovenant(item.status, item.activeStatus, item.deadlineAt);
    const key = executionKey(item.executionId);
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
        }),
      ),
    );
  }

  /**
   * Conditional transition. Returns `false` (no effect) when `status`,
   * `version` or, if given, `dispatchToken` no longer match: the caller lost
   * a race and must re-read (DD-03).
   *
   * Throws (programming error, nothing is sent) when the patch would leave an
   * execution in a state GSI2 cannot represent: a terminal `status` must drop
   * `activeStatus`/`deadlineAt`; a non-terminal one must keep both.
   */
  public async update(
    executionId: string,
    expected: ExecutionTransitionExpected,
    patch: ExecutionUpdatePatch,
  ): Promise<boolean> {
    assertSparseIndexCovenant(patch.status ?? expected.status, patch.activeStatus, patch.deadlineAt);

    const key = executionKey(executionId);
    const names: Record<string, string> = { "#version": "version", "#status": "status" };
    const values: Record<string, unknown> = {
      ":expectedVersion": expected.version,
      ":nextVersion": expected.version + 1,
      ":expectedStatus": expected.status,
    };
    const setClauses: string[] = ["#version = :nextVersion"];
    const removeClauses: string[] = [];
    let condition = "#version = :expectedVersion AND #status = :expectedStatus";
    if (expected.dispatchToken !== undefined) {
      names["#dispatchTokenGuard"] = "dispatchToken";
      values[":expectedDispatchToken"] = expected.dispatchToken;
      condition += " AND #dispatchTokenGuard = :expectedDispatchToken";
    }

    for (const [field, value] of Object.entries(patch)) {
      const nameToken = `#f_${field}`;
      names[nameToken] = field;
      if (value === undefined) {
        removeClauses.push(nameToken);
      } else {
        const valueToken = `:f_${field}`;
        values[valueToken] = value;
        setClauses.push(`${nameToken} = ${valueToken}`);
      }
    }

    const updateExpressionParts = [`SET ${setClauses.join(", ")}`];
    if (removeClauses.length > 0) {
      updateExpressionParts.push(`REMOVE ${removeClauses.join(", ")}`);
    }

    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression: updateExpressionParts.join(" "),
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      ),
    );
  }
}
