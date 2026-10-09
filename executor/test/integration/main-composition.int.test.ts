// @akili-spec changes/cicd-executor-poc design §1.2, §3.3, §5.1, §6.3, §6.5, §6.6, §7 (main), DD-25; requirements FR-02, FR-04, FR-05, FR-12, FR-14, FR-15, FR-21, FR-23; tasks R-4, R-5 (AC-02 V1)
// Boots the composition root (`bootstrap`) on REAL DynamoDB Local repositories, a REAL Target Registry table
// (`cicd-registry-<stage>` shape, read through the R-3 adapter), a FAKE transport and an in-memory loopback
// queue. Drives DEPLOY_REQUESTED all the way to SUCCEEDED from the target snapshot, and the AC-02 V1 rejections:
// wrong principal, unknown target and a request from another repository (option A), which must leave NO trace
// on the target's operational state. The definitions are still validated at startup until R-6; they are not
// used by the request or deploy path.
import { randomUUID } from "node:crypto";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { buildCreateTableInput } from "../../src/adapters/dynamodb-state-store/table-schema.js";
import { beforeAll, describe, expect, test } from "vitest";
import { DedupeRepository } from "../../src/adapters/dynamodb-state-store/dedupe-repository.js";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { RejectionRepository } from "../../src/adapters/dynamodb-state-store/rejection-repository.js";
import { TargetStateRepository } from "../../src/adapters/dynamodb-state-store/target-state-repository.js";
import { dedupeKey, lockKeyOf, sequenceKey, targetStateKey, deployWindowKey } from "../../src/adapters/dynamodb-state-store/keys.js";
import { createTargetOrderingPort } from "../../src/composition/adapters.js";
import { bootstrap } from "../../src/main/bootstrap.js";
import type { InboundMessage } from "../../src/inbound/sqs-consumer/index.js";
import type { ScriptExecRequest, SshTarget } from "../../src/ports/deploy-transport.js";
import type { SecretProvider } from "../../src/ports/secret-provider.js";
import {
  CI_ROLE,
  OPERATOR_ROLE,
  SCHEDULER_ROLE,
  LoopbackQueue,
  RecordingProvider,
  bundledSchemas,
  fakeSecrets,
  successfulTransport,
  validEnv,
} from "../support/composition-fixtures.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, requireLocalDynamoEndpoint, testTableName } from "./setup.js";

const TARGET_ID = "example-app-dev";
const REPO_ID = "123456789";
const OTHER_REPO_ID = "987654321";
const WORKFLOW = "example-org/example-app/.github/workflows/deploy.yml@refs/heads/main";
const REGISTRY_TABLE = `cicd-registry-it-${randomUUID().slice(0, 8)}`;
const CI_SENDER = `${CI_ROLE}:${REPO_ID}`;

const targetRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  targetId: TARGET_ID,
  project: "example",
  environment: "dev",
  host: "target.example.internal",
  port: 2222,
  user: "deploy",
  hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
  credentialRef: "cicd-poc/dev/example-app-dev/ssh",
  deployScript: "/opt/cicd/example-app/deploy.sh",
  deployWindowPolicy: "required",
  sourceRepositoryId: REPO_ID,
  schemaVersion: 1,
  version: 1,
  updatedAt: "2026-10-07T12:00:00Z",
  updatedBy: "platform-admin",
  ...over,
});

