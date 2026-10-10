// @akili-spec changes/cicd-executor-poc architecture-change-04 §7–§9, §16; design §7.3, DD-09
//
// AC-04 E2 on DynamoDB Local: the REAL composition root (bootstrap) with the sqs-agent transport configured, the real
// repositories and transactions, an in-memory agent standing in for the FIFO command queue, and a controlled clock.
// Every scenario of AC-04 §16 that concerns the Executor is driven through the real entry points: DEPLOY_REQUESTED
// and LOCK_RETRY_REQUESTED (request queue), AGENT_EVENT (results queue handler), RECONCILE_TICK, and the operator's
// TARGET_RESOLUTION_RECORDED. SQS itself is simulated: the SenderId role id is injected (the real SenderId of SQS is
// verified in AWS at E5, never claimed here).
import { randomUUID } from "node:crypto";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, test } from "vitest";
import { buildCreateTableInput } from "../../src/adapters/dynamodb-state-store/table-schema.js";
import { DedupeRepository } from "../../src/adapters/dynamodb-state-store/dedupe-repository.js";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { lockKeyOf, targetStateKey } from "../../src/adapters/dynamodb-state-store/keys.js";
import type { ExecutionItem, LockItem } from "../../src/adapters/dynamodb-state-store/types.js";
import { PINNED_LEASE_EXPIRES_AT } from "../../src/domain/agent-protocol/index.js";
import { bootstrap } from "../../src/main/bootstrap.js";
import type { InboundMessage } from "../../src/inbound/sqs-consumer/index.js";
import type { AgentDispatcher, AgentQueueMessage } from "../../src/ports/agent-dispatcher.js";
import { CI_ROLE, LoopbackQueue, OPERATOR_ROLE, RecordingProvider, SCHEDULER_ROLE, bundledSchemas, fakeSecrets, successfulTransport, validEnv } from "../support/composition-fixtures.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, requireLocalDynamoEndpoint } from "./setup.js";

const REPO_ID = "123456789";
const AGENT_ID = "example-server-dev";
const AGENT_ROLE = "AROAFAKEAGENTROLE0001";
const OTHER_ROLE = "AROAFAKEAGENTROLE0002";
const AGENT_SENDER = `${AGENT_ROLE}:i-0example`;
const REGISTRY_TABLE = `cicd-registry-agent-${randomUUID().slice(0, 8)}`;
const RESULTS_URL = "https://queue.example.invalid/<AWS_ACCOUNT_ID>/cicd-agent-results-dev.fifo";
/** Obviously fake queue base: AWS's documentation account id (publication policy, DD-23). */
const FAKE_SQS_QUEUE_BASE = "https://sqs.us-east-1.amazonaws.com/123456789012";
const MIN = 60_000;

interface Command {
  readonly commandId: string;
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly fencingToken: number;
  readonly agentId: string;
  readonly targetId: string;
  readonly notAfter: string;
  readonly issuedAt: string;
}

/** Stands in for the agent's FIFO command queue: records every message (commands and queries); can be made to fail. */
class InMemoryAgentQueue implements AgentDispatcher {
  public readonly sent: AgentQueueMessage[] = [];
  public failNext = 0;
  public async send(message: AgentQueueMessage): Promise<{ readonly messageId: string }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated SQS failure");
    }
    this.sent.push(message);
    return { messageId: `agent-${String(this.sent.length)}` };
  }
  public commands(): Command[] {
    return this.sent.filter((m) => m.body["type"] === "AGENT_COMMAND").map((m) => m.body as unknown as Command);
  }
  public queries(): AgentQueueMessage[] {
    return this.sent.filter((m) => m.body["type"] === "AGENT_QUERY");
  }
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

async function freshTable(): Promise<string> {
  const table = `cicd-agent-${randomUUID().slice(0, 8)}`;
  const raw = new DynamoDBClient({ region: "us-east-1", endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT });
  await raw.send(new CreateTableCommand(buildCreateTableInput(table)));
  raw.destroy();
  return table;
}

