// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §9.3, §10, §12, §16
//
// AC-04 E3: the server agent with REAL child processes (a Node stand-in for the catalog scripts, launched through an
// injected spawn function), a real on-disk state directory, and in-memory stand-ins for the FIFO command queue, the
// results queue and S3. A "crash" is a SimulatedCrash thrown at a journal step; recovery is a NEW Agent instance on the
// same state directory. Every event the agent emits is validated against schemas/agent-event.schema.json.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, SimulatedCrash, type AgentDeps, type CrashPoint } from "../../src/agent/agent.js";
import type { ProcessInspector } from "../../src/agent/processes.js";
import { startScript } from "../../src/agent/runner.js";
import { loadAgentConfig, type AgentConfig } from "../../src/agent/config.js";
import { AgentStateStore } from "../../src/agent/state-store.js";
import type { CommandSource, EventSink, LogStore, ReceivedCommandMessage } from "../../src/agent/ports.js";
import { createAgentContractValidators } from "../../src/application/agent-transport/validators.js";
import type { AgentContractValidators } from "../../src/application/agent-transport/index.js";
import { commandIdOf } from "../../src/domain/agent-protocol/index.js";
import { bundledSchemas } from "../support/composition-fixtures.js";

const FIXTURE = fileURLToPath(new URL("../support/agent-fixture-script.mjs", import.meta.url));
const EXECUTOR_ROLE = "AROAFAKEEXECUTORROL01";
const AGENT_ID = "example-server-dev";
const MIN = 60_000;
const roots: string[] = [];

// ---------------------------------------------------------------------------------------------- stand-ins
class FakeQueue implements CommandSource {
  public readonly messages: ReceivedCommandMessage[] = [];
  public readonly deleted: string[] = [];
  /** [receiptHandle, seconds] of every visibility change (0 = handed back to the queue). */
  public readonly visibility: [string, number][] = [];
  public receives = 0;
  private n = 0;
  public push(body: unknown, senderId = `${EXECUTOR_ROLE}:executor`): ReceivedCommandMessage {
    this.n += 1;
    const m = { messageId: `m-${String(this.n)}`, receiptHandle: `r-${String(this.n)}`, body: JSON.stringify(body), senderId };
    this.messages.push(m);
    return m;
  }
  public async receive(max: number, _signal?: AbortSignal): Promise<readonly ReceivedCommandMessage[]> {
    this.receives += 1;
    return this.messages.filter((m) => !this.deleted.includes(m.receiptHandle)).slice(0, max);
  }
  public async delete(receiptHandle: string): Promise<void> {
    this.deleted.push(receiptHandle);
  }
  public async extendVisibility(receiptHandle: string, seconds: number): Promise<void> {
    this.visibility.push([receiptHandle, seconds]);
  }
}

class FakeSink implements EventSink {
  public readonly events: Record<string, unknown>[] = [];
  public offline = false;
  public async send(message: { body: Readonly<Record<string, unknown>>; groupId: string; deduplicationId: string }): Promise<void> {
    if (this.offline) throw new Error("network unreachable");
    this.events.push({ ...message.body, _groupId: message.groupId, _dedup: message.deduplicationId });
  }
  public phases(commandId?: string): string[] {
    return this.events.filter((e) => commandId === undefined || e["commandId"] === commandId).map((e) => String(e["phase"]));
  }
}

class FakeS3 implements LogStore {
  public readonly objects = new Map<string, Uint8Array>();
  public failing = false;
  public async put(object: { bucket: string; key: string; body: Uint8Array }): Promise<void> {
    if (this.failing) throw new Error("S3 unavailable");
    this.objects.set(`${object.bucket}/${object.key}`, object.body);
  }
}

interface ScriptControl {
  readonly sleepMs?: number;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly ignoreTerm?: boolean;
  readonly spawnApp?: { readonly pidFile: string; readonly holdStdout?: boolean; readonly sameGroup?: boolean };
}

