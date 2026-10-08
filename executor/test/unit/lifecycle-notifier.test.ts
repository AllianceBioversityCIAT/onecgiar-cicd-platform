// @akili-spec changes/cicd-executor-poc design §6.6, §7.3; requirements FR-14, FR-15; tasks R-4 (AC-02 V1: platform channel, targetId)
// Table-driven: every terminal status / error code maps to its notification kind, in the Slack thread, with the logs link.
import { describe, expect, it } from "vitest";
import { createLifecycleNotifier } from "../../src/composition/lifecycle-notifier.js";
import { createPendingTasks } from "../../src/composition/pending-tasks.js";
import type { NotificationInput } from "../../src/application/notification-service/index.js";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";

const LOGS = (id: string): string => `https://logs.example.invalid/search?q=${id}`;
const RUNBOOK = "https://runbook.example.invalid/unknown-target-state";

function setup(item: Partial<ExecutionItem>) {
  const sent: NotificationInput[] = [];
  const full = {
    executionId: "dep-1-7",
    targetId: "dep-1",
    commitSha: "a".repeat(40),
    ci: { repository: "example-org/example-app", runId: "10", workflowRef: "w" },
    startedAt: 1000,
    finishedAt: 5000,
    slackThreadTs: "1700000000.000100",
    ...item,
  } as ExecutionItem;
  const metricCalls: string[] = [];
  const notifier = createLifecycleNotifier({
    notifications: { notify: async (i) => (sent.push(i), {}) },
    executions: { get: async () => full, setAuditOnce: async () => true },
    platformSlack: { channelRef: "<PLATFORM_CH>", tokenRef: "<PLATFORM_TOK>" },
    logsUrlTemplate: "https://logs.example.invalid/search?q={executionId}",
    runbookUrl: RUNBOOK,
    metrics: {
      recordExecutionStarted: () => void metricCalls.push("started"),
      recordExecutionSucceeded: () => void metricCalls.push("succeeded"),
      recordExecutionFailed: () => void metricCalls.push("failed"),
    },
    logger: { withContext: () => undefined as never, debug() {}, info() {}, warn() {}, error() {} },
    pending: createPendingTasks(),
  });
  return { notifier, sent, metricCalls };
}

const cases: Array<[string, Partial<ExecutionItem>, string, Record<string, unknown>]> = [
  ["SUPERSEDED", { status: "SUPERSEDED", error: { code: "SUPERSEDED" } }, "SUPERSEDED", {}],
  ["DEPLOY_WINDOW_CLOSED", { status: "FAILED", error: { code: "DEPLOY_WINDOW_CLOSED" } }, "DEPLOY_WINDOW_CLOSED", {}],
  ["LOCK_TIMEOUT", { status: "FAILED", error: { code: "LOCK_TIMEOUT" } }, "LOCK_TIMEOUT", {}],
  ["PULL", { status: "FAILED", error: { code: "PULL" } }, "DEPLOY_FAILED", { code: "PULL" }],
  ["MIGRATION", { status: "FAILED", error: { code: "MIGRATION" } }, "DEPLOY_FAILED", { code: "MIGRATION" }],
  ["START", { status: "FAILED", error: { code: "START" } }, "DEPLOY_FAILED", { code: "START" }],
  ["HEALTH", { status: "FAILED", error: { code: "HEALTH" } }, "DEPLOY_FAILED", { code: "HEALTH" }],
  ["SSH_CONNECT", { status: "FAILED", error: { code: "SSH_CONNECT" } }, "DEPLOY_FAILED", { code: "SSH_CONNECT" }],
  ["DISPATCH_INTERRUPTED", { status: "FAILED", error: { code: "DISPATCH_INTERRUPTED" } }, "DEPLOY_FAILED", { code: "DISPATCH_INTERRUPTED" }],
  ["UNKNOWN_TARGET_STATE", { status: "UNKNOWN_TARGET_STATE", error: { code: "UNKNOWN_TARGET_STATE" } }, "UNKNOWN_TARGET_STATE", { runbookUrl: RUNBOOK }],
  ["SUCCEEDED", { status: "SUCCEEDED" }, "SUCCEEDED", {}],
];

describe("lifecycle notifier: terminal outcomes (FR-15, FR-14, design §6.6)", () => {
  it.each(cases)("%s -> %s in the thread, with logs link and duration", async (_label, item, kind, extra) => {
    const { notifier, sent } = setup(item);
    await notifier.outcome("dep-1-7");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind, threadRef: "1700000000.000100", logsUrl: LOGS("dep-1-7"), durationMs: 4000, destination: { channelRef: "<PLATFORM_CH>", tokenRef: "<PLATFORM_TOK>" }, targetId: "dep-1", ...extra });
  });

  it("non-terminal statuses notify nothing", async () => {
    const { notifier, sent } = setup({ status: "WAITING_LOCK" });
    await notifier.outcome("dep-1-7");
    expect(sent).toEqual([]);
  });

  it("REJECTED goes to the platform channel with the rejection identity and sender reference only", async () => {
    const { notifier, sent } = setup({});
    await notifier.rejected({ rejectionId: "MSG#abc", reason: "SCHEMA_INVALID", senderRef: "ROLEX" });
    expect(sent[0]).toEqual({ kind: "REJECTED", rejectionId: "MSG#abc", reason: "SCHEMA_INVALID", senderRef: "ROLEX", destination: { channelRef: "<PLATFORM_CH>", tokenRef: "<PLATFORM_TOK>" } });
  });

  it("counts success and failure metrics", async () => {
    const ok = setup({ status: "SUCCEEDED" });
    await ok.notifier.outcome("dep-1-7");
    const bad = setup({ status: "UNKNOWN_TARGET_STATE" });
    await bad.notifier.outcome("dep-1-7");
    expect([ok.metricCalls, bad.metricCalls]).toEqual([["succeeded"], ["failed"]]);
  });
});
