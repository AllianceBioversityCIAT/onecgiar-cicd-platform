// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §7, §11.4; design §7.3
//
// Unit coverage of AC-04 E2 pieces that do not need DynamoDB: the new state-machine requests (no new state, no new
// transition), the optional agent-transport configuration, and the acknowledgement rules of the results handler.
// The end-to-end behavior on DynamoDB Local is in test/integration/agent-transport.int.test.ts.
import { describe, expect, it } from "vitest";
import { applyTransition, type ExecutionSnapshot } from "../../src/domain/state-machine/index.js";
import { ConfigError, loadConfig } from "../../src/composition/config.js";
import { createAgentResultsHandler } from "../../src/inbound/agent-results/index.js";
import type { AgentEventOutcome } from "../../src/application/agent-transport/index.js";
import { validEnv } from "../support/composition-fixtures.js";

const T = 1_700_000_000_000;
const deploying = (over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot => ({
  status: "DEPLOYING",
  attempt: 1,
  dispatchToken: "tok-1",
  contentionCount: 0,
  lockWaitStartedAt: T,
  lockWaitAttempts: 1,
  ...over,
});

describe("state machine: agent requests reuse existing transitions only (AC-04 §7)", () => {
  it("AGENT_NOT_STARTED with budget and window: X14 back to WAITING_LOCK, per-attempt fields cleared", () => {
    const t = applyTransition(deploying(), { kind: "AGENT_NOT_STARTED", dispatchToken: "tok-1", v3Valid: true, now: T + 1000, nextAttemptAt: T + 31_000 });
    expect(t).toMatchObject({ accepted: true, transitionId: "X14", next: { status: "WAITING_LOCK", nextAttemptAt: T + 31_000 } });
  });

  it("AGENT_NOT_STARTED without budget is X15 LOCK_TIMEOUT; with a closed window X15 DEPLOY_WINDOW_CLOSED", () => {
    const exhausted = deploying({ lockWaitAttempts: 10 });
    expect(applyTransition(exhausted, { kind: "AGENT_NOT_STARTED", dispatchToken: "tok-1", v3Valid: true, now: T, nextAttemptAt: T })).toMatchObject({ transitionId: "X15", next: { error: { code: "LOCK_TIMEOUT" } } });
    expect(applyTransition(deploying(), { kind: "AGENT_NOT_STARTED", dispatchToken: "tok-1", v3Valid: false, now: T, nextAttemptAt: T })).toMatchObject({ transitionId: "X15", next: { error: { code: "DEPLOY_WINDOW_CLOSED" } } });
  });

  it("AGENT_NOT_STARTED is refused once the command is known to have started, and for another dispatch", () => {
    expect(applyTransition(deploying({ execStartedAt: T }), { kind: "AGENT_NOT_STARTED", dispatchToken: "tok-1", v3Valid: true, now: T, nextAttemptAt: T }).accepted).toBe(false);
    expect(applyTransition(deploying(), { kind: "AGENT_NOT_STARTED", dispatchToken: "tok-OLD", v3Valid: true, now: T, nextAttemptAt: T }).accepted).toBe(false);
  });

  it("FAIL_BEFORE_EXEC accepts the two agent causes (X11), still only before exec", () => {
    for (const code of ["AGENT_REJECTED", "AGENT_DISPATCH_FAILED"] as const) {
      expect(applyTransition(deploying(), { kind: "FAIL_BEFORE_EXEC", dispatchToken: "tok-1", code })).toMatchObject({ transitionId: "X11", next: { status: "FAILED", error: { code } } });
    }
    expect(applyTransition(deploying({ execStartedAt: T }), { kind: "FAIL_BEFORE_EXEC", dispatchToken: "tok-1", code: "AGENT_REJECTED" }).accepted).toBe(false);
  });

  it("AGENT_UNKNOWN is X16 even without execStartedAt (silence cannot prove that nothing started)", () => {
    expect(applyTransition(deploying(), { kind: "AGENT_UNKNOWN", dispatchToken: "tok-1" })).toMatchObject({ transitionId: "X16", next: { status: "UNKNOWN_TARGET_STATE" }, effects: { appendTargetUnresolved: true } });
  });

  it("the reconciler rule becomes X16 for silent agent dispatches and stays X11 DISPATCH_INTERRUPTED for SSH", () => {
    const overdue = deploying({ deadlineAt: T - 1 });
    expect(applyTransition(overdue, { kind: "RECONCILE_OVERDUE_DEPLOYING", now: T, silenceIsUnknown: true })).toMatchObject({ transitionId: "X16" });
    expect(applyTransition(overdue, { kind: "RECONCILE_OVERDUE_DEPLOYING", now: T })).toMatchObject({ transitionId: "X11", next: { error: { code: "DISPATCH_INTERRUPTED" } } });
  });

  it("terminal states are immutable for every agent request", () => {
    for (const status of ["SUCCEEDED", "FAILED", "UNKNOWN_TARGET_STATE"] as const) {
      const s = deploying({ status });
      expect(applyTransition(s, { kind: "AGENT_UNKNOWN", dispatchToken: "tok-1" }).accepted).toBe(false);
      expect(applyTransition(s, { kind: "AGENT_NOT_STARTED", dispatchToken: "tok-1", v3Valid: true, now: T, nextAttemptAt: T }).accepted).toBe(false);
    }
  });
});

describe("configuration of the agent transport (optional, both values or none)", () => {
  const url = "https://queue.example.invalid/<AWS_ACCOUNT_ID>/cicd-agent-results-dev.fifo";

  it("is off by default: the existing Executor configuration is unchanged", () => {
    expect(loadConfig(validEnv()).agentTransport).toBeUndefined();
  });

  it("is on with a FIFO results queue and a log bucket", () => {
    expect(loadConfig(validEnv({ CICD_AGENT_RESULTS_QUEUE_URL: url, CICD_AGENT_LOG_BUCKET: "example-logs-dev" })).agentTransport).toEqual({ resultsQueueUrl: url, logBucket: "example-logs-dev" });
  });

  it.each([
    ["only the queue", { CICD_AGENT_RESULTS_QUEUE_URL: url }],
    ["only the bucket", { CICD_AGENT_LOG_BUCKET: "example-logs-dev" }],
    ["a standard queue", { CICD_AGENT_RESULTS_QUEUE_URL: url.replace(".fifo", ""), CICD_AGENT_LOG_BUCKET: "example-logs-dev" }],
    ["an invalid bucket", { CICD_AGENT_RESULTS_QUEUE_URL: url, CICD_AGENT_LOG_BUCKET: "Not_A_Bucket" }],
  ])("refuses %s", (_label, over) => {
    expect(() => loadConfig(validEnv(over))).toThrowError(ConfigError);
  });
});

describe("results queue handler: acknowledgement rules", () => {
  function handlerWith(outcome: AgentEventOutcome) {
    const seen: { roleId: string | undefined }[] = [];
    const outcomes: string[] = [];
    const handle = createAgentResultsHandler({
      agent: {
        applyEvent: async (_body, roleId) => {
          seen.push({ roleId });
          return outcome;
        },
        applyHeartbeat: async () => "RECORDED",
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      onOutcome: (executionId) => outcomes.push(executionId),
    });
    return { handle, seen, outcomes };
  }
  const event = (id = "m-1", senderId: string | undefined = "AROAFAKEAGENTROLE0001:i-0example") => ({
    messageId: id,
    body: JSON.stringify({ type: "AGENT_EVENT", executionId: "example-app-dev-1" }),
    ...(senderId === undefined ? {} : { senderId }),
    approximateReceiveCount: 1,
  });

  it("passes the role id of the SenderId (never the session) to the transport", async () => {
    const { handle, seen } = handlerWith({ outcome: "PROGRESS" });
    await handle(event());
    expect(seen).toEqual([{ roleId: "AROAFAKEAGENTROLE0001" }]);
  });

  it("does NOT acknowledge a RETRY: SQS redelivers and the event is re-applied on fresh state", async () => {
    expect(await handlerWith({ outcome: "RETRY" }).handle(event())).toEqual({ ack: false });
  });

  it.each([
    { outcome: "PROGRESS" },
    { outcome: "DUPLICATE" },
    { outcome: "LATE" },
    { outcome: "NOT_EVIDENCE" },
    { outcome: "REFUSED", reason: "SENDER_NOT_THE_TARGET_AGENT" },
    { outcome: "INVALID", problems: ["x"] },
    { outcome: "OPERATOR_REQUIRED" },
  ] as AgentEventOutcome[])("acknowledges %o (state and audit are in DynamoDB)", async (outcome) => {
    expect(await handlerWith(outcome).handle(event())).toEqual({ ack: true });
  });

  it("announces closings and hold releases for notifications", async () => {
    const closed = handlerWith({ outcome: "CLOSED", transitionId: "X12", status: "SUCCEEDED" });
    await closed.handle(event());
    expect(closed.outcomes).toEqual(["example-app-dev-1"]);
    const released = handlerWith({ outcome: "HOLD_RELEASED" });
    await released.handle(event());
    expect(released.outcomes).toEqual(["example-app-dev-1"]);
  });

  it("leaves unparseable or unknown messages for the dead-letter queue", async () => {
    const { handle } = handlerWith({ outcome: "PROGRESS" });
    expect(await handle({ messageId: "x", body: "{not json", approximateReceiveCount: 1 })).toEqual({ ack: false });
    expect(await handle({ messageId: "y", body: JSON.stringify({ type: "SOMETHING" }), approximateReceiveCount: 1 })).toEqual({ ack: false });
  });
});