// ---------------------------------------------------------------------------------------------- harness
let validators: AgentContractValidators;
beforeAll(async () => {
  validators = await createAgentContractValidators(bundledSchemas());
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function newWorld(opts: { maxParallel?: number; resources?: Record<string, number>; targets?: Record<string, { resources?: string[]; arguments?: "standard" | "none"; timeoutSeconds?: number }> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cicd-agent-"));
  roots.push(root);
  const targets = opts.targets ?? { "app-a-dev": {} };
  const catalog = {
    agentId: AGENT_ID,
    targets: Object.fromEntries(
      Object.entries(targets).map(([id, t]) => [id, { scriptId: `deploy-${id}`, path: `/opt/test/${id}`, arguments: t.arguments ?? "standard", timeoutSeconds: t.timeoutSeconds ?? 600, killGraceSeconds: 5, resources: t.resources ?? [] }]),
    ),
  };
  const config: AgentConfig = loadAgentConfig(
    {
      agentId: AGENT_ID,
      stage: "dev",
      region: "us-east-1",
      commandQueueUrl: "https://queue.example.invalid/cicd-agent-dev-example-server-dev-cmd.fifo",
      resultsQueueUrl: "https://queue.example.invalid/cicd-agent-results-dev.fifo",
      executorRoleId: EXECUTOR_ROLE,
      logBucket: "example-logs-dev",
      stateDir: join(root, "state"),
      maxParallel: opts.maxParallel ?? 2,
      resources: opts.resources ?? {},
    },
    catalog,
    { allowRelativePaths: true },
  );
  const world = {
    root,
    config,
    queue: new FakeQueue(),
    sink: new FakeSink(),
    s3: new FakeS3(),
    clock: { t: Date.now() },
    clockOffset: 0,
    control: new Map<string, ScriptControl>(),
    spawned: [] as string[],
    markers: join(root, "markers.jsonl"),
  };
  return world;
}

type World = ReturnType<typeof newWorld>;

function agentOf(w: World, crashAt?: CrashPoint, extra: Partial<Pick<AgentDeps, "logger" | "stdioDrainMs" | "processes" | "source">> = {}): Agent {
  const spawnFn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    // `command` is the catalog path (no runAs in tests): map it to the Node stand-in; the contract args pass unchanged.
    w.spawned.push(command);
    const targetId = command.replace("/opt/test/", "");
    const control = { markers: w.markers, ...(w.control.get(targetId) ?? {}) };
    return spawn(process.execPath, [FIXTURE, ...args], { ...options, env: { ...options.env, CICD_TEST_CONTROL: JSON.stringify(control) } });
  };
  return new Agent({
    config: w.config,
    store: new AgentStateStore(w.config.stateDir, w.clock.t),
    source: w.queue,
    sink: w.sink,
    logs: w.s3,
    validators,
    clock: { now: () => w.clock.t },
    clockOffsetMs: () => w.clockOffset,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    spawn: spawnFn,
    baseEnv: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "" },
    ...(crashAt === undefined ? {} : { crashAt }),
    ...extra,
  });
}

let tokenCounter = 0;
function command(w: World, over: { targetId?: string; fencingToken?: number; executionId?: string; scriptId?: string; args?: string[]; issuedAt?: number; notAfter?: number; agentId?: string } = {}) {
  tokenCounter += 1;
  const targetId = over.targetId ?? "app-a-dev";
  const executionId = over.executionId ?? `${targetId}-${String(tokenCounter)}`;
  const dispatchToken = `00000000-0000-4000-8000-${String(tokenCounter).padStart(12, "0")}`;
  const fencingToken = over.fencingToken ?? tokenCounter;
  const commit = "a".repeat(40);
  return {
    specVersion: 1,
    type: "AGENT_COMMAND",
    commandId: commandIdOf(executionId, dispatchToken),
    executionId,
    dispatchToken,
    fencingToken,
    agentId: over.agentId ?? AGENT_ID,
    targetId,
    scriptId: over.scriptId ?? `deploy-${targetId}`,
    args: over.args ?? ["--target-id", targetId, "--execution-id", executionId, "--fencing-token", String(fencingToken), "--commit-sha", commit, "--artifact", `backend=sha256:${"b".repeat(64)}`],
    issuedAt: new Date(over.issuedAt ?? w.clock.t).toISOString(),
    notAfter: new Date(over.notAfter ?? w.clock.t + 5 * MIN).toISOString(),
    timeoutSeconds: 600,
    killGraceSeconds: 30,
    log: { bucket: "example-logs-dev", keyPrefix: `logs/example/dev/${targetId}/${executionId}/${dispatchToken}/` },
    commit,
    requestId: "123-1",
    project: "example",
    environment: "dev",
  };
}

function expectEventsValid(w: World): void {
  for (const e of w.sink.events) {
    const { _groupId, _dedup, ...body } = e;
    expect(validators.event(body), JSON.stringify(body)).toBeUndefined();
    expect(_groupId).toBe(body["executionId"]);
    expect(_dedup).toBe(`${String(body["commandId"])}:${String(body["seq"])}`);
  }
}

async function runToEnd(agent: Agent): Promise<void> {
  await agent.pollOnce();
  await agent.idle();
  await agent.tick();
}

// ---------------------------------------------------------------------------------------------- tests
describe("agent: exactly-once start, fencing and authorization (AC-04 §10.2–§10.4)", () => {
  it("runs a valid command once: ACCEPTED, STARTED, FINISHED, LOG_UPLOADED, in seq order, all schema-valid", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    const c = command(w);
    w.queue.push(c);
    await runToEnd(agent);
    expect(w.spawned).toEqual(["/opt/test/app-a-dev"]);
    expect(w.sink.phases(c.commandId)).toEqual(["ACCEPTED", "STARTED", "FINISHED", "LOG_UPLOADED"]);
    expect(w.sink.events.map((e) => e["seq"])).toEqual([1, 2, 3, 4]);
    const finished = w.sink.events.find((e) => e["phase"] === "FINISHED");
    expect(finished).toMatchObject({ exitCode: 0, timedOut: false, cicdResult: { status: "SUCCESS", deployedCommit: "a".repeat(40) } });
    expect(w.queue.deleted).toHaveLength(1);
    expectEventsValid(w);
  });

  it("a command never starts twice: a redelivery (also after a restart) only re-sends its last event", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    const c = command(w);
    w.queue.push(c);
    await runToEnd(agent);
    w.queue.push(c); // SQS redelivery / duplicate beyond the FIFO deduplication window
    await runToEnd(agent);
    const restarted = agentOf(w);
    await restarted.start();
    w.queue.push(c);
    await runToEnd(restarted);
    expect(w.spawned).toHaveLength(1);
    expect(w.sink.phases(c.commandId).filter((p) => p === "FINISHED").length).toBeGreaterThanOrEqual(3); // re-sent, never re-run
    expectEventsValid(w);
  });

  it("a command with an older fencing token than the last one seen for the target is rejected (STALE_FENCING), also after a restart", async () => {
    const w = newWorld();
    let agent = agentOf(w);
    await agent.start();
    w.queue.push(command(w, { fencingToken: 7 }));
    await runToEnd(agent);
    agent = agentOf(w); // the highest token survives the restart (rebuilt from the journal)
    await agent.start();
    const stale = command(w, { fencingToken: 6 });
    w.queue.push(stale);
    await runToEnd(agent);
    expect(w.spawned).toHaveLength(1);
    expect(w.sink.events.find((e) => e["commandId"] === stale.commandId)).toMatchObject({ phase: "NOT_STARTED", reason: "STALE_FENCING" });
    expectEventsValid(w);
  });

  it.each([
    ["an unknown target", { targetId: "not-in-catalog-dev" }, "REJECTED_TARGET"],
    ["a script id that is not the target's", { scriptId: "deploy-other-dev" }, "REJECTED_SCRIPT"],
    ["an injected extra argument", { args: ["--target-id", "app-a-dev", "--execution-id", "app-a-dev-999", "--fencing-token", "1", "--commit-sha", "a".repeat(40), "--exec", "rm -rf /"] }, "REJECTED_ARGS"],
    ["another agent's command", { agentId: "other-server-dev" }, "REJECTED_AGENT"],
  ])("never runs %s (%s)", async (_label, over, reason) => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    const c = command(w, over as never);
    w.queue.push(c);
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expect(w.sink.events.find((e) => e["commandId"] === c.commandId)).toMatchObject({ phase: "NOT_STARTED", reason });
    expectEventsValid(w);
  });

  it("never runs a command from a sender other than the Executor, and leaves no journal entry that could block the real one", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    const c = command(w);
    w.queue.push(c, "AROAFAKEOTHERROLE0001:attacker");
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expect(w.sink.events).toEqual([]);
    w.queue.push(c); // the genuine command with the same id still runs
    await runToEnd(agent);
    expect(w.spawned).toHaveLength(1);
  });

  it("a script path in the message is refused by the schema: no spawn", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    w.queue.push({ ...command(w), scriptId: "/bin/sh" });
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
  });
});

