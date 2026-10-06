// @akili-spec changes/cicd-executor-poc design §15.1 (DELETE/REWORK ownership)
// TEMPORARY compatibility shim (N-04). Type vocabulary ONLY, no behavior.
//
// The v2 step/execution state names below are still imported by modules owned
// by later tasks (frozen T-08 adapters: dynamodb-state-store/types.ts and
// step-repository.ts, plus their integration tests, and
// application/event-router). The step machine is gone; these names exist
// solely so those modules keep compiling until their owners rework them:
//   - N-08: dynamodb-state-store (switch to `ExecutionStatus`, delete step items)
//   - N-05: event-router
// Delete this file, and its re-export in ./index.ts, when the last importer
// is gone. Do NOT use these types in new code.

/** @deprecated v2 step type; removed with the step model (design §15.1). */
export type StepType = "source" | "lambda" | "codebuild" | "notify" | "ssh";

/** @deprecated v2 step state; removed with the step model (design §15.1). */
export type StepState =
  | "PENDING"
  | "WAITING_LOCK"
  | "DISPATCHING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "SKIPPED";

/** @deprecated v2 execution state; new code uses `ExecutionStatus` (design §7.3). */
export type ExecutionState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
