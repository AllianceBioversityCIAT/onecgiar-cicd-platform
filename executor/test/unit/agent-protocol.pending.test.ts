// @akili-spec changes/cicd-executor-poc architecture-change-04 §8, §9, §10, §16
//
// Acceptance cases defined in E1. The E2 (Executor) cases are now real tests:
//   - test/integration/agent-transport.int.test.ts (DynamoDB Local, real composition root): pinned lock without TTL,
//     asynchronous dispatch, closing transactions, duplicates and out-of-order events, re-send with the same command,
//     a pinned lock beyond the old 24 h TTL, an Executor restart, fencing and sender checks, silence -> query -> X16
//     with a hold, NEVER_SEEN with and without sufficient evidence, NOT_STARTED retry and reject, LOST + late FINISHED
//     (operator only) + TARGET_RESOLUTION_RECORDED, automatic release by verified evidence, concurrency, safe mode;
//   - test/integration/deploy-transactions.int.test.ts: SSH X16 holds the lock; only a fenced hold release frees it;
//   - test/unit/agent-transport.test.ts: state-machine requests, configuration, results-queue acknowledgement.
// What remains pending belongs to the agent (E3) and is executed there.
import { describe, it } from "vitest";

describe("E3 (agent) — journal, exclusivity and concurrency", () => {
  it.todo("journal order: ACCEPTED (fsync, target claim) -> DeleteMessage -> STARTING (fsync) -> spawn -> STARTED");
  it.todo("scenario 4: restart with ACCEPTED and no STARTING -> NOT_STARTED ABANDONED, the command is never started later");
  it.todo("scenario 5: restart with STARTING or STARTED and no live process -> LOST (process group killed with the agent)");
  it.todo("scenario 6/7: events wait in the outbox while offline and are sent in seq order; FINISHED is never lost");
  it.todo("the target state file (highestFencingToken, activeCommandId) survives restarts and is updated atomically with ACCEPTED");
  it.todo("NEVER_SEEN is answered only when commandIssuedAt > journalEpoch, inside the retention and after notAfter + skew; otherwise NO_RECORD");
  it.todo("scenario 9: a second command for an active target is NOT_STARTED TARGET_ACTIVE; a lower or equal token of another command is STALE_FENCING");
  it.todo("scenario 10: two targets sharing resource docker-engine (capacity 1) never run together; a third target without it runs in parallel");
  it.todo("a long deploy of one target never blocks another target's FIFO group (only the waiting target's group is held in flight)");
  it.todo("maxPending stops receiving; a command without a slot by notAfter is NOT_STARTED BUSY");
  it.todo("scenario 12: a failed S3 upload is retried from the outbox and never delays FINISHED; LOG_UPLOADED FAILED after 24 h");
  it.todo("timeout: SIGTERM to the process group, SIGKILL after killGraceSeconds; a catalog killGrace above the command's is REJECTED_CONFIG");
});
