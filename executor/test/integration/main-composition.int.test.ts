// @akili-spec changes/cicd-executor-poc design §3.3, §7 (main), §6.6, DD-25; requirements FR-04, FR-05, FR-12, FR-14, FR-15, FR-21
// N-17b: boots the composition root (`bootstrap`) on REAL DynamoDB Local repositories with the real bundled
// definitions, a FAKE transport and an in-memory loopback queue, and drives one DEPLOY_REQUESTED all the way to
// SUCCEEDED and one rejection. Asserts the notifications (and their logs link), `senderRef` and the
// delivered-script checksum persisted on the execution, and the TargetOrderingPort on the real repository.
import { randomUUID } from "node:crypto";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { buildCreateTableInput } from "../../src/adapters/dynamodb-state-store/table-schema.js";
import { beforeAll, describe, expect, test } from "vitest";
import { DedupeRepository } from "../../src/adapters/dynamodb-state-store/dedupe-repository.js";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { RejectionRepository } from "../../src/adapters/dynamodb-state-store/rejection-repository.js";
import { TargetStateRepository } from "../../src/adapters/dynamodb-state-store/target-state-repository.js";
import { createTargetOrderingPort } from "../../src/composition/adapters.js";
import { bootstrap } from "../../src/main/bootstrap.js";
import type { InboundMessage } from "../../src/inbound/sqs-consumer/index.js";
import type { ScriptExecRequest } from "../../src/ports/deploy-transport.js";
import {
  CI_ROLE,
  OPERATOR_ROLE,
  SCHEDULER_ROLE,
  LoopbackQueue,
  RecordingProvider,
  bundledDefinitions,
  fakeSecrets,
  successfulTransport,
  validEnv,
} from "../support/composition-fixtures.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

const DEPLOYMENT_ID = "prms-reporting-dev";
const LOCK_KEY = "deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit";
const WORKFLOW = "resolved-workflow";

function deployRequest(runId: string, runNumber: number): Record<string, unknown> {
  return {
    specVersion: 1,
    eventType: "DEPLOY_REQUESTED",
    requestId: `${runId}-1`,
    deploymentId: DEPLOYMENT_ID,
    commitSha: "a".repeat(40),
    artifacts: { server: `sha256:${"b".repeat(64)}`, client: `sha256:${"c".repeat(64)}` },
    ci: { repository: "example-org/example-app", workflowRef: WORKFLOW, runId, runAttempt: 1, runNumber },
  };
}

const message = (id: string, body: unknown, senderId?: string): InboundMessage => ({
  messageId: id,
  body: JSON.stringify(body),
  ...(senderId === undefined ? {} : { senderId }),
  approximateReceiveCount: 1,
});

