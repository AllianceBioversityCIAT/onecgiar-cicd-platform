// @akili-spec changes/cicd-executor-poc architecture-change-04 §10, §11, §23
// Agent process entry point: a plain, long-running Node.js process. It needs no systemd, PM2 or other supervisor and
// behaves the same under any of them (see infra/agent/README.md):
//   node <home>/dist/src/agent/main.js                 directly
//   pm2 start <home>/dist/src/agent/main.js --name cicd-agent ...   under an existing, supervised PM2 daemon
// Files: <home>/config/agent.json and catalog.json (root-owned), the state directory from the configuration
// (journal, outbox, captured output), operational logs as JSON lines on stdout/stderr (the supervisor or a redirect
// keeps them). <home> is CICD_AGENT_HOME (default /opt/cicd-agent); CICD_AGENT_CONFIG / CICD_AGENT_CATALOG override.
// AWS credentials come from the SDK default chain (instance profile on EC2, IAM Roles Anywhere `credential_process`
// on premises, AP-5); the agent never stores credentials.
// Stopping: SIGTERM, SIGINT or the IPC message "shutdown" (PM2's --shutdown-with-message, Windows) make the agent
// drain (Agent.shutdown): no new command is received or started, commands waiting for a slot go back to the queue,
// running scripts get `shutdownGraceSeconds`, then the process exits 0 by itself. A supervisor's kill timeout must
// exceed that grace plus the longest kill grace. An abrupt end (SIGKILL, crash) is safe too: the next start stops any
// script still running from this process and reports it LOST (Agent.start).
// Idle cost: one 20 s long poll at a time, one heartbeat per `heartbeatSeconds`, no journal reads or writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { BundledSchemaSource } from "../adapters/bundled-schema-source/index.js";
import { createAgentContractValidators } from "../application/agent-transport/validators.js";
import { Agent } from "./agent.js";
import { createS3LogStore, createSqsCommandSource, createSqsEventSink, createStsScriptCredentials, type AssumeRoleFn } from "./adapters.js";
import { AgentConfigError, loadAgentConfig } from "./config.js";
import { AgentStateStore } from "./state-store.js";

const logger = {
  info: (message: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message: string, fields: Record<string, unknown> = {}) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};

const POLL_RETRY_MIN_MS = 5_000;
const POLL_RETRY_MAX_MS = 60_000;

async function main(): Promise<void> {
  const home = process.env["CICD_AGENT_HOME"] ?? "/opt/cicd-agent";
  const configPath = process.env["CICD_AGENT_CONFIG"] ?? join(home, "config", "agent.json");
  const catalogPath = process.env["CICD_AGENT_CATALOG"] ?? join(home, "config", "catalog.json");
  const config = loadAgentConfig(JSON.parse(readFileSync(configPath, "utf8")), JSON.parse(readFileSync(catalogPath, "utf8")));

  const sqs = new SQSClient({ region: config.region });
  const s3 = new S3Client({ region: config.region });
  let assumeRole: AssumeRoleFn | undefined;
  if (Object.values(config.targets).some((t) => t.scriptRoleArn !== undefined)) {
    const sts = new STSClient({ region: config.region });
    assumeRole = async (input) => (await sts.send(new AssumeRoleCommand(input))).Credentials ?? {};
  }

  const validators = await createAgentContractValidators(new BundledSchemaSource());
  const agent = new Agent({
    config,
    store: new AgentStateStore(config.stateDir, Date.now()),
    source: createSqsCommandSource(sqs, config.commandQueueUrl),
    sink: createSqsEventSink(sqs, config.resultsQueueUrl),
    logs: createS3LogStore(async (input) => {
      await s3.send(new PutObjectCommand(input));
    }),
    ...(assumeRole === undefined ? {} : { credentials: createStsScriptCredentials(assumeRole) }),
    validators,
    clock: { now: () => Date.now() },
    clockOffsetMs: () => (sqs.config as { systemClockOffset?: number }).systemClockOffset ?? 0,
    logger,
  });

  await agent.start();
  agent.startHeartbeat();
  logger.info("agent started", { agentId: config.agentId, targets: Object.keys(config.targets), maxParallel: config.maxParallel, shutdownGraceSeconds: config.shutdownGraceSeconds });

  let stopping: Promise<void> | undefined;
  let wake: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const stop = (signal: string): void => {
    if (stopping !== undefined) return; // a second signal does not cut the drain short (SIGKILL does, safely)
    wake();
    logger.info("agent stopping: draining", { signal });
    stopping = agent.shutdown().then((outcome) => {
      agent.stopHeartbeat();
      logger.info("agent stopped", outcome);
    });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("message", (message) => {
    if (message === "shutdown") stop("shutdown message");
  });

  let retryMs = POLL_RETRY_MIN_MS;
  while (!agent.isDraining) {
    try {
      await agent.pollOnce();
      retryMs = POLL_RETRY_MIN_MS;
    } catch (error) {
      // Connectivity or AWS errors: back off (5 s doubling to 60 s); nothing is lost (journal, outbox, SQS).
      logger.error("poll failed; retrying", { error: error instanceof Error ? error.message : String(error), retryInMs: retryMs });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([new Promise((resolve) => (timer = setTimeout(resolve, retryMs))), stopRequested]);
      clearTimeout(timer);
      retryMs = Math.min(retryMs * 2, POLL_RETRY_MAX_MS);
    }
  }
  await stopping;
  sqs.destroy();
  s3.destroy();
  process.disconnect?.(); // an IPC channel (PM2, tests) would keep the process alive
}

main().catch((error: unknown) => {
  if (error instanceof AgentConfigError) logger.error("agent refused to start", { problems: error.problems });
  else logger.error("agent refused to start", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
