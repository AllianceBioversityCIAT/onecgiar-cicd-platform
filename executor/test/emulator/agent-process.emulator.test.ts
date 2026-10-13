// @akili-spec changes/cicd-executor-poc architecture-change-04 §10, §23
//
// The agent as a REAL process, started the way an operator would: `node dist/src/agent/main.js`, with no systemd, no
// PM2 and no other supervisor, against the ElasticMQ emulator (local only, no AWS). It starts from its home directory,
// long-polls its FIFO command queue, sends heartbeats, drops a command whose sender is not the Executor role
// (ElasticMQ's SenderId is the client address, so no command from here can ever be authorized: authorized commands are
// covered by test/unit/agent.test.ts with the same Agent and real scripts), and on a stop request exits 0 at once when
// idle, with its in-flight 20 s long poll aborted. The signal variant runs on POSIX only (Windows cannot deliver
// SIGTERM to a handler); Linux supervisors (PM2, systemd) are E5 checks.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const endpoint = process.env["SQS_LOCAL_ENDPOINT"];
const EXECUTOR_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAIN = join(EXECUTOR_ROOT, "dist", "src", "agent", "main.js");
const AGENT_ID = "example-server-dev";

describe.skipIf(endpoint === undefined)("the agent as a plain Node.js process (no systemd, no PM2) against ElasticMQ", () => {
  let client: SQSClient;
  let commandQueueUrl: string;
  let resultsQueueUrl: string;
  const homes: string[] = [];

  beforeAll(async () => {
    // The process under test is the BUILT entry point, exactly what gets installed.
    const build = spawnSync(process.execPath, [join(EXECUTOR_ROOT, "node_modules", "typescript", "bin", "tsc")], { cwd: EXECUTOR_ROOT, encoding: "utf8" });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    client = new SQSClient({ endpoint: endpoint as string, region: "us-east-1" });
    const stamp = String(Date.now());
    const create = async (name: string) =>
      (await client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }))).QueueUrl as string;
    commandQueueUrl = await create(`cicd-agent-proc-${stamp}-cmd.fifo`);
    resultsQueueUrl = await create(`cicd-agent-proc-${stamp}-results.fifo`);
  }, 180_000);

  afterAll(async () => {
    for (const q of [commandQueueUrl, resultsQueueUrl]) if (q !== undefined) await client.send(new DeleteQueueCommand({ QueueUrl: q })).catch(() => undefined);
    client.destroy();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  /** An installation home as in infra/agent/README.md: config/ (agent.json, catalog.json) and data/. */
  function newHome(): string {
    const home = mkdtempSync(join(tmpdir(), "cicd-agent-home-"));
    homes.push(home);
    mkdirSync(join(home, "config"));
    writeFileSync(
      join(home, "config", "agent.json"),
      JSON.stringify({
        agentId: AGENT_ID,
        stage: "dev",
        region: "us-east-1",
        commandQueueUrl,
        resultsQueueUrl,
        executorRoleId: "AROAFAKEEXECUTORROL01",
        logBucket: "example-logs-dev",
        stateDir: join(home, "data"),
        heartbeatSeconds: 5,
      }),
    );
    writeFileSync(
      join(home, "config", "catalog.json"),
      JSON.stringify({ agentId: AGENT_ID, targets: { "app-a-dev": { scriptId: "deploy-app-a-dev", path: "/opt/cicd/scripts/never-run.sh", runAs: "self", timeoutSeconds: 60, killGraceSeconds: 5 } } }),
    );
    return home;
  }

  interface Running {
    readonly child: ChildProcess;
    readonly lines: Record<string, unknown>[];
    waitFor(message: string, ms?: number): Promise<void>;
    exited(ms?: number): Promise<number | null>;
  }

  function startAgent(home: string): Running {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CICD_AGENT_HOME: home,
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      AWS_REGION: "us-east-1",
      AWS_EC2_METADATA_DISABLED: "true",
    };
    // No supervisor of any kind.
    for (const key of ["INVOCATION_ID", "NOTIFY_SOCKET", "JOURNAL_STREAM", "PM2_HOME", "pm_id", "PM2_USAGE"]) delete env[key];
    const child = spawn(process.execPath, [MAIN], { cwd: home, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const lines: Record<string, unknown>[] = [];
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          lines.push({ message: line });
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return {
      child,
      lines,
      async waitFor(message, ms = 20_000) {
        const until = Date.now() + ms;
        while (!lines.some((l) => String(l["message"]).includes(message))) {
          if (Date.now() > until) throw new Error(`no "${message}" in ${JSON.stringify(lines)}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      exited: (ms = 15_000) => Promise.race([exit, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]),
    };
  }

  async function messagesIn(queueUrl: string): Promise<number> {
    const a = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    return Number(a.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(a.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  }

  test("starts directly with node, polls its queue, heartbeats, drops an unauthorized command, and exits 0 at once on a stop request", async () => {
    expect(existsSync(MAIN)).toBe(true);
    const home = newHome();
    const agent = startAgent(home);
    try {
      await agent.waitFor("agent started");

      // Heartbeat on the results queue (group = agent).
      let heartbeat: Record<string, unknown> | undefined;
      for (let i = 0; i < 10 && heartbeat === undefined; i += 1) {
        const out = await client.send(new ReceiveMessageCommand({ QueueUrl: resultsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
        heartbeat = (out.Messages ?? []).map((m) => JSON.parse(m.Body as string) as Record<string, unknown>).find((b) => b["type"] === "AGENT_HEARTBEAT");
      }
      expect(heartbeat?.["agentId"]).toBe(AGENT_ID);

      // A command from anyone but the Executor role: received from the real queue, deleted, never journaled or run.
      await client.send(new SendMessageCommand({ QueueUrl: commandQueueUrl, MessageBody: JSON.stringify({ type: "AGENT_COMMAND" }), MessageGroupId: "app-a-dev", MessageDeduplicationId: `forged-${String(Date.now())}` }));
      await agent.waitFor("command from an unauthorized sender dropped");
      expect(await messagesIn(commandQueueUrl)).toBe(0);
      expect(readdirSync(join(home, "data", "journal"))).toEqual([]);

      // Stop request while idle (its 20 s long poll in flight): drains nothing and exits 0 at once.
      const t0 = Date.now();
      agent.child.send("shutdown");
      expect(await agent.exited()).toBe(0);
      expect(Date.now() - t0).toBeLessThan(10_000);
      await agent.waitFor("agent stopped", 1000);
    } finally {
      if (agent.child.exitCode === null) agent.child.kill();
    }
  }, 120_000);

  test.skipIf(process.platform === "win32")("POSIX: SIGTERM and SIGINT stop it the same way", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const agent = startAgent(newHome());
      try {
        await agent.waitFor("agent started");
        agent.child.kill(signal);
        expect(await agent.exited()).toBe(0);
        await agent.waitFor("agent stopped", 1000);
      } finally {
        if (agent.child.exitCode === null) agent.child.kill("SIGKILL");
      }
    }
  }, 120_000);

  test("a missing or invalid configuration refuses to start (exit 1) without touching anything", async () => {
    const home = newHome();
    writeFileSync(join(home, "config", "catalog.json"), JSON.stringify({ agentId: "another-agent", targets: {} }));
    const agent = startAgent(home);
    expect(await agent.exited()).toBe(1);
    await agent.waitFor("agent refused to start", 1000);
    expect(existsSync(join(home, "data"))).toBe(false);
  }, 60_000);
});
