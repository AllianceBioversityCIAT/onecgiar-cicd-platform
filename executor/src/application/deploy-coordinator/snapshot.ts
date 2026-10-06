// @akili-spec changes/cicd-executor-poc design §5.1, §7.3
// Maps the persisted Execution item to the pure state-machine snapshot. Shared
// by the deploy coordinator and the reconciler so both feed `applyTransition`
// the same view of an execution.
import type { ExecutionSnapshot } from "../../domain/state-machine/index.js";
import type { ExecutionItem } from "../../adapters/dynamodb-state-store/types.js";

export function toExecutionSnapshot(item: ExecutionItem): ExecutionSnapshot {
  return {
    status: item.status,
    attempt: item.attempt,
    contentionCount: item.contentionCount,
    ...(item.dispatchToken === undefined ? {} : { dispatchToken: item.dispatchToken }),
    ...(item.execStartedAt === undefined ? {} : { execStartedAt: item.execStartedAt }),
    ...(item.lockWaitStartedAt === undefined ? {} : { lockWaitStartedAt: item.lockWaitStartedAt }),
    ...(item.lockWaitAttempts === undefined ? {} : { lockWaitAttempts: item.lockWaitAttempts }),
    ...(item.nextAttemptAt === undefined ? {} : { nextAttemptAt: item.nextAttemptAt }),
    ...(item.deadlineAt === undefined ? {} : { deadlineAt: item.deadlineAt }),
    ...(item.error === undefined
      ? {}
      : { error: { code: item.error.code as NonNullable<ExecutionSnapshot["error"]>["code"] } }),
    ...(item.result === undefined ? {} : { result: { exitCode: item.result.code } }),
    ...(item.lockLostDuringRun === undefined ? {} : { lockLostDuringRun: item.lockLostDuringRun }),
    ...(item.targetWriteRejected === undefined ? {} : { targetWriteRejected: item.targetWriteRejected }),
    ...(item.windowClosedDuringRun === undefined ? {} : { windowClosedDuringRun: item.windowClosedDuringRun }),
  };
}