describe.skipIf(!dynamoDbLocalAvailable())("sqs-agent transport, asynchronous Executor (AC-04 E2, DynamoDB Local)", () => {
  const registered: string[] = [];

  beforeAll(async () => {
    await ensureTestTable();
    await createRegistryTable();
  });

  /** One target per test (isolation), served by the agent; `agentServes` false lists another target on the agent. */
  async function registerTarget(client: DynamoDBDocumentClient, targetId: string, agentServes = true): Promise<void> {
    registered.push(targetId);
    await client.send(
      new PutCommand({
        TableName: REGISTRY_TABLE,
        Item: {
          pk: `TARGET#${targetId}`,
          sk: "META",
          targetId,
          project: "example",
          environment: "dev",
          transport: "sqs-agent",
          agentId: AGENT_ID,
          scriptId: `deploy-${targetId}`,
          deployWindowPolicy: "not-required",
          sourceRepositoryId: REPO_ID,
          schemaVersion: 1,
          version: 1,
          updatedAt: "2026-10-10T12:00:00Z",
          updatedBy: "platform-admin",
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: REGISTRY_TABLE,
        Item: {
          pk: `AGENT#${AGENT_ID}`,
          sk: "META",
          agentId: AGENT_ID,
          stage: "dev",
          roleId: AGENT_ROLE,
          commandQueueUrl: `${FAKE_SQS_QUEUE_BASE}/cicd-agent-dev-example-server-dev-cmd.fifo`,
          targets: agentServes ? [...registered] : ["some-other-target-dev"],
          minAgentVersion: "1.0.0",
          schemaVersion: 1,
          version: 1,
          updatedAt: "2026-10-10T12:00:00Z",
          updatedBy: "platform-admin",
        },
      }),
    );
  }

  async function boot(table: string, clock: { t: number }, agentQueue = new InMemoryAgentQueue()) {
    const client = createTestDocumentClient();
    const queue = new LoopbackQueue();
    const provider = new RecordingProvider();
    const execCalls: unknown[] = [];
    const executor = await bootstrap({
      env: validEnv({
        CICD_TABLE_NAME: table,
        CICD_REGISTRY_TABLE_NAME: REGISTRY_TABLE,
        CICD_AGENT_RESULTS_QUEUE_URL: RESULTS_URL,
        CICD_AGENT_LOG_BUCKET: "example-logs-dev",
      }),
      secrets: fakeSecrets(),
      clock: { now: () => new Date(clock.t) },
      schemas: bundledSchemas(),
      documentClient: client,
      publisher: queue,
      notificationProviders: [provider],
      createTransport: () => successfulTransport(execCalls as never),
      createConsumer: () => ({ start: async () => undefined, stop: async () => undefined }),
      logSink: { write: () => undefined },
      metricsSink: { write: () => undefined },
      healthcheckWriter: { write: () => undefined },
      agentDispatcher: agentQueue,
    });
    const handleAgent = executor.handleAgentMessage as NonNullable<typeof executor.handleAgentMessage>;
    let n = 0;
    const h = {
      client,
      queue,
      agentQueue,
      executor,
      execCalls,
      executions: new ExecutionRepository(client, table),
      /** `deliveries` bounds how many queued messages are delivered: the loopback queue ignores SQS delays, so an
       *  unbounded drain would replay every delayed lock retry at once (a harness artifact, not Executor behavior). */
      async request(targetId: string, runId: string, runNumber: number, deliveries = 50) {
        n += 1;
        const body = {
          specVersion: 1,
          eventType: "DEPLOY_REQUESTED",
          requestId: `${runId}-1`,
          targetId,
          commitSha: "a".repeat(40),
          artifacts: { backend: `sha256:${"b".repeat(64)}` },
          ci: { repository: "example-org/example-app", workflowRef: "example-org/example-app/.github/workflows/ci.yml@refs/heads/main", runId, runAttempt: 1, runNumber },
        };
        const out = await executor.handle(message(`req-${String(n)}-${runId}`, body, `${CI_ROLE}:${REPO_ID}`));
        let delivered = 0;
        await queue.drain(async (m) => (delivered++ < deliveries ? executor.handle(m) : { ack: true }));
        return out;
      },
      async execution(targetId: string, runId: string): Promise<ExecutionItem> {
        const dedupe = await new DedupeRepository(client, table).get(targetId, `${runId}-1`);
        return (await this.executions.get(dedupe?.executionId as string)) as ExecutionItem;
      },
      async lock(targetId: string): Promise<LockItem | undefined> {
        const key = lockKeyOf(targetId);
        return (await client.send(new GetCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk } }))).Item as LockItem | undefined;
      },
      async unresolved(targetId: string): Promise<unknown[] | undefined> {
        const key = targetStateKey(targetId);
        const item = (await client.send(new GetCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk } }))).Item;
        return item?.["unresolved"] as unknown[] | undefined;
      },
      async audit(executionId: string): Promise<Record<string, unknown>[]> {
        const out = await client.send(
          new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ExpressionAttributeValues: { ":pk": `EXEC#${executionId}`, ":p": "AGEVT#" } }),
        );
        return (out.Items ?? []) as Record<string, unknown>[];
      },
      event(cmd: Command, phase: string, seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
        return {
          specVersion: 1,
          type: "AGENT_EVENT",
          phase,
          commandId: cmd.commandId,
          executionId: cmd.executionId,
          dispatchToken: cmd.dispatchToken,
          fencingToken: phase === "NEVER_SEEN" || phase === "NO_RECORD" ? 0 : cmd.fencingToken,
          agentId: cmd.agentId,
          targetId: cmd.targetId,
          seq,
          sentAt: new Date(clock.t).toISOString(),
          agentVersion: "1.0.0",
          ...extra,
        };
      },
      async deliver(body: Record<string, unknown>, sender = AGENT_SENDER) {
        n += 1;
        const out = await handleAgent(message(`agent-${String(n)}`, body, sender));
        let delivered = 0;
        await queue.drain(async (m) => (delivered++ < 1 ? executor.handle(m) : { ack: true })); // e.g. the retry after X14
        return out;
      },
      async tick() {
        n += 1;
        const out = await executor.handle(message(`tick-${String(n)}`, { specVersion: 1, eventType: "RECONCILE_TICK", source: "scheduler", timestamp: new Date(clock.t).toISOString() }, `${SCHEDULER_ROLE}:scheduler`));
        await queue.drain(executor.handle);
        return out;
      },
      async resolve(targetId: string, executionId: string) {
        n += 1;
        const body = { specVersion: 1, eventId: randomUUID(), eventType: "TARGET_RESOLUTION_RECORDED", timestamp: new Date(clock.t).toISOString(), source: "operator", targetId, executionId, resolvedBy: "operator-1", observedDigests: {} };
        return executor.handle(message(`resolve-${String(n)}`, body, `${OPERATOR_ROLE}:operator`));
      },
    };
    return h;
  }

  async function dispatched(targetId: string) {
    const table = await freshTable();
    const clock = { t: Date.now() };
    const h = await boot(table, clock);
    await registerTarget(h.client, targetId);
    const runId = String(Date.now() % 1_000_000_000);
    await h.request(targetId, runId, 10);
    const item = await h.execution(targetId, runId);
    const cmd = h.agentQueue.commands().at(-1) as Command;
    return { table, clock, h, runId, item, cmd };
  }

  // ------------------------------------------------------------------------------------------------------------------
  test("dispatch is asynchronous: X9 pins the lock (no TTL), ONE command is sent and the handler returns without waiting", async () => {
    const { h, item, cmd } = await dispatched(`agent-async-${randomUUID().slice(0, 6)}`);
    expect(item).toMatchObject({ status: "DEPLOYING", attempt: 1 });
    expect(item.agent).toMatchObject({ dispatchState: "SENT", commandId: `${item.executionId}:${item.dispatchToken as string}`, lastEventSeq: 0 });
    expect(item.execStartedAt).toBeUndefined(); // nothing ran yet: the handler did not wait for the agent
    expect(h.agentQueue.commands()).toHaveLength(1);
    const sent = h.agentQueue.sent[0] as AgentQueueMessage;
    expect(sent).toMatchObject({ groupId: item.targetId, deduplicationId: cmd.commandId });
    expect(cmd).toMatchObject({ fencingToken: item.fencingToken, agentId: AGENT_ID, targetId: item.targetId });
    const lock = await h.lock(item.targetId);
    expect(lock).toMatchObject({ owner: item.executionId, fencingToken: item.fencingToken, mode: "PINNED", leaseExpiresAt: PINNED_LEASE_EXPIRES_AT });
    expect(lock?.expiresAt).toBeUndefined(); // the 24 h cleanup TTL is removed while pinned
    expect(h.execCalls).toEqual([]); // the SSH transport is never used for an sqs-agent target
  });

  test("events close the execution through the existing transitions: ACCEPTED, STARTED, HEARTBEAT, FINISHED 0 -> SUCCEEDED; the lock is released in the same transaction and its TTL restored", async () => {
    const { h, item, cmd, clock } = await dispatched(`agent-ok-${randomUUID().slice(0, 6)}`);
    expect(await h.deliver(h.event(cmd, "ACCEPTED", 1, { acceptedAt: new Date(clock.t).toISOString() }))).toEqual({ ack: true });
    expect(await h.deliver(h.event(cmd, "STARTED", 2, { startedAt: new Date(clock.t).toISOString(), pid: 42 }))).toEqual({ ack: true });
    clock.t += MIN;
    expect(await h.deliver(h.event(cmd, "HEARTBEAT", 3, { elapsedMs: MIN }))).toEqual({ ack: true });
    const running = (await h.executions.get(item.executionId)) as ExecutionItem;
    expect(running).toMatchObject({ status: "DEPLOYING" });
    expect(running.execStartedAt).toBeDefined();
    expect((await h.lock(item.targetId))?.mode).toBe("PINNED"); // heartbeats never touch the lock
    clock.t += MIN;
    const finished = h.event(cmd, "FINISHED", 4, { exitCode: 0, timedOut: false, durationMs: 2 * MIN, signal: null, cicdResult: { status: "SUCCESS", deployedCommit: "a".repeat(40) } });
    expect(await h.deliver(finished)).toEqual({ ack: true });
    const done = (await h.executions.get(item.executionId)) as ExecutionItem;
    expect(done).toMatchObject({ status: "SUCCEEDED", versionCheck: "VERIFIED" });
    const lock = await h.lock(item.targetId);
    expect(lock?.leaseExpiresAt).toBeLessThan(clock.t);
    expect(lock).toMatchObject({ mode: "LEASE", fencingToken: item.fencingToken });
    expect(lock?.expiresAt).toBeGreaterThan(0);
    expect((await h.audit(item.executionId)).map((a) => a["disposition"]).sort()).toEqual(["APPLIED", "PROGRESS", "PROGRESS", "PROGRESS"]);
  });

  test("scenarios 3: duplicate, out-of-order and late events never move the state backwards", async () => {
    const { h, item, cmd, clock } = await dispatched(`agent-dup-${randomUUID().slice(0, 6)}`);
    await h.deliver(h.event(cmd, "STARTED", 2, { startedAt: new Date(clock.t).toISOString() }));
    await h.deliver(h.event(cmd, "STARTED", 2, { startedAt: new Date(clock.t).toISOString() })); // redelivery
    await h.deliver(h.event(cmd, "ACCEPTED", 1, { acceptedAt: new Date(clock.t).toISOString() })); // out of order: older seq
    const mid = (await h.executions.get(item.executionId)) as ExecutionItem;
    expect(mid.agent?.lastEventSeq).toBe(2);
    expect(mid.agent?.acceptedAt).toBeUndefined();
    await h.deliver(h.event(cmd, "FINISHED", 3, { exitCode: 0, timedOut: false, durationMs: 1000, cicdResult: { status: "SUCCESS" } }));
    await h.deliver(h.event(cmd, "FINISHED", 3, { exitCode: 0, timedOut: false, durationMs: 1000, cicdResult: { status: "SUCCESS" } })); // duplicate after closing
    await h.deliver(h.event(cmd, "NOT_STARTED", 4, { reason: "ABANDONED" })); // contradictory late event
    expect(await h.executions.get(item.executionId)).toMatchObject({ status: "SUCCEEDED" });
    const dispositions = (await h.audit(item.executionId)).map((a) => a["disposition"]);
    expect(dispositions).toEqual(expect.arrayContaining(["DUPLICATE", "LATE"]));
  });

  test("scenarios 1 and 2: a lost send is re-sent by the reconciler with the SAME command (same commandId, token and fencing token)", async () => {
    const table = await freshTable();
    const clock = { t: Date.now() };
    const agentQueue = new InMemoryAgentQueue();
    agentQueue.failNext = 1; // the Executor's SendMessage fails right after X9 (equivalent to a crash before the send)
    const h = await boot(table, clock, agentQueue);
    const targetId = `agent-resend-${randomUUID().slice(0, 6)}`;
    await registerTarget(h.client, targetId);
    await h.request(targetId, "777001", 10);
    const pending = await h.execution(targetId, "777001");
    expect(pending.agent).toMatchObject({ dispatchState: "PENDING_SEND", sendAttempts: 1 });
    expect((await h.lock(targetId))?.mode).toBe("PINNED"); // the lock is pinned although nothing was sent
    expect(agentQueue.commands()).toEqual([]);

    clock.t += 31_000;
    await h.tick();
    const resent = agentQueue.commands();
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({ commandId: pending.agent?.commandId, dispatchToken: pending.dispatchToken, fencingToken: pending.fencingToken });
    expect((await h.executions.get(pending.executionId))?.agent?.dispatchState).toBe("SENT");

    // A second re-send (SENT lost, or a duplicate tick) carries the same FIFO deduplication id: absorbed by SQS or the journal.
    await h.executions.update(pending.executionId, { status: "DEPLOYING", version: ((await h.executions.get(pending.executionId)) as ExecutionItem).version, dispatchToken: pending.dispatchToken as string }, {
      agent: { ...((await h.executions.get(pending.executionId)) as ExecutionItem).agent, dispatchState: "PENDING_SEND" } as never,
      activeStatus: "EXECUTION",
      deadlineAt: clock.t - 1,
    } as never);
    await h.tick();
    const dedupIds = agentQueue.sent.filter((m) => m.body["type"] === "AGENT_COMMAND").map((m) => m.deduplicationId);
    expect(new Set(dedupIds).size).toBe(1);
    expect(dedupIds).toHaveLength(2);
  });

  test("scenarios 5 and 6: a PINNED lock survives far beyond the old 24 h TTL; a second request for the target waits, the first one's FINISHED frees it", async () => {
    const { h, item, cmd, clock, table } = await dispatched(`agent-ttl-${randomUUID().slice(0, 6)}`);
    await h.deliver(h.event(cmd, "ACCEPTED", 1, { acceptedAt: new Date(clock.t).toISOString() }));
    await h.request(item.targetId, "880002", 11, 1); // a newer request for the same target (one lock attempt)
    const second = await h.execution(item.targetId, "880002");
    expect(second.status).toBe("WAITING_LOCK"); // the pinned lock is busy for anyone else
    clock.t += 2 * 24 * 60 * MIN; // two days later, with no event processed meanwhile
    const lock = await h.lock(item.targetId);
    expect(lock).toMatchObject({ owner: item.executionId, leaseExpiresAt: PINNED_LEASE_EXPIRES_AT });
    expect(lock?.expiresAt).toBeUndefined();

    // A new Executor instance (restart) on the same tables applies the late FINISHED (scenario 11).
    const restarted = await boot(table, clock, h.agentQueue);
    await restarted.deliver(h.event(cmd, "STARTED", 2, { startedAt: new Date(clock.t).toISOString() }));
    // The deadline passed long ago: the reconciler already closed it as X16 + hold? It did not run here; the event applies.
    await restarted.deliver(h.event(cmd, "FINISHED", 3, { exitCode: 0, timedOut: false, durationMs: 1000, cicdResult: { status: "SUCCESS" } }));
    expect(await restarted.executions.get(item.executionId)).toMatchObject({ status: "SUCCEEDED" });
    expect((await restarted.lock(item.targetId))?.leaseExpiresAt).toBeLessThan(clock.t);
  });

  test("scenario 9 and fencing: events from another role, another dispatch or another fencing token change nothing", async () => {
    const { h, item, cmd, clock } = await dispatched(`agent-fence-${randomUUID().slice(0, 6)}`);
    const finished = { exitCode: 0, timedOut: false, durationMs: 1000, cicdResult: { status: "SUCCESS" } };
    await h.deliver(h.event(cmd, "FINISHED", 1, finished), `${OTHER_ROLE}:i-other`); // forged sender
    await h.deliver({ ...h.event(cmd, "FINISHED", 1, finished), fencingToken: cmd.fencingToken + 1 }); // wrong token
    const otherToken = "0f8b3c1e-2a4d-4b6f-8c9e-1a2b3c4d5e6f";
    await h.deliver({ ...h.event(cmd, "FINISHED", 1, finished), dispatchToken: otherToken, commandId: `${cmd.executionId}:${otherToken}` }); // older dispatch
    expect(await h.executions.get(item.executionId)).toMatchObject({ status: "DEPLOYING" });
    expect(await h.lock(item.targetId)).toMatchObject({ mode: "PINNED", owner: item.executionId });
    expect(clock.t).toBeGreaterThan(0);
  });

  test("scenarios 7 and 8: an unprocessed ACCEPTED never frees the target; silence leads to AGENT_QUERY, then X16 with a HOLD at the hard deadline", async () => {
    const { h, item, clock } = await dispatched(`agent-silent-${randomUUID().slice(0, 6)}`);
    const a = item.agent as NonNullable<ExecutionItem["agent"]>;
    clock.t = a.notAfter + 3 * MIN + 1; // past notAfter + skew + margin, no event at all
    await h.tick();
    expect(h.agentQueue.queries()).toHaveLength(1);
    expect(h.agentQueue.queries()[0]).toMatchObject({ groupId: item.targetId, deduplicationId: `${a.commandId}:q1` });
    expect(await h.executions.get(item.executionId)).toMatchObject({ status: "DEPLOYING" }); // silence is never "not started"
    expect((await h.lock(item.targetId))?.mode).toBe("PINNED");

    clock.t = a.hardDeadlineAt + 1;
    await h.tick();
    const held = (await h.executions.get(item.executionId)) as ExecutionItem;
    expect(held).toMatchObject({ status: "UNKNOWN_TARGET_STATE", activeStatus: "HOLD" });
    expect(await h.lock(item.targetId)).toMatchObject({ hold: true, mode: "PINNED", owner: item.executionId });
    expect((await h.lock(item.targetId))?.expiresAt).toBeUndefined();
    expect(await h.unresolved(item.targetId)).toHaveLength(1);
    // A new request for the target cannot take the held lock.
    await h.request(item.targetId, "990003", 12, 1);
    expect((await h.execution(item.targetId, "990003")).status).toBe("WAITING_LOCK");
  });

  test("AGENT_QUERY answers: insufficient evidence (recreated journal, NO_RECORD) keeps the target; a valid NEVER_SEEN retries with a NEW dispatch and a higher fencing token", async () => {
    const { h, item, cmd, clock } = await dispatched(`agent-query-${randomUUID().slice(0, 6)}`);
    const a = item.agent as NonNullable<ExecutionItem["agent"]>;
    clock.t = a.notAfter + 3 * MIN + 1;
    await h.tick();
    // A recreated journal (epoch after the command) proves nothing.
    await h.deliver(h.event(cmd, "NEVER_SEEN", 1, { journalEpoch: new Date(a.issuedAt + 1000).toISOString(), journalRetentionDays: 30 }));
    await h.deliver(h.event(cmd, "NO_RECORD", 2, { journalEpoch: new Date(a.issuedAt + 1000).toISOString() }));
    expect(await h.executions.get(item.executionId)).toMatchObject({ status: "DEPLOYING" });
    expect((await h.lock(item.targetId))?.mode).toBe("PINNED");

    // A journal older than the command, answered after notAfter + skew: verified never-started evidence.
    await h.deliver(h.event(cmd, "NEVER_SEEN", 3, { journalEpoch: new Date(a.issuedAt - 24 * 60 * MIN).toISOString(), journalRetentionDays: 30 }));
    const retried = (await h.executions.get(item.executionId)) as ExecutionItem;
    // X14 released the lock and published LOCK_RETRY_REQUESTED; the loopback queue delivered it: a NEW dispatch.
    expect(retried).toMatchObject({ status: "DEPLOYING", attempt: 2 });
    expect(retried.dispatchToken).not.toBe(item.dispatchToken);
    expect(retried.fencingToken).toBe((item.fencingToken as number) + 1);
    const commands = h.agentQueue.commands();
    expect(commands).toHaveLength(2);
    expect(commands[1]?.fencingToken).toBeGreaterThan(commands[0]?.fencingToken as number);
  });

  test("NOT_STARTED BUSY retries (X14); NOT_STARTED REJECTED_SCRIPT fails (X11); both release the lock in the closing transaction", async () => {
    const busy = await dispatched(`agent-busy-${randomUUID().slice(0, 6)}`);
    await busy.h.deliver(busy.h.event(busy.cmd, "NOT_STARTED", 1, { reason: "BUSY" }));
    expect(await busy.h.executions.get(busy.item.executionId)).toMatchObject({ status: "DEPLOYING", attempt: 2 }); // retried
    const rejected = await dispatched(`agent-reject-${randomUUID().slice(0, 6)}`);
    await rejected.h.deliver(rejected.h.event(rejected.cmd, "NOT_STARTED", 1, { reason: "REJECTED_SCRIPT" }));
    expect(await rejected.h.executions.get(rejected.item.executionId)).toMatchObject({ status: "FAILED", error: { code: "AGENT_REJECTED" } });
    expect((await rejected.h.lock(rejected.item.targetId))?.leaseExpiresAt).toBeLessThan(rejected.clock.t + 1);
  });

  test("LOST and timeouts are UNKNOWN_TARGET_STATE with a HOLD; a late FINISHED is evidence only (OP-1); the operator's TARGET_RESOLUTION_RECORDED releases the hold (OP-2)", async () => {
    const { h, item, cmd, clock } = await dispatched(`agent-lost-${randomUUID().slice(0, 6)}`);
    await h.deliver(h.event(cmd, "STARTED", 1, { startedAt: new Date(clock.t).toISOString() }));
    await h.deliver(h.event(cmd, "LOST", 2, { startedAt: new Date(clock.t).toISOString() }));
    expect(await h.executions.get(item.executionId)).toMatchObject({ status: "UNKNOWN_TARGET_STATE" });
    expect(await h.lock(item.targetId)).toMatchObject({ hold: true, owner: item.executionId });

    await h.deliver(h.event(cmd, "FINISHED", 3, { exitCode: 0, timedOut: false, durationMs: 1000, cicdResult: { status: "SUCCESS" } }));
    expect(await h.lock(item.targetId)).toMatchObject({ hold: true }); // never an automatic release (OP-1)
    expect((await h.audit(item.executionId)).map((x) => x["disposition"])).toContain("OPERATOR_REQUIRED");

    expect(await h.resolve(item.targetId, item.executionId)).toEqual({ ack: true });
    const lock = await h.lock(item.targetId);
    expect(lock?.hold).toBeUndefined();
    expect(lock?.leaseExpiresAt).toBeLessThan(clock.t + 1);
    expect(await h.unresolved(item.targetId)).toEqual([]);
    // The target is free again: a new request dispatches with a higher fencing token.
    await h.request(item.targetId, "991004", 13);
    const next = await h.execution(item.targetId, "991004");
    expect(next).toMatchObject({ status: "DEPLOYING" });
    expect(next.fencingToken).toBeGreaterThan(item.fencingToken as number);
  });

  test("a held target is released automatically ONLY by verified never-started evidence, through the operator resolution path with the agent as actor", async () => {
    const { h, item, cmd, clock } = await dispatched(`agent-evid-${randomUUID().slice(0, 6)}`);
    const a = item.agent as NonNullable<ExecutionItem["agent"]>;
    clock.t = a.hardDeadlineAt + 1;
    await h.tick(); // silence -> X16 + hold (HOLD partition)
    expect(await h.lock(item.targetId)).toMatchObject({ hold: true });
    clock.t += 2 * MIN;
    await h.tick(); // a hold query
    expect(h.agentQueue.queries().length).toBeGreaterThanOrEqual(1);
    await h.deliver(h.event(cmd, "NEVER_SEEN", 1, { journalEpoch: new Date(a.issuedAt - 24 * 60 * MIN).toISOString(), journalRetentionDays: 30 }));
    const lock = await h.lock(item.targetId);
    expect(lock?.hold).toBeUndefined();
    expect(await h.unresolved(item.targetId)).toEqual([]);
    expect((await h.executions.get(item.executionId))?.status).toBe("UNKNOWN_TARGET_STATE"); // terminal states never change
    expect((await h.audit(item.executionId)).map((x) => x["disposition"])).toContain("HOLD_RELEASED");
  });

  test("scenario 11 (concurrency): two requests for the same target dispatch ONE command; independent targets dispatch in parallel", async () => {
    const table = await freshTable();
    const clock = { t: Date.now() };
    const h = await boot(table, clock);
    const t1 = `agent-conc-a-${randomUUID().slice(0, 6)}`;
    const t2 = `agent-conc-b-${randomUUID().slice(0, 6)}`;
    await registerTarget(h.client, t1);
    await registerTarget(h.client, t2);
    await Promise.all([h.request(t1, "992001", 20, 1), h.request(t1, "992002", 21, 1), h.request(t2, "992003", 22, 1)]);
    const commandsT1 = h.agentQueue.commands().filter((c) => c.targetId === t1);
    const commandsT2 = h.agentQueue.commands().filter((c) => c.targetId === t2);
    expect(commandsT1).toHaveLength(1);
    expect(commandsT2).toHaveLength(1);
    const statuses = [(await h.execution(t1, "992001")).status, (await h.execution(t1, "992002")).status];
    // Exactly one is dispatched; the other waits for the pinned lock or, if it is the older run, is superseded (S2).
    expect(statuses.filter((x) => x === "DEPLOYING")).toHaveLength(1);
    expect(statuses.filter((x) => x === "WAITING_LOCK" || x === "SUPERSEDED")).toHaveLength(1);
  });

  test("safe mode: an sqs-agent target whose agent does not serve it is REJECTED (TARGET_INVALID); nothing is dispatched", async () => {
    const table = await freshTable();
    const clock = { t: Date.now() };
    const h = await boot(table, clock);
    const targetId = `agent-unserved-${randomUUID().slice(0, 6)}`;
    await registerTarget(h.client, targetId, false);
    await h.request(targetId, "993001", 30);
    expect(h.agentQueue.sent).toEqual([]);
    expect(await new DedupeRepository(h.client, table).get(targetId, "993001-1")).toBeUndefined();
  });
});