describe("agent: crash windows and restart recovery (AC-04 §10.3, §10.5)", () => {
  it("crash after ACCEPTED (message not deleted): the restart reports NOT_STARTED ABANDONED and the redelivery never runs it", async () => {
    const w = newWorld();
    const crashing = agentOf(w, "AFTER_ACCEPTED");
    await crashing.start();
    const c = command(w);
    w.queue.push(c);
    await expect(crashing.pollOnce()).rejects.toBeInstanceOf(SimulatedCrash);
    const agent = agentOf(w);
    await agent.start();
    await runToEnd(agent); // the message is still in the queue: redelivered
    expect(w.spawned).toEqual([]);
    expect(w.sink.phases(c.commandId)).toContain("NOT_STARTED");
    expect(w.sink.events.find((e) => e["phase"] === "NOT_STARTED")).toMatchObject({ reason: "ABANDONED" });
    expectEventsValid(w);
  });

  it("crash after DeleteMessage (before STARTING): NOT_STARTED ABANDONED, never started", async () => {
    const w = newWorld();
    const crashing = agentOf(w, "AFTER_DELETE");
    await crashing.start();
    const c = command(w);
    w.queue.push(c);
    await expect(crashing.pollOnce()).rejects.toBeInstanceOf(SimulatedCrash);
    const agent = agentOf(w);
    await agent.start();
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expect(w.sink.events.find((e) => e["phase"] === "NOT_STARTED")).toMatchObject({ reason: "ABANDONED" });
  });

  it("crash after STARTING: the restart reports LOST (unknown effect, the Executor holds the target) and never re-runs it", async () => {
    const w = newWorld();
    const crashing = agentOf(w, "AFTER_STARTING");
    await crashing.start();
    const c = command(w);
    w.queue.push(c);
    await expect(crashing.pollOnce()).rejects.toBeInstanceOf(SimulatedCrash);
    const agent = agentOf(w);
    await agent.start();
    w.queue.push(c); // a duplicate copy
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expect(w.sink.phases(c.commandId)).toContain("LOST");
    // The target is free again on the agent side for a NEWER command (the Executor decides with its hold).
    w.queue.push(command(w, { fencingToken: 999 }));
    await runToEnd(agent);
    expect(w.spawned).toHaveLength(1);
    expectEventsValid(w);
  });

  it("pending events survive restarts and are delivered in seq order when connectivity returns", async () => {
    const w = newWorld();
    w.sink.offline = true;
    const agent = agentOf(w);
    await agent.start();
    const c = command(w);
    w.queue.push(c);
    await runToEnd(agent); // the script runs although the results queue is unreachable (the lock is pinned centrally)
    expect(w.sink.events).toEqual([]);
    expect(w.spawned).toHaveLength(1);
    const restarted = agentOf(w);
    w.sink.offline = false;
    await restarted.start();
    expect(w.sink.phases(c.commandId)).toEqual(["ACCEPTED", "STARTED", "FINISHED", "LOG_UPLOADED"]);
    expect(w.sink.events.map((e) => e["seq"])).toEqual([1, 2, 3, 4]);
    expectEventsValid(w);
  });
});

