#!/usr/bin/env node
// architecture-change-04 E5 (TEST server pilot). Builds ONE schema-valid AGENT_COMMAND or AGENT_QUERY for a manual
// test, writes it to a JSON file and prints the exact `aws sqs send-message` command (FIFO group and deduplication
// ids as the Executor would set them). It makes NO AWS call: the owner sends the file under the Executor role.
// Needs the repository built once (`cd executor && npm ci && npm run build`).
//
//   node infra/agent/pilot/make-message.mjs command --agent <agentId> --target <targetId> --script <scriptId>
//        --execution <prefix-N> --fencing <N> --bucket <logBucket> --project <project> --environment <env>
//        [--not-after-seconds 300] [--timeout-seconds 300] [--kill-grace-seconds 30] [--commit <40 hex>] [--out <dir>]
//   node infra/agent/pilot/make-message.mjs query --from <command.json> --number <N> [--out <dir>]
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = (p) => pathToFileURL(join(repo, "executor", "dist", "src", p)).href;
const { commandIdOf, fifo } = await import(dist("domain/agent-protocol/index.js"));
const { createAgentContractValidators } = await import(dist("application/agent-transport/validators.js"));
const { BundledSchemaSource } = await import(dist("adapters/bundled-schema-source/index.js"));

const [kind, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i].startsWith("--") || rest[i + 1] === undefined) fail(`bad option near "${rest[i]}"`);
  opt[rest[i].slice(2)] = rest[i + 1];
}
function fail(message) {
  console.error(`make-message: ${message}`);
  process.exit(2);
}
const need = (name) => opt[name] ?? fail(`--${name} is required`);
const int = (name, fallback) => {
  const v = Number(opt[name] ?? fallback);
  if (!Number.isInteger(v)) fail(`--${name} must be an integer`);
  return v;
};

const validators = await createAgentContractValidators(new BundledSchemaSource());
const now = new Date();
let body;
let groupId;
let dedupId;
let name;

if (kind === "command") {
  const targetId = need("target");
  const executionId = need("execution");
  const fencingToken = int("fencing");
  const dispatchToken = opt["dispatch-token"] ?? randomUUID();
  const commit = opt.commit ?? "a".repeat(40);
  const project = need("project");
  const environment = need("environment");
  const commandId = commandIdOf(executionId, dispatchToken);
  body = {
    specVersion: 1,
    type: "AGENT_COMMAND",
    commandId,
    executionId,
    dispatchToken,
    fencingToken,
    agentId: need("agent"),
    targetId,
    scriptId: need("script"),
    // The AC-03 vector a catalog entry with "arguments": "standard" requires, exactly in this order.
    args: ["--target-id", targetId, "--execution-id", executionId, "--fencing-token", String(fencingToken), "--commit-sha", commit],
    issuedAt: now.toISOString(),
    notAfter: new Date(now.getTime() + int("not-after-seconds", 300) * 1000).toISOString(),
    timeoutSeconds: int("timeout-seconds", 300),
    killGraceSeconds: int("kill-grace-seconds", 30),
    log: { bucket: need("bucket"), keyPrefix: `logs/${project}/${environment}/${targetId}/${executionId}/${dispatchToken}/` },
    commit,
    requestId: `${Math.floor(now.getTime() / 1000)}-1`,
    project,
    environment,
  };
  const problems = validators.command(body);
  if (problems !== undefined) fail(`invalid command: ${problems.join("; ")}`);
  groupId = fifo.commandGroup(targetId);
  dedupId = fifo.commandDeduplication(commandId);
  name = `command-${executionId}`;
} else if (kind === "query") {
  const command = JSON.parse(readFileSync(need("from"), "utf8"));
  const queryNumber = int("number");
  body = {
    specVersion: 1,
    type: "AGENT_QUERY",
    queryNumber,
    commandId: command.commandId,
    executionId: command.executionId,
    dispatchToken: command.dispatchToken,
    agentId: command.agentId,
    targetId: command.targetId,
    commandIssuedAt: command.issuedAt,
    notAfter: command.notAfter,
    issuedAt: now.toISOString(),
  };
  const problems = validators.query(body);
  if (problems !== undefined) fail(`invalid query: ${problems.join("; ")}`);
  groupId = fifo.commandGroup(command.targetId);
  dedupId = fifo.queryDeduplication(command.commandId, queryNumber);
  name = `query-${command.executionId}-q${queryNumber}`;
} else {
  fail('the first argument must be "command" or "query"');
}

const out = resolve(opt.out ?? ".");
mkdirSync(out, { recursive: true });
const file = join(out, `${name}.json`);
writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
const fileUri = `file://${file.replace(/\\/g, "/")}`;
console.log(`written: ${file}`);
console.log(`commandId: ${body.commandId}`);
console.log(`notAfter: ${body.notAfter}`);
console.log("send it under the Executor role (PowerShell, one line):");
console.log(`aws sqs send-message --queue-url $CMD_QUEUE_URL --message-group-id "${groupId}" --message-deduplication-id "${dedupId}" --message-body "${fileUri}" --region $REGION --profile $EXECUTOR_PROFILE`);