function deployRequest(runId: string, runNumber: number, targetId = TARGET_ID): Record<string, unknown> {
  return {
    specVersion: 1,
    eventType: "DEPLOY_REQUESTED",
    requestId: `${runId}-1`,
    targetId,
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

async function createRegistryTable(): Promise<void> {
  const raw = new DynamoDBClient({ region: "us-east-1", endpoint: requireLocalDynamoEndpoint() });
  await raw.send(
    new CreateTableCommand({
      TableName: REGISTRY_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  raw.destroy();
}

async function putTarget(client: DynamoDBDocumentClient, record: Record<string, unknown>): Promise<void> {
  await client.send(new PutCommand({ TableName: REGISTRY_TABLE, Item: { pk: `TARGET#${String(record["targetId"])}`, sk: "META", ...record } }));
}

/** Records every secret read so a test can prove the target's credential was never read. */
class RecordingSecrets implements SecretProvider {
  public readonly reads: string[] = [];
  public constructor(private readonly inner: SecretProvider) {}
  public async getSecret(ref: string): Promise<string> {
    this.reads.push(ref);
    return this.inner.getSecret(ref);
  }
  public async exists(ref: string): Promise<boolean> {
    this.reads.push(`exists:${ref}`);
    return this.inner.exists(ref);
  }
}

async function rawItem(client: DynamoDBDocumentClient, table: string, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return (await client.send(new GetCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk } }))).Item;
}

describe.skipIf(!dynamoDbLocalAvailable())("composition root on DynamoDB Local (AC-02 V1)", () => {
  beforeAll(async () => {
    await ensureTestTable();
    await createRegistryTable();
    const client = createTestDocumentClient();
    await putTarget(client, targetRecord());
    client.destroy();
  });

  async function boot(clock?: { now(): Date }, table: string = testTableName()) {
    const client = createTestDocumentClient();
    const secrets = new RecordingSecrets(fakeSecrets());
    const queue = new LoopbackQueue();
    const provider = new RecordingProvider();
    const execCalls: ScriptExecRequest[] = [];
    const sshTargets: SshTarget[] = [];
    const logLines: string[] = [];
    const metricLines: string[] = [];
    const health: string[] = [];
    const order: string[] = [];
    let flushed = false;
    const executor = await bootstrap({
      env: validEnv({ CICD_TABLE_NAME: table, CICD_REGISTRY_TABLE_NAME: REGISTRY_TABLE, CICD_SSH_CONCURRENCY: "1" }),
      secrets,
      ...(clock === undefined ? {} : { clock }),
      schemas: bundledSchemas(),
      documentClient: client,
      publisher: queue,
      notificationProviders: [provider],
      createTransport: () => successfulTransport(execCalls, undefined, sshTargets),
      createConsumer: () => ({ start: async () => void order.push("consumer.start"), stop: async () => void order.push("consumer.stop") }),
      logSink: { write: (l) => void logLines.push(l), flush: () => void (flushed = true) },
      metricsSink: { write: (l) => void metricLines.push(l) },
      healthcheckWriter: { write: (_p, c) => void health.push(c) },
    });
    return { client, queue, provider, secrets, execCalls, sshTargets, logLines, metricLines, health, order, executor, flushed: () => flushed };
  }

  async function openWindow(h: Awaited<ReturnType<typeof boot>>): Promise<void> {
    const result = await h.executor.handle(
      message(
        `open-${randomUUID()}`,
        {
          specVersion: 1,
          eventId: randomUUID(),
          eventType: "DEPLOY_WINDOW_OPEN_REQUESTED",
          timestamp: new Date().toISOString(),
          source: "operator",
          targetId: TARGET_ID,
          openedBy: "operator-1",
          externalJobsDisabled: ["<JENKINS_JOB_A>", "<JENKINS_JOB_B>"],
          closesAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        `${OPERATOR_ROLE}:session`,
      ),
    );
    expect(result.ack).toBe(true);
  }

  async function freshTable(): Promise<string> {
    const table = `cicd-n17-${randomUUID().slice(0, 8)}`;
    const raw = new DynamoDBClient({ region: "us-east-1", endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT });
    await raw.send(new CreateTableCommand(buildCreateTableInput(table)));
    raw.destroy();
    return table;
  }

  test("DEPLOY_REQUESTED runs to SUCCEEDED from the target snapshot: script on the target, fixed argument vector, platform channel (FR-02, FR-12, FR-14, FR-21)", async () => {
    const table = await freshTable();
    const h = await boot(undefined, table);
    await openWindow(h);
    const runId = String(Date.now());
    const sent = await h.executor.handle(message("m-1", deployRequest(runId, Math.floor(Date.now() / 1000)), CI_SENDER));
    expect(sent.ack).toBe(true);
    await h.queue.drain(h.executor.handle);

    const dedupe = await new DedupeRepository(h.client, table).get(TARGET_ID, `${runId}-1`);
    const executionId = dedupe!.executionId!;
    expect(executionId).toBe(`${TARGET_ID}-1`);
    const item = await new ExecutionRepository(h.client, table).get(executionId);
    expect(item?.status).toBe("SUCCEEDED");
    expect(item?.senderRef).toBe(CI_ROLE); // role-ID prefix only, never the session suffix
    expect(item?.targetSnapshot).toMatchObject({ version: 1, host: "target.example.internal", port: 2222, deployScript: "/opt/cicd/example-app/deploy.sh", sourceRepositoryId: REPO_ID });
    expect(item?.slackThreadTs).toBe("1700000000.000100");

    expect(h.provider.events.map((e) => e.kind)).toEqual(["ACCEPTED", "SUCCEEDED"]);
    const logsUrl = `https://logs.example.invalid/search?q=${encodeURIComponent(executionId)}`;
    for (const event of h.provider.events) {
      expect(event.message).toContain(logsUrl);
      expect(event.message).toContain(`target ${TARGET_ID}`);
      expect(event.channelRef).toBe("<PLATFORM_SLACK_CHANNEL_REF>");
    }

    expect(h.sshTargets).toEqual([
      {
        targetId: TARGET_ID,
        host: "target.example.internal",
        port: 2222,
        user: "deploy",
        hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
        credentialRef: "cicd-poc/dev/example-app-dev/ssh",
      },
    ]);
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0]).toMatchObject({ scriptPath: "/opt/cicd/example-app/deploy.sh", executionId });
    expect(h.execCalls[0]!.args).toEqual([
      "--target-id", TARGET_ID,
      "--execution-id", executionId,
      "--fencing-token", "1",
      "--commit-sha", "a".repeat(40),
      "--artifact", `client=sha256:${"c".repeat(64)}`,
      "--artifact", `server=sha256:${"b".repeat(64)}`,
    ]);
    expect(h.metricLines.join("\n")).toContain("ExecutionsSucceeded");
  });

  test("AC-03: a target in scriptArguments none runs its script with NO argument for a request without artifacts; the version is recorded as not guaranteed (G-D1, G-D3, G-D7)", async () => {
    const table = await freshTable();
    const h = await boot(undefined, table);
    const target = "example-noargs-dev";
    await putTarget(h.client, targetRecord({ targetId: target, scriptArguments: "none", deployWindowPolicy: "not-required", deployScript: "/opt/cicd/scripts/deploy-example-noargs-dev.sh" }));
    const runId = String(Date.now() + 21);
    const body = deployRequest(runId, Math.floor(Date.now() / 1000), target);
    delete body["artifacts"];
    expect((await h.executor.handle(message("m-none-1", body, CI_SENDER))).ack).toBe(true);
    await h.queue.drain(h.executor.handle);

    const dedupe = await new DedupeRepository(h.client, table).get(target, `${runId}-1`);
    const item = await new ExecutionRepository(h.client, table).get(dedupe!.executionId!);
    expect(item).toMatchObject({ status: "SUCCEEDED", artifacts: {}, versionCheck: "NOT_REPORTED", versionGuaranteed: false });
    expect(item?.targetSnapshot.scriptArguments).toBe("none");
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0]).toMatchObject({ scriptPath: "/opt/cicd/scripts/deploy-example-noargs-dev.sh", args: [] });
    const success = h.provider.events.find((e) => e.kind === "SUCCEEDED");
    expect(success?.message).toContain("version not verified");
    expect(success?.message).toContain("not guaranteed");
  });

  test("a DEPLOY_REQUESTED from the wrong principal is REJECTED once under REJECT#MSG#: senderRef, platform channel, single count (FR-21)", async () => {
    const h = await boot();
    const runId = String(Date.now() + 1);
    expect((await h.executor.handle(message("m-rej-1", deployRequest(runId, 5), "WRONGROLE:evil-session"))).ack).toBe(true);

    const record = await new RejectionRepository(h.client, testTableName()).get({ sqsMessageId: "m-rej-1" });
    expect(record).toMatchObject({ reason: "UNAUTHORIZED_SENDER", senderRef: "WRONGROLE", targetId: TARGET_ID });
    expect(h.provider.events).toHaveLength(1);
    expect(h.provider.events[0]).toMatchObject({ kind: "REJECTED", channelRef: "<PLATFORM_SLACK_CHANNEL_REF>" });
    expect(h.provider.events[0]?.message).toContain("WRONGROLE");
    expect(h.provider.events[0]?.message).not.toContain("evil-session");
    expect(h.metricLines.filter((l) => l.includes("RejectedRequests"))).toHaveLength(1);

    const garbage = await h.executor.handle(message("m-rej-2", { eventType: "DEPLOY_REQUESTED", targetId: 7 }, "WRONGROLE:s"));
    expect(garbage.ack).toBe(true);
    expect(await new RejectionRepository(h.client, testTableName()).get({ sqsMessageId: "m-rej-2" })).toMatchObject({ senderRef: "WRONGROLE" });
  });

  test.each([
    ["TARGET_UNKNOWN", "no-such-target", CI_SENDER, undefined],
    ["TARGET_INVALID", "broken-target", CI_SENDER, { targetId: "broken-target", deployScript: "relative/deploy.sh" }],
    ["TARGET_NOT_AUTHORIZED", TARGET_ID, `${CI_ROLE}:${OTHER_REPO_ID}`, undefined],
  ] as const)(
    "%s: REJECT#MSG# recorded; no sequence, lock or TARGET state; no SSH; the target's credential is never read (R-4)",
    async (reason, targetId, senderId, brokenRecord) => {
      const table = await freshTable();
      const h = await boot(undefined, table);
      if (brokenRecord !== undefined) await putTarget(h.client, targetRecord(brokenRecord));
      try {
        const readsBefore = h.secrets.reads.length;
        const runId = String(Date.now() + 11);
        const messageId = `m-${reason}`;
        expect((await h.executor.handle(message(messageId, deployRequest(runId, 999_999, targetId), senderId))).ack).toBe(true);

        expect(await new RejectionRepository(h.client, table).get({ sqsMessageId: messageId })).toMatchObject({ reason });
        expect(await rawItem(h.client, table, sequenceKey(targetId))).toBeUndefined();
        expect(await rawItem(h.client, table, lockKeyOf(targetId))).toBeUndefined();
        expect(await rawItem(h.client, table, targetStateKey(targetId))).toBeUndefined();
        expect(await rawItem(h.client, table, dedupeKey(targetId, `${runId}-1`))).toBeUndefined();
        expect(h.sshTargets).toEqual([]);
        expect(h.execCalls).toEqual([]);
        // No secret at all is read while handling a rejected request (in particular never the SSH credential).
        expect(h.secrets.reads.slice(readsBefore)).toEqual([]);
        expect(h.secrets.reads.some((ref) => ref.includes("cicd-poc/dev/example-app-dev/ssh"))).toBe(false);
      } finally {
        if (brokenRecord !== undefined) await h.client.send(new DeleteCommand({ TableName: REGISTRY_TABLE, Key: { pk: `TARGET#${brokenRecord.targetId}`, sk: "META" } }));
      }
    },
  );

  test("an unknown target is REJECTED (TARGET_UNKNOWN) and counted; nothing runs", async () => {
    const h = await boot();
    const runId = String(Date.now() + 6);
    expect((await h.executor.handle(message("m-unknown", deployRequest(runId, 5, "no-such-target"), CI_SENDER))).ack).toBe(true);
    expect(await new RejectionRepository(h.client, testTableName()).get({ sqsMessageId: "m-unknown" })).toMatchObject({ reason: "TARGET_UNKNOWN" });
    expect(h.metricLines.filter((l) => l.includes("RejectedRequests") && l.includes("TARGET_UNKNOWN"))).toHaveLength(1);
    expect(h.execCalls).toHaveLength(0);
  });

  test("option A: another repository's request (higher runNumber) is TARGET_NOT_AUTHORIZED and leaves NO trace on the target; the legitimate source still deploys", async () => {
    const table = await freshTable();
    const h = await boot(undefined, table);
    await openWindow(h);
    const windowBefore = await rawItem(h.client, table, deployWindowKey(TARGET_ID));
    const attackerRun = String(Date.now() + 7);
    const legitRun = String(Date.now() + 8);

    const attack = await h.executor.handle(message("m-attack", deployRequest(attackerRun, 999_999_999), `${CI_ROLE}:${OTHER_REPO_ID}`));
    expect(attack.ack).toBe(true);
    expect(await new RejectionRepository(h.client, table).get({ sqsMessageId: "m-attack" })).toMatchObject({ reason: "TARGET_NOT_AUTHORIZED", targetId: TARGET_ID });
    // No write keyed by the target or its requestId: dedupe, sequence, TARGET state (highestAccepted/highestDispatched), lock, window.
    expect(await rawItem(h.client, table, dedupeKey(TARGET_ID, `${attackerRun}-1`))).toBeUndefined();
    expect(await rawItem(h.client, table, sequenceKey(TARGET_ID))).toBeUndefined();
    expect(await rawItem(h.client, table, targetStateKey(TARGET_ID))).toBeUndefined();
    expect(await rawItem(h.client, table, lockKeyOf(TARGET_ID))).toBeUndefined();
    expect(await rawItem(h.client, table, deployWindowKey(TARGET_ID))).toEqual(windowBefore);
    expect(await rawItem(h.client, table, { pk: `REJECT#${TARGET_ID}#${attackerRun}-1`, sk: "META" })).toBeUndefined();
    expect(h.execCalls).toHaveLength(0);

    // The legitimate source, with a much LOWER runNumber, is neither superseded nor blocked.
    await h.executor.handle(message("m-legit", deployRequest(legitRun, 10), CI_SENDER));
    await h.queue.drain(h.executor.handle);
    const legit = await new DedupeRepository(h.client, table).get(TARGET_ID, `${legitRun}-1`);
    expect((await new ExecutionRepository(h.client, table).get(legit!.executionId!))?.status).toBe("SUCCEEDED");
    expect(h.execCalls).toHaveLength(1);
  });

  test("a target record edited or deleted after acceptance (X1) does not change the in-flight execution: the deploy uses the snapshot (FR-02)", async () => {
    const table = await freshTable();
    const h = await boot(undefined, table);
    await openWindow(h);
    const runId = String(Date.now() + 9);
    await h.executor.handle(message("m-snap", deployRequest(runId, Math.floor(Date.now() / 1000) + 30), CI_SENDER));
    // Accepted and waiting for the lock retry: now the record changes, then disappears.
    await putTarget(h.client, targetRecord({ host: "moved.example.internal", deployScript: "/opt/other/deploy.sh", version: 2 }));
    await h.client.send(new DeleteCommand({ TableName: REGISTRY_TABLE, Key: { pk: `TARGET#${TARGET_ID}`, sk: "META" } }));
    try {
      await h.queue.drain(h.executor.handle);
      expect(h.sshTargets.map((t) => t.host)).toEqual(["target.example.internal"]);
      expect(h.execCalls[0]?.scriptPath).toBe("/opt/cicd/example-app/deploy.sh");
    } finally {
      await putTarget(h.client, targetRecord());
    }
  });

  test("restart resumes from persisted state: a fresh instance re-drives a WAITING_LOCK execution through the reconciler to SUCCEEDED (not queue redelivery)", async () => {
    const table = await freshTable();
    const first = await boot(undefined, table);
    await openWindow(first);
    const runId = String(Date.now() + 2);
    await first.executor.handle(message("m-restart", deployRequest(runId, Math.floor(Date.now() / 1000) + 10), CI_SENDER));
    expect(first.queue.published).toHaveLength(1);
    const executionId = (await new DedupeRepository(first.client, table).get(TARGET_ID, `${runId}-1`))!.executionId!;
    expect((await new ExecutionRepository(first.client, table).get(executionId))?.status).toBe("WAITING_LOCK");

    // The record disappears before the restart: the reconciler re-drive deploys from the snapshot (FR-02).
    await first.client.send(new DeleteCommand({ TableName: REGISTRY_TABLE, Key: { pk: `TARGET#${TARGET_ID}`, sk: "META" } }));
    const later = { now: () => new Date(Date.now() + 10 * 60_000) };
    const second = await boot(later, table);
    try {
      const tick = await second.executor.handle(
        message("tick-1", { specVersion: 1, eventType: "RECONCILE_TICK", timestamp: later.now().toISOString(), source: "scheduler" }, `${SCHEDULER_ROLE}:s`),
      );
      expect(tick.ack).toBe(true);
      await second.queue.drain(second.executor.handle);
      expect((await new ExecutionRepository(second.client, table).get(executionId))?.status).toBe("SUCCEEDED");
      expect(second.execCalls).toHaveLength(1);
      expect(second.sshTargets.map((t) => t.host)).toEqual(["target.example.internal"]);
    } finally {
      await putTarget(second.client, targetRecord());
    }
  });

  test("a fresh instance on a RECONCILE_TICK after the lock-wait budget stores FAILED/LOCK_TIMEOUT AND notifies LOCK_TIMEOUT in the thread with the logs link (FR-15, FR-14)", async () => {
    const table = await freshTable();
    const first = await boot(undefined, table);
    await openWindow(first);
    const runId = String(Date.now() + 3);
    await first.executor.handle(message("m-lt", deployRequest(runId, Math.floor(Date.now() / 1000) + 20), CI_SENDER));
    const executionId = (await new DedupeRepository(first.client, table).get(TARGET_ID, `${runId}-1`))!.executionId!;
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
    await h.executor.handle(message("m-new", deployRequest(newer, base + 100), CI_SENDER));
    await h.executor.handle(message("m-old", deployRequest(older, base + 50), CI_SENDER));
    const oldId = (await new DedupeRepository(h.client, table).get(TARGET_ID, `${older}-1`))!.executionId!;
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
    const sourceRef = "repository=r;workflow=w";
    expect(await port.raiseHighestAccepted(lockKey, { sourceRef, runNumber: 5, executionId: "e-5" })).toMatchObject({ accepted: true });
    expect(await port.raiseHighestAccepted(lockKey, { sourceRef, runNumber: 3, executionId: "e-3" })).toEqual({ accepted: false, reason: "STORED_IS_NEWER" });
    expect(await port.readOrdering(lockKey)).toEqual({ highestAccepted: { sourceRef, runNumber: 5, executionId: "e-5" } });
  });
});