describe("agent: obsolete commands and evidence queries (AC-04 §9.3, §10.2)", () => {
  it("a command received after notAfter never runs (EXPIRED), whatever the connectivity history", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    w.clock.t += 20 * MIN; // the journal is older than the command (so this is about expiry, not PREDATES_JOURNAL)
    const c = command(w, { issuedAt: w.clock.t - 10 * MIN, notAfter: w.clock.t - 5 * MIN });
    w.queue.push(c);
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expect(w.sink.events.find((e) => e["commandId"] === c.commandId)).toMatchObject({ phase: "NOT_STARTED", reason: "EXPIRED" });
  });

  it("a skewed clock refuses to start (CLOCK_SKEW); a reinstalled agent refuses commands older than its journal (PREDATES_JOURNAL)", async () => {
    const w = newWorld();
    w.clockOffset = 61_000;
    const agent = agentOf(w);
    await agent.start();
    const skewed = command(w);
    w.queue.push(skewed);
    await runToEnd(agent);
    w.clockOffset = 0;
    const old = command(w, { issuedAt: w.clock.t - 60_000, notAfter: w.clock.t + 4 * MIN }); // issued before this journal existed
    w.queue.push(old);
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expect(w.sink.events.find((e) => e["commandId"] === skewed.commandId)).toMatchObject({ reason: "CLOCK_SKEW" });
    expect(w.sink.events.find((e) => e["commandId"] === old.commandId)).toMatchObject({ reason: "PREDATES_JOURNAL" });
  });

  it("AGENT_QUERY: NEVER_SEEN only after notAfter + skew for a command younger than the journal; it then can never run; otherwise NO_RECORD", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    w.clock.t += 1000; // the journal is older than the commands below
    const c = command(w);
    const query = (n: number) => ({ specVersion: 1, type: "AGENT_QUERY", queryNumber: n, commandId: c.commandId, executionId: c.executionId, dispatchToken: c.dispatchToken, agentId: AGENT_ID, targetId: c.targetId, commandIssuedAt: c.issuedAt, notAfter: c.notAfter, issuedAt: new Date(w.clock.t).toISOString() });
    w.queue.push(query(1)); // before notAfter: FIFO order alone proves nothing
    await runToEnd(agent);
    w.clock.t = Date.parse(c.notAfter) + 61_000;
    w.queue.push(query(2));
    await runToEnd(agent);
    expect(w.sink.phases(c.commandId)).toEqual(["NO_RECORD", "NEVER_SEEN"]);
    w.queue.push(c); // a late copy of the command: it can never run now
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expectEventsValid(w);
  });

  it("AGENT_QUERY for a command the agent knows re-sends its last execution phase (FINISHED) with a new seq", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    const c = command(w);
    w.queue.push(c);
    await runToEnd(agent);
    w.queue.push({ specVersion: 1, type: "AGENT_QUERY", queryNumber: 1, commandId: c.commandId, executionId: c.executionId, dispatchToken: c.dispatchToken, agentId: AGENT_ID, targetId: c.targetId, commandIssuedAt: c.issuedAt, notAfter: c.notAfter, issuedAt: new Date(w.clock.t).toISOString() });
    await runToEnd(agent);
    const seqs = w.sink.events.filter((e) => e["commandId"] === c.commandId).map((e) => e["seq"] as number);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(w.sink.phases(c.commandId).at(-1)).toBe("FINISHED"); // the last execution phase, the closing evidence
  });
});

describe("agent: concurrency on a multi-application server (AC-04 §10.6)", () => {
  function overlaps(w: World): boolean {
    const runs = readFileSync(w.markers, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { start: number; end: number });
    const [a, b] = runs;
    return a !== undefined && b !== undefined && a.start < b.end && b.start < a.end;
  }

  it("two independent applications run in parallel", async () => {
    const w = newWorld({ maxParallel: 2, targets: { "app-a-dev": {}, "app-b-dev": {} } });
    w.control.set("app-a-dev", { sleepMs: 600 });
    w.control.set("app-b-dev", { sleepMs: 600 });
    const agent = agentOf(w);
    await agent.start();
    w.queue.push(command(w, { targetId: "app-a-dev" }));
    w.queue.push(command(w, { targetId: "app-b-dev" }));
    await runToEnd(agent);
    expect(w.spawned).toHaveLength(2);
    expect(overlaps(w)).toBe(true);
  });

  it("two applications sharing an exclusive resource never run together; the second starts when the first ends", async () => {
    const w = newWorld({ maxParallel: 2, resources: { "docker-engine": 1 }, targets: { "app-a-dev": { resources: ["docker-engine"] }, "app-c-dev": { resources: ["docker-engine"] } } });
    w.control.set("app-a-dev", { sleepMs: 400 });
    w.control.set("app-c-dev", { sleepMs: 400 });
    const agent = agentOf(w);
    await agent.start();
    w.queue.push(command(w, { targetId: "app-a-dev" }));
    w.queue.push(command(w, { targetId: "app-c-dev" }));
    await agent.pollOnce(); // only one can reserve the resource
    expect(w.spawned).toHaveLength(1);
    await agent.idle();
    await agent.tick(); // the slot is free: the waiting one starts
    await agent.idle();
    await agent.tick();
    expect(w.spawned).toHaveLength(2);
    expect(overlaps(w)).toBe(false);
  });

  it("a command that cannot get its resource before notAfter is NOT_STARTED BUSY (central retry), never started late", async () => {
    const w = newWorld({ maxParallel: 1, targets: { "app-a-dev": {}, "app-b-dev": {} } });
    w.control.set("app-a-dev", { sleepMs: 300 });
    const agent = agentOf(w);
    await agent.start();
    w.queue.push(command(w, { targetId: "app-a-dev" }));
    const waiting = command(w, { targetId: "app-b-dev", notAfter: w.clock.t + MIN });
    w.queue.push(waiting);
    await agent.pollOnce();
    w.clock.t += 2 * MIN; // past the waiting command's notAfter while the slot is still busy
    await agent.tick();
    await agent.idle();
    await agent.tick();
    expect(w.spawned).toEqual(["/opt/test/app-a-dev"]);
    expect(w.sink.events.find((e) => e["commandId"] === waiting.commandId)).toMatchObject({ phase: "NOT_STARTED", reason: "BUSY" });
  });
});