describe.skipIf(!dynamoDbLocalAvailable())("composition root on DynamoDB Local (N-17b)", () => {
  beforeAll(async () => {
    await ensureTestTable();
  });

  async function boot(clock?: { now(): Date }, table: string = testTableName()) {
    const client = createTestDocumentClient();
    const queue = new LoopbackQueue();
    const provider = new RecordingProvider();
    const execCalls: ScriptExecRequest[] = [];
    const logLines: string[] = [];
    const metricLines: string[] = [];
    const health: string[] = [];
    const order: string[] = [];
    let flushed = false;
    const executor = await bootstrap({
      env: validEnv({ CICD_TABLE_NAME: table, CICD_SSH_CONCURRENCY: "1" }),
      secrets: fakeSecrets(),
      ...(clock === undefined ? {} : { clock }),
      definitions: bundledDefinitions(),
      documentClient: client,
      publisher: queue,
      notificationProviders: [provider],
      createTransport: (hooks) => successfulTransport(hooks, execCalls),
      createConsumer: () => ({ start: async () => void order.push("consumer.start"), stop: async () => void order.push("consumer.stop") }),
      logSink: { write: (l) => void logLines.push(l), flush: () => void (flushed = true) },
      metricsSink: { write: (l) => void metricLines.push(l) },
      healthcheckWriter: { write: (_p, c) => void health.push(c) },
    });
    return { client, queue, provider, execCalls, logLines, metricLines, health, order, executor, flushed: () => flushed };
  }

  async function openWindow(h: Awaited<ReturnType<typeof boot>>): Promise<void> {
    const result = await h.executor.handle(
      message(
        "open-1",
        {
          specVersion: 1,
          eventId: randomUUID(),
          eventType: "DEPLOY_WINDOW_OPEN_REQUESTED",
          timestamp: new Date().toISOString(),
          source: "operator",
          lockKey: LOCK_KEY,
          openedBy: "operator-1",
          externalJobsDisabled: ["<JENKINS_JOB_A>", "<JENKINS_JOB_B>"],
          closesAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        `${OPERATOR_ROLE}:session`,
      ),
    );
    expect(result.ack).toBe(true);
  }

  test("DEPLOY_REQUESTED runs to SUCCEEDED: notifications with logs link, senderRef and script checksum persisted (FR-12, FR-14, FR-21)", async () => {
    const h = await boot();
    await openWindow(h);
    const runId = String(Date.now());
    const sent = await h.executor.handle(message("m-1", deployRequest(runId, Math.floor(Date.now() / 1000)), `${CI_ROLE}:some-session`));
    expect(sent.ack).toBe(true);
    await h.queue.drain(h.executor.handle);

    const dedupe = await new DedupeRepository(h.client, testTableName()).get(DEPLOYMENT_ID, `${runId}-1`);
    expect(dedupe?.executionId).toBeDefined();
    const executionId = dedupe!.executionId!;
    const item = await new ExecutionRepository(h.client, testTableName()).get(executionId);
    expect(item?.status).toBe("SUCCEEDED");
    expect(item?.senderRef).toBe(CI_ROLE); // role-ID prefix only, never the session suffix
    expect(item?.scriptChecksum).toBe("f".repeat(64));
    expect(item?.slackThreadTs).toBe("1700000000.000100");

    expect(h.provider.events.map((e) => e.kind)).toEqual(["ACCEPTED", "SUCCEEDED"]);
    const logsUrl = `https://logs.example.invalid/search?q=${encodeURIComponent(executionId)}`;
    for (const event of h.provider.events) {
      expect(event.message).toContain(logsUrl);
      expect(event.channelRef).toBe("<PRMS_REPORTING_SLACK_CHANNEL_REF>");
      expect(event.executionId).toBe(executionId);
    }
    expect(h.provider.events[1]?.threadRef).toBe("1700000000.000100");

    // The script was invoked with an argument vector; the runtime secret travels as the opaque reference (OD-Q5), never resolved.
    expect(h.execCalls).toHaveLength(1);
    const args = h.execCalls[0]!.args;
    expect(args).toContain(`server-container=server-repo@sha256:${"b".repeat(64)}`);
    expect(args.join(" ")).toContain("--runtime-secret server-container=<PRMS_REPORTING_SERVER_RUNTIME_SECRET_REF>");
    expect(h.metricLines.join("\n")).toContain("ExecutionsSucceeded");
  });

  test("a DEPLOY_REQUESTED from the wrong principal is REJECTED once: record with senderRef, platform-channel notification, single count (FR-21)", async () => {
    const h = await boot();
    const runId = String(Date.now() + 1);
    const sent = await h.executor.handle(message("m-rej-1", deployRequest(runId, 5), "WRONGROLE:evil-session"));
    expect(sent.ack).toBe(true);

    const record = await new RejectionRepository(h.client, testTableName()).get({ deploymentId: DEPLOYMENT_ID, requestId: `${runId}-1` });
    expect(record).toMatchObject({ reason: "UNAUTHORIZED_SENDER", senderRef: "WRONGROLE" });
    expect(h.provider.events).toHaveLength(1);
    expect(h.provider.events[0]).toMatchObject({ kind: "REJECTED", channelRef: "<PLATFORM_SLACK_CHANNEL_REF>" });
    expect(h.provider.events[0]?.message).toContain("WRONGROLE");
    expect(h.provider.events[0]?.message).not.toContain("evil-session");
    // The authorizer counts UNAUTHORIZED_SENDER; the handler must not count it again.
    expect(h.metricLines.filter((l) => l.includes("RejectedRequests"))).toHaveLength(1);

    // A body with no usable identifiers is keyed by the SQS message id (REJECT#MSG#).
    const garbage = await h.executor.handle(message("m-rej-2", { eventType: "DEPLOY_REQUESTED", deploymentId: 7 }, "WRONGROLE:s"));
    expect(garbage.ack).toBe(true);
    expect(await new RejectionRepository(h.client, testTableName()).get({ sqsMessageId: "m-rej-2" })).toMatchObject({ senderRef: "WRONGROLE" });
  });

  test("restart resumes from persisted state: a fresh instance re-drives a WAITING_LOCK execution through the reconciler to SUCCEEDED (not queue redelivery)", async () => {
    // A table of its own: the reconcile tick sweeps EVERY overdue item, and other suites leave synthetic ones in the shared table.
    const table = `cicd-restart-${randomUUID().slice(0, 8)}`;
    const raw = new DynamoDBClient({ region: "us-east-1", endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT });
    await raw.send(new CreateTableCommand(buildCreateTableInput(table)));
    raw.destroy();
    const first = await boot(undefined, table);
    await openWindow(first);
    const runId = String(Date.now() + 2);
    await first.executor.handle(message("m-restart", deployRequest(runId, Math.floor(Date.now() / 1000) + 10), `${CI_ROLE}:s`));
    // Crash: the first instance and its queue (holding the LOCK_RETRY_REQUESTED) vanish; only DynamoDB survives.
    expect(first.queue.published).toHaveLength(1);
    const executionId = (await new DedupeRepository(first.client, table).get(DEPLOYMENT_ID, `${runId}-1`))!.executionId!;
    expect((await new ExecutionRepository(first.client, table).get(executionId))?.status).toBe("WAITING_LOCK");

    const later = { now: () => new Date(Date.now() + 10 * 60_000) };
    const second = await boot(later, table);
    const tick = await second.executor.handle(
      message("tick-1", { specVersion: 1, eventType: "RECONCILE_TICK", timestamp: later.now().toISOString(), source: "scheduler" }, `${SCHEDULER_ROLE}:s`),
    );
    expect(tick.ack).toBe(true);
    await second.queue.drain(second.executor.handle);
    expect((await new ExecutionRepository(second.client, table).get(executionId))?.status).toBe("SUCCEEDED");
    expect(second.execCalls).toHaveLength(1);
  });

  async function freshTable(): Promise<string> {
    const table = `cicd-n17-${randomUUID().slice(0, 8)}`;
    const raw = new DynamoDBClient({ region: "us-east-1", endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT });
    await raw.send(new CreateTableCommand(buildCreateTableInput(table)));
    raw.destroy();
    return table;
  }

  test("a fresh instance on a RECONCILE_TICK after the lock-wait budget stores FAILED/LOCK_TIMEOUT AND notifies LOCK_TIMEOUT in the thread with the logs link (FR-15, FR-14)", async () => {
    const table = await freshTable();
    const first = await boot(undefined, table);
    await openWindow(first);
    const runId = String(Date.now() + 3);
    await first.executor.handle(message("m-lt", deployRequest(runId, Math.floor(Date.now() / 1000) + 20), `${CI_ROLE}:s`));
    const executionId = (await new DedupeRepository(first.client, table).get(DEPLOYMENT_ID, `${runId}-1`))!.executionId!;
    expect(first.provider.events.map((e) => e.kind)).toEqual(["ACCEPTED"]);

    const later = { now: () => new Date(Date.now() + 31 * 60_000) }; // beyond the 1,800 s budget
    const second = await boot(later, table);
    await second.executor.handle(
      message("tick-lt", { specVersion: 1, eventType: "RECONCILE_TICK", timestamp: later.now().toISOString(), source: "scheduler" }, `${SCHEDULER_ROLE}:s`),
    );
    const item = await new ExecutionRepository(second.client, table).get(executionId);
    expect(item).toMatchObject({ status: "FAILED", error: { code: "LOCK_TIMEOUT" } });
    expect(second.provider.events).toHaveLength(1);
    expect(second.provider.events[0]).toMatchObject({ kind: "LOCK_TIMEOUT", executionId, threadRef: "1700000000.000100" });
    expect(second.provider.events[0]?.message).toContain(`https://logs.example.invalid/search?q=${encodeURIComponent(executionId)}`);
    expect(second.execCalls).toHaveLength(0);
  });

  test("an older run accepted after a newer one is SUPERSEDED at S1: stored and notified (design §7.3 X3)", async () => {
    const table = await freshTable();
    const h = await boot(undefined, table);
    await openWindow(h);
    const base = Math.floor(Date.now() / 1000);
    const newer = String(Date.now() + 4);
    const older = String(Date.now() + 5);
    await h.executor.handle(message("m-new", deployRequest(newer, base + 100), `${CI_ROLE}:s`));
    await h.executor.handle(message("m-old", deployRequest(older, base + 50), `${CI_ROLE}:s`));
    const oldId = (await new DedupeRepository(h.client, table).get(DEPLOYMENT_ID, `${older}-1`))!.executionId!;
    expect((await new ExecutionRepository(h.client, table).get(oldId))?.status).toBe("SUPERSEDED");
    expect(h.provider.events.filter((e) => e.executionId === oldId).map((e) => e.kind)).toEqual(["ACCEPTED", "SUPERSEDED"]);
  });

  test("heartbeat writes the healthcheck file on start and shutdown is ordered: consumer stop, then log flush (design §12)", async () => {
    const h = await boot();
    await h.executor.start();
    expect(h.health.length).toBeGreaterThan(0);
    expect(JSON.parse(h.health[0]!)).toHaveProperty("lastHeartbeatAt");
    await h.executor.stop();
    await h.executor.stop(); // idempotent
    // 1 SSH slot + 2 reserved pollers (NFR-04), all stopped before logs are flushed.
    expect(h.order).toEqual(Array(3).fill("consumer.start").concat(Array(3).fill("consumer.stop")));
    expect(h.flushed()).toBe(true);
  });

  test("TargetOrderingPort over the real TargetStateRepository: raised -> accepted, older -> STORED_IS_NEWER, readOrdering from get()", async () => {
    const client = createTestDocumentClient();
    const port = createTargetOrderingPort({ targets: new TargetStateRepository(client, testTableName()), clock: { now: () => new Date() } });
    const lockKey = `lock-${randomUUID()}`;
    expect(await port.readOrdering(lockKey)).toEqual({});
    const sourceRef = "repository=r;workflow=w;environment=e";
    expect(await port.raiseHighestAccepted(lockKey, { sourceRef, runNumber: 5, executionId: "e-5" })).toMatchObject({ accepted: true });
    expect(await port.raiseHighestAccepted(lockKey, { sourceRef, runNumber: 3, executionId: "e-3" })).toEqual({ accepted: false, reason: "STORED_IS_NEWER" });
    expect(await port.readOrdering(lockKey)).toEqual({ highestAccepted: { sourceRef, runNumber: 5, executionId: "e-5" } });
  });
});