describe("agent: execution limits and logs (AC-04 §10.5, §12)", () => {
  it("a timeout kills the script (process tree), reports timedOut, and keeps the partial output", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicd-runner-"));
    roots.push(root);
    const control = { sleepMs: 60_000, stdout: "partial output before the hang" };
    const handle = startScript(
      {
        path: "/opt/test/hang",
        args: ["--target-id", "app-a-dev"],
        sudoPath: "/usr/bin/sudo",
        env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "" },
        timeoutMs: 1000,
        killGraceMs: 500,
        stdoutPath: join(root, "stdout.log"),
        stderrPath: join(root, "stderr.log"),
        capBytes: 1024 * 1024,
      },
      (_command, args, options) => spawn(process.execPath, [FIXTURE, ...args], { ...options, env: { ...options.env, CICD_TEST_CONTROL: JSON.stringify(control) } }),
    );
    const started = Date.now();
    const result = await handle.done;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(readFileSync(join(root, "stdout.log"), "utf8")).toContain("partial output before the hang");
    expect(result.cicdResult).toBeUndefined(); // it never reached its result line
  });

  it("output is capped and the truncation is reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "cicd-runner-"));
    roots.push(root);
    const control = { sleepMs: 10, stdout: "x".repeat(5000) };
    const handle = startScript(
      { path: "/opt/test/big", args: [], sudoPath: "/usr/bin/sudo", env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "" }, timeoutMs: 30_000, killGraceMs: 500, stdoutPath: join(root, "o.log"), stderrPath: join(root, "e.log"), capBytes: 1024 },
      (_command, args, options) => spawn(process.execPath, [FIXTURE, ...args], { ...options, env: { ...options.env, CICD_TEST_CONTROL: JSON.stringify(control) } }),
    );
    const result = await handle.done;
    expect(result.stdoutTruncated).toBe(true);
    expect(readFileSync(join(root, "o.log")).length).toBe(1024);
  });

  it("logs are redacted, gzipped and private; an S3 failure never loses the result and is retried, then reported FAILED after 24 h", async () => {
    const w = newWorld();
    w.s3.failing = true;
    const agent = agentOf(w);
    await agent.start();
    const c = command(w);
    w.queue.push(c);
    await runToEnd(agent);
    expect(w.sink.phases(c.commandId)).toEqual(["ACCEPTED", "STARTED", "FINISHED"]); // the result is out, the log is pending
    w.s3.failing = false;
    await agent.tick(); // retried
    expect(w.sink.phases(c.commandId).at(-1)).toBe("LOG_UPLOADED");
    const stdout = gunzipSync(w.s3.objects.get(`example-logs-dev/${c.log.keyPrefix}stdout.log.gz`) as Uint8Array).toString("utf8");
    expect(stdout).toContain("starting with");
    expect(stdout).not.toContain("hunter2-not-a-real-secret");
    expect(w.s3.objects.has(`example-logs-dev/${c.log.keyPrefix}meta.json`)).toBe(true);

    const w2 = newWorld();
    w2.s3.failing = true;
    const agent2 = agentOf(w2);
    await agent2.start();
    const c2 = command(w2);
    w2.queue.push(c2);
    await runToEnd(agent2);
    w2.clock.t += 25 * 60 * MIN;
    await agent2.tick();
    expect(w2.sink.events.find((e) => e["phase"] === "LOG_UPLOADED")).toMatchObject({ log: { status: "FAILED" } });
    expect(existsSync(join(w2.config.stateDir, "output"))).toBe(true); // the local copy is kept
    expectEventsValid(w2);
  });
});

describe("agent: more refusals and configuration (AC-04 §10.1, §10.4, §17)", () => {
  it("a second command for a target that is still running is NOT_STARTED TARGET_ACTIVE (one run per target)", async () => {
    const w = newWorld({ maxParallel: 2 });
    w.control.set("app-a-dev", { sleepMs: 500 });
    const agent = agentOf(w);
    await agent.start();
    w.queue.push(command(w, { fencingToken: 10 }));
    await agent.pollOnce(); // running
    const second = command(w, { fencingToken: 11 });
    w.queue.push(second);
    await agent.pollOnce();
    await agent.idle();
    await agent.tick();
    expect(w.spawned).toHaveLength(1);
    expect(w.sink.events.find((e) => e["commandId"] === second.commandId)).toMatchObject({ phase: "NOT_STARTED", reason: "TARGET_ACTIVE" });
  });

  it("refuses a command whose kill grace is shorter than the catalog's (REJECTED_CONFIG): the Executor's hard deadline would be too short", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    const c = { ...command(w), killGraceSeconds: 5 };
    (w.config.targets["app-a-dev"] as { killGraceSeconds: number }).killGraceSeconds = 30;
    w.queue.push(c);
    await runToEnd(agent);
    expect(w.spawned).toEqual([]);
    expect(w.sink.events.find((e) => e["commandId"] === c.commandId)).toMatchObject({ reason: "REJECTED_CONFIG" });
  });

  it.each([
    ["a relative script path", (k: { targets: Record<string, Record<string, unknown>> }) => { (k.targets["app-a-dev"] as Record<string, unknown>).path = "scripts/deploy.sh"; }],
    ["a path with ..", (k: { targets: Record<string, Record<string, unknown>> }) => { (k.targets["app-a-dev"] as Record<string, unknown>).path = "/opt/cicd/../bin/sh"; }],
    ["a missing deploy user (no sudo)", (k: { targets: Record<string, Record<string, unknown>> }) => { delete (k.targets["app-a-dev"] as Record<string, unknown>).runAs; }],
    ["an undeclared resource", (k: { targets: Record<string, Record<string, unknown>> }) => { (k.targets["app-a-dev"] as Record<string, unknown>).resources = ["gpu"]; }],
    ["a catalog of another agent", (k: Record<string, unknown>) => { k.agentId = "other-server-dev"; }],
  ])("refuses to start with %s", (_label, mutate) => {
    const config = {
      agentId: AGENT_ID,
      stage: "dev",
      region: "us-east-1",
      commandQueueUrl: "https://queue.example.invalid/cicd-agent-dev-example-server-dev-cmd.fifo",
      resultsQueueUrl: "https://queue.example.invalid/results.fifo",
      executorRoleId: EXECUTOR_ROLE,
      logBucket: "example-logs-dev",
      stateDir: "/var/lib/cicd-agent",
      resources: { "docker-engine": 1 },
    };
    const catalog: Record<string, unknown> = {
      agentId: AGENT_ID,
      targets: { "app-a-dev": { scriptId: "deploy-app-a-dev", path: "/opt/cicd/scripts/deploy-app-a-dev.sh", runAs: "deploy-app-a", timeoutSeconds: 900, resources: ["docker-engine"] } },
    };
    expect(() => loadAgentConfig(config, catalog)).not.toThrow();
    mutate(catalog as never);
    expect(() => loadAgentConfig(config, catalog)).toThrowError(/invalid agent configuration/);
  });
});

// ---------------------------------------------------------------------------------------------- shutdown and isolation
/** A long poll that only returns when the shutdown aborts it, with the batch SQS had already handed out by then. */
class LongPollQueue extends FakeQueue {
  public lateBatch: ReceivedCommandMessage[] = [];
  public override async receive(_max: number, signal?: AbortSignal): Promise<readonly ReceivedCommandMessage[]> {
    this.receives += 1;
    return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(this.lateBatch), { once: true }));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("agent: shutdown and restart on a shared production server (owner review of E3)", () => {
  it("on shutdown it stops receiving at once: the in-flight long poll is aborted and a batch that arrives anyway goes back to the queue untouched", async () => {
    const w = newWorld();
    const queue = new LongPollQueue();
    const late = queue.push(command(w));
    queue.lateBatch = [late];
    const agent = agentOf(w, undefined, { source: queue });
    await agent.start();
    const polling = agent.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queue.receives).toBe(1);
    await agent.beginShutdown();
    await polling; // the long poll returned at once
    await agent.pollOnce();
    expect(queue.receives).toBe(1); // nothing is received once the shutdown began
    expect(queue.visibility).toEqual([[late.receiptHandle, 0]]); // handed back, visible again at once
    expect(queue.deleted).toEqual([]);
    expect(w.spawned).toEqual([]);
    expect(w.sink.events).toEqual([]);
    expect(new AgentStateStore(w.config.stateDir, w.clock.t).entries()).toEqual([]);
  });

  it("commands waiting for a slot go back to the queue, the running script finishes within the grace and nothing new starts; after the restart the waiting command runs once and the finished one never again", async () => {
    const w = newWorld({ maxParallel: 1, targets: { "app-a-dev": {}, "app-b-dev": {} } });
    w.control.set("app-a-dev", { sleepMs: 1500 });
    const a = command(w, { targetId: "app-a-dev" });
    const b = command(w, { targetId: "app-b-dev" });
    w.queue.push(a);
    const mb = w.queue.push(b);
    const agent = agentOf(w);
    await agent.start();
    await agent.pollOnce();
    expect(w.spawned).toHaveLength(1);

    const outcome = await agent.shutdown(10_000);
    expect(outcome).toEqual({ finished: 1, interrupted: 0 });
    expect(w.sink.phases(a.commandId)).toEqual(["ACCEPTED", "STARTED", "FINISHED", "LOG_UPLOADED"]);
    expect(w.queue.visibility).toContainEqual([mb.receiptHandle, 0]);
    expect(w.queue.deleted).not.toContain(mb.receiptHandle);
    expect(w.spawned).toHaveLength(1); // b never started during the drain
    expect(new AgentStateStore(w.config.stateDir, w.clock.t).getEntry(b.commandId)).toBeUndefined();

    const restarted = agentOf(w);
    await restarted.start();
    await runToEnd(restarted);
    expect(w.spawned).toHaveLength(2);
    expect(w.sink.phases(b.commandId)).toContain("FINISHED");
    w.queue.push(a); // a late copy of the finished command
    await runToEnd(restarted);
    expect(w.spawned).toHaveLength(2);
    expectEventsValid(w);
  });

  it("a command that reaches the queue while the agent is stopped and expires before it is back is never run after the restart", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    await agent.shutdown(1000);
    const c = command(w, { notAfter: w.clock.t + 1 * MIN });
    const m = w.queue.push(c);
    w.clock.t += 3 * MIN;

    const restarted = agentOf(w);
    await restarted.start();
    await runToEnd(restarted);
    expect(w.spawned).toEqual([]);
    expect(w.sink.phases(c.commandId)).toEqual(["NOT_STARTED"]);
    expect(w.sink.events.find((e) => e["commandId"] === c.commandId)?.["reason"]).toBe("EXPIRED");
    expect(w.queue.deleted).toContain(m.receiptHandle);
    expectEventsValid(w);
  });

  it("past the grace a running script is interrupted and reported LOST, never FINISHED; its events wait in the outbox across the restart, the partial output is kept, and it never runs again", async () => {
    const w = newWorld();
    w.control.set("app-a-dev", { sleepMs: 20_000 });
    const c = command(w);
    w.queue.push(c);
    const agent = agentOf(w);
    await agent.start();
    await agent.pollOnce();
    w.sink.offline = true;

    const outcome = await agent.shutdown(300);
    expect(outcome).toEqual({ finished: 0, interrupted: 1 });
    expect(new AgentStateStore(w.config.stateDir, w.clock.t).getEntry(c.commandId)?.state).toBe("LOST");
    expect(w.sink.phases(c.commandId)).toEqual(["ACCEPTED", "STARTED"]);
    const stdout = w.s3.objects.get(`example-logs-dev/${c.log.keyPrefix}stdout.log.gz`);
    expect(stdout).toBeDefined();
    expect(gunzipSync(stdout as Uint8Array).toString("utf8")).toContain("starting with");

    w.sink.offline = false;
    const restarted = agentOf(w);
    await restarted.start();
    expect(w.sink.phases(c.commandId)).toEqual(["ACCEPTED", "STARTED", "LOST", "LOG_UPLOADED"]);
    w.queue.push(c);
    await runToEnd(restarted);
    expect(w.spawned).toHaveLength(1);
    expectEventsValid(w);
  });
});

describe("agent: isolation from the applications it deploys (owner review of E3)", () => {
  it("stopping the agent never kills application processes a deploy started, detached or still holding the script output", async () => {
    const w = newWorld({ targets: { "app-a-dev": {}, "app-b-dev": {} } });
    const pidFiles = [join(w.root, "app-a.pid"), join(w.root, "app-b.pid")];
    w.control.set("app-a-dev", { spawnApp: { pidFile: pidFiles[0] as string } });
    w.control.set("app-b-dev", { spawnApp: { pidFile: pidFiles[1] as string, holdStdout: true } });
    const a = command(w, { targetId: "app-a-dev" });
    const b = command(w, { targetId: "app-b-dev" });
    w.queue.push(a);
    w.queue.push(b);
    const warnings: string[] = [];
    const agent = agentOf(w, undefined, { stdioDrainMs: 300, logger: { ...quiet, warn: (m: string) => warnings.push(m) } });
    await agent.start();
    const t0 = Date.now();
    await runToEnd(agent);
    const apps = pidFiles.map((p) => Number(readFileSync(p, "utf8")));
    try {
      // The held pipe did not keep the run open until its timeout: the run ended with the script.
      expect(Date.now() - t0).toBeLessThan(5000);
      for (const c of [a, b]) {
        const finished = w.sink.events.find((e) => e["commandId"] === c.commandId && e["phase"] === "FINISHED");
        expect(finished?.["exitCode"]).toBe(0);
      }
      expect(warnings.some((m) => m.includes("left processes behind"))).toBe(true);
      await agent.shutdown(1000);
      for (const pid of apps) expect(alive(pid)).toBe(true);
    } finally {
      for (const pid of apps) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
    }
  });

  it.skipIf(process.platform === "win32")("POSIX: a process the script left in its own process group is reported, and never signaled", async () => {
    const w = newWorld();
    const pidFile = join(w.root, "app.pid");
    w.control.set("app-a-dev", { spawnApp: { pidFile, sameGroup: true } });
    w.queue.push(command(w));
    const warnings: Record<string, unknown>[] = [];
    const agent = agentOf(w, undefined, { stdioDrainMs: 300, logger: { ...quiet, warn: (_m: string, fields?: Record<string, unknown>) => warnings.push(fields ?? {}) } });
    await agent.start();
    await runToEnd(agent);
    const app = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(warnings.some((fields) => fields["inProcessGroup"] === true)).toBe(true);
      await agent.shutdown(1000);
      expect(alive(app)).toBe(true);
    } finally {
      try {
        process.kill(app);
      } catch {
        // already gone
      }
    }
  });

  it("scripts run through sudo as a deploy user, or as the agent user itself where the agent has no sudo (runAs self)", () => {
    const config = {
      agentId: AGENT_ID,
      stage: "dev",
      region: "us-east-1",
      commandQueueUrl: "https://queue.example.invalid/cicd-agent-dev-example-server-dev-cmd.fifo",
      resultsQueueUrl: "https://queue.example.invalid/results.fifo",
      executorRoleId: EXECUTOR_ROLE,
      logBucket: "example-logs-dev",
      stateDir: "/opt/cicd-agent/data",
    };
    const target = { scriptId: "deploy-app-a-dev", path: "/opt/cicd/scripts/deploy-app-a-dev.sh", timeoutSeconds: 900 };
    const viaSudo = loadAgentConfig(config, { agentId: AGENT_ID, targets: { "app-a-dev": { ...target, runAs: "deploy-app-a" } } });
    expect(viaSudo.targets["app-a-dev"]?.runAs).toBe("deploy-app-a");
    const self = loadAgentConfig(config, { agentId: AGENT_ID, targets: { "app-a-dev": { ...target, runAs: "self" } } });
    expect(self.targets["app-a-dev"]?.runAs).toBeUndefined();
    expect(() => loadAgentConfig(config, { agentId: AGENT_ID, targets: { "app-a-dev": target } })).toThrowError(/runAs is required/);
    // A local SQS emulator on the loopback interface is accepted; plain http anywhere else is not.
    expect(loadAgentConfig({ ...config, commandQueueUrl: "http://127.0.0.1:9324/queue/cmd.fifo" }, { agentId: AGENT_ID, targets: { "app-a-dev": { ...target, runAs: "self" } } }).commandQueueUrl).toContain("127.0.0.1");
    expect(() => loadAgentConfig({ ...config, commandQueueUrl: "http://queue.example.invalid/cmd.fifo" }, { agentId: AGENT_ID, targets: { "app-a-dev": { ...target, runAs: "self" } } })).toThrowError(/commandQueueUrl/);
  });

  it("consumes only its own command queue: with a shared IAM identity, another agent's queue or stage is refused at start", () => {
    const config = {
      agentId: AGENT_ID,
      stage: "dev",
      region: "us-east-1",
      commandQueueUrl: "https://queue.example.invalid/123456789012/cicd-agent-dev-example-server-dev-cmd.fifo",
      resultsQueueUrl: "https://queue.example.invalid/123456789012/cicd-agent-results-dev.fifo",
      executorRoleId: EXECUTOR_ROLE,
      logBucket: "example-logs-dev",
      stateDir: "/opt/cicd-agent/data",
    };
    const catalog = { agentId: AGENT_ID, targets: { "app-a-dev": { scriptId: "deploy-app-a-dev", path: "/opt/cicd/scripts/deploy-app-a-dev.sh", runAs: "self", timeoutSeconds: 900 } } };
    expect(loadAgentConfig(config, catalog).commandQueueUrl).toBe(config.commandQueueUrl);
    for (const name of ["cicd-agent-dev-other-server-dev-cmd.fifo", "cicd-agent-prod-example-server-dev-cmd.fifo", "cicd-agent-dev-example-server-dev-dlq.fifo", "cicd-agent-results-dev.fifo", "xcicd-agent-dev-example-server-dev-cmd.fifo"]) {
      expect(() => loadAgentConfig({ ...config, commandQueueUrl: `https://queue.example.invalid/123456789012/${name}` }, catalog), name).toThrowError(/must be this agent's own queue \(cicd-agent-dev-example-server-dev-cmd\.fifo\)/);
    }
  });

  it("defaults: two scripts in parallel, and a shutdown grace that never cuts a script short of its own timeout", () => {
    const config = {
      agentId: AGENT_ID,
      stage: "dev",
      region: "us-east-1",
      commandQueueUrl: "https://queue.example.invalid/cicd-agent-dev-example-server-dev-cmd.fifo",
      resultsQueueUrl: "https://queue.example.invalid/results.fifo",
      executorRoleId: EXECUTOR_ROLE,
      logBucket: "example-logs-dev",
      stateDir: "/var/lib/cicd-agent",
    };
    const catalog = {
      agentId: AGENT_ID,
      targets: {
        "app-a-dev": { scriptId: "deploy-app-a-dev", path: "/opt/cicd/scripts/deploy-app-a-dev.sh", runAs: "deploy-app-a", timeoutSeconds: 900 },
        "app-b-dev": { scriptId: "deploy-app-b-dev", path: "/opt/cicd/scripts/deploy-app-b-dev.sh", runAs: "deploy-app-b", timeoutSeconds: 1800, killGraceSeconds: 60 },
      },
    };
    const loaded = loadAgentConfig(config, catalog);
    expect(loaded.maxParallel).toBe(2);
    expect(loaded.shutdownGraceSeconds).toBe(1860);
    expect(loadAgentConfig({ ...config, shutdownGraceSeconds: 120 }, catalog).shutdownGraceSeconds).toBe(120);
    expect(() => loadAgentConfig({ ...config, shutdownGraceSeconds: 5000 }, catalog)).toThrowError(/shutdownGraceSeconds/);
  });
});

describe("agent: recovery after an abrupt end of the agent process, without systemd (owner review of E3)", () => {
  /** Simulates /proc for the journaled pids: a process is "ours" while it lives; signals are recorded and applied. */
  function inspectorFor(w: World, opts: { ignoreTerm?: boolean; startedAt?: number } = {}) {
    const signals: [number, string][] = [];
    const killed = new Set<number>();
    const inspector: ProcessInspector = {
      startTimeMs: (pid) => (alive(pid) && !killed.has(pid) ? (opts.startedAt ?? w.clock.t) : undefined),
      signalGroup: (pgid, signal) => {
        signals.push([pgid, signal]);
        if (signal === "SIGKILL" || !opts.ignoreTerm) {
          killed.add(pgid);
          try {
            process.kill(pgid);
          } catch {
            // already gone
          }
        }
      },
    };
    return { inspector, signals };
  }

  /** What an agent process that died abruptly leaves behind: a running script and its STARTED journal entry. */
  function orphan(w: World, c: ReturnType<typeof command>): number {
    const child = spawn(process.execPath, [FIXTURE, ...c.args], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: { ...process.env, CICD_TEST_CONTROL: JSON.stringify({ sleepMs: 30_000 }) },
    });
    child.unref();
    const store = new AgentStateStore(w.config.stateDir, w.clock.t);
    store.putEntry({
      commandId: c.commandId,
      executionId: c.executionId,
      dispatchToken: c.dispatchToken,
      fencingToken: c.fencingToken,
      targetId: c.targetId,
      scriptId: c.scriptId,
      issuedAt: w.clock.t,
      notAfter: Date.parse(c.notAfter),
      state: "STARTED",
      acceptedAt: w.clock.t,
      startingAt: w.clock.t,
      startedAt: w.clock.t,
      pid: child.pid as number,
      nextSeq: 3,
      log: { bucket: c.log.bucket, keyPrefix: c.log.keyPrefix, status: "NONE", attempts: 0 },
      command: c,
    });
    store.putTarget(c.targetId, { highestFencingToken: c.fencingToken, activeCommandId: c.commandId });
    return child.pid as number;
  }

  it("a script still running after the agent process died is stopped before any command is received, reported LOST, and never re-run", async () => {
    const w = newWorld();
    const c = command(w);
    const pid = orphan(w, c);
    expect(alive(pid)).toBe(true);
    const later = command(w, { targetId: "app-a-dev" });
    w.queue.push(later);
    const receivesBefore = w.queue.receives;

    const { inspector, signals } = inspectorFor(w);
    const restarted = agentOf(w, undefined, { processes: inspector });
    await restarted.start();
    expect(signals).toEqual([[pid, "SIGTERM"]]);
    expect(w.queue.receives).toBe(receivesBefore); // stopped before anything was received
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(false);
    expect(w.sink.phases(c.commandId)).toEqual(["LOST", "LOG_UPLOADED"]); // partial logs uploaded too

    w.queue.push(c); // a late copy of the interrupted command
    await runToEnd(restarted);
    expect(w.spawned).toHaveLength(1); // only `later` started; the interrupted command never again
    expect(w.sink.phases(later.commandId)).toContain("FINISHED");
    expectEventsValid(w);
  });

  it("a script that ignores SIGTERM gets SIGKILL after its kill grace", async () => {
    const w = newWorld();
    const c = command(w);
    const pid = orphan(w, c);
    const { inspector, signals } = inspectorFor(w, { ignoreTerm: true });
    await agentOf(w, undefined, { processes: inspector }).start();
    expect(signals).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
    expect(w.sink.phases(c.commandId)).toEqual(["LOST", "LOG_UPLOADED"]); // partial logs uploaded too
  }, 20_000);

  it("never signals a pid that now belongs to another process, nor a script that already exited (what it left behind is not the agent's)", async () => {
    const w = newWorld();
    const c = command(w);
    const pid = orphan(w, c);
    try {
      // Recycled pid: alive, but started long after the journaled spawn.
      const recycled = inspectorFor(w, { startedAt: w.clock.t + 10 * MIN });
      await agentOf(w, undefined, { processes: recycled.inspector }).start();
      expect(recycled.signals).toEqual([]);
      expect(alive(pid)).toBe(true);
      expect(w.sink.phases(c.commandId)).toEqual(["LOST", "LOG_UPLOADED"]); // partial logs uploaded too
    } finally {
      process.kill(pid);
    }
  });

  it("with no deploy running it stops at once and exits cleanly", async () => {
    const w = newWorld();
    const agent = agentOf(w);
    await agent.start();
    await agent.pollOnce();
    const t0 = Date.now();
    expect(await agent.shutdown()).toEqual({ finished: 0, interrupted: 0 });
    expect(Date.now() - t0).toBeLessThan(200);
    const receives = w.queue.receives;
    await agent.pollOnce();
    expect(w.queue.receives).toBe(receives);
  });
});
