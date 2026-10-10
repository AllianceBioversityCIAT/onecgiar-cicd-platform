// @akili-spec changes/cicd-executor-poc architecture-change-04 §5, §6, §7, §10.2
//
// Contract tests for the SQS_AGENT schemas (repo root): agent-record, agent-command, agent-query, agent-event and
// agent-heartbeat. Proves that each schema compiles under the RUNTIME Ajv options (strict mode), accepts its valid
// fixture, rejects one fixture per rule, and that the three message contracts are coherent with each other and
// with the identities of domain/agent-protocol (same id formats, FIFO id limits). Placeholder values only (DD-23).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPluginOptions } from "ajv-formats";
import { commandIdOf, fifo, FIFO_ID_MAX_LENGTH, parseCommandId } from "../../src/domain/agent-protocol/index.js";
import {
  agentCommandSchemaPath,
  agentEventSchemaPath,
  agentHeartbeatSchemaPath,
  agentQuerySchemaPath,
  agentRecordSchemaPath,
  deployRequestSchemaPath,
} from "./support/schema-paths.js";

const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

/** Obviously fake queue base: AWS's documentation account id (publication policy, DD-23). */
const FAKE_SQS_QUEUE_BASE = "https://sqs.us-east-1.amazonaws.com/123456789012";
type Json = Record<string, unknown>;
const read = (p: string): Json => JSON.parse(readFileSync(p, "utf8")) as Json;

/** The runtime options (registry adapter, admin tool): strict mode including strictRequired. */
function compileRuntime(schemaPath: string): ValidateFunction {
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(read(schemaPath));
}

// Longest legal ids: a 63-character targetId, a 12-digit sequence, a UUID token, a 40-character agentId.
const LONG_TARGET = `a${"b".repeat(62)}`;
const LONG_EXECUTION = `${LONG_TARGET}-${"9".repeat(12)}`;
const TOKEN = "0f8b3c1e-2a4d-4b6f-8c9e-1a2b3c4d5e6f";
const LONG_AGENT = `a${"b".repeat(39)}`;

const EXECUTION = "example-app-dev-7";
const COMMAND_ID = commandIdOf(EXECUTION, TOKEN);

function command(overrides: Json = {}): Json {
  return {
    specVersion: 1,
    type: "AGENT_COMMAND",
    commandId: COMMAND_ID,
    executionId: EXECUTION,
    dispatchToken: TOKEN,
    fencingToken: 12,
    agentId: "example-server-dev",
    targetId: "example-app-dev",
    scriptId: "deploy-example-app-dev",
    args: ["--target-id", "example-app-dev", "--execution-id", EXECUTION, "--fencing-token", "12", "--commit-sha", "a".repeat(40), "--artifact", `backend=sha256:${"b".repeat(64)}`],
    issuedAt: "2026-10-10T20:00:00Z",
    notAfter: "2026-10-10T20:05:00Z",
    timeoutSeconds: 1200,
    killGraceSeconds: 30,
    log: { bucket: "example-logs-dev", keyPrefix: `logs/example/dev/example-app-dev/${EXECUTION}/${TOKEN}/` },
    commit: "a".repeat(40),
    requestId: "38083040614-1",
    project: "example",
    environment: "dev",
    ...overrides,
  };
}

function event(phase: string, extra: Json = {}): Json {
  return {
    specVersion: 1,
    type: "AGENT_EVENT",
    phase,
    commandId: COMMAND_ID,
    executionId: EXECUTION,
    dispatchToken: TOKEN,
    fencingToken: 12,
    agentId: "example-server-dev",
    targetId: "example-app-dev",
    seq: 1,
    sentAt: "2026-10-10T20:00:05Z",
    agentVersion: "1.0.0",
    ...extra,
  };
}

const PHASE_FIELDS: Record<string, Json> = {
  ACCEPTED: { acceptedAt: "2026-10-10T20:00:04Z" },
  STARTED: { startedAt: "2026-10-10T20:00:05Z", pid: 4242 },
  HEARTBEAT: { elapsedMs: 60000 },
  FINISHED: { exitCode: 0, timedOut: false, durationMs: 90000, signal: null, cicdResult: { status: "SUCCESS", deployedCommit: "a".repeat(40) }, logTail: "done" },
  NOT_STARTED: { reason: "EXPIRED" },
  LOST: { startedAt: "2026-10-10T20:00:05Z" },
  NEVER_SEEN: { fencingToken: 0, journalEpoch: "2026-01-01T00:00:00Z", journalRetentionDays: 30 },
  NO_RECORD: { fencingToken: 0, journalEpoch: "2026-10-10T21:00:00Z" },
  LOG_UPLOADED: { log: { status: "UPLOADED", key: `logs/example/dev/example-app-dev/${EXECUTION}/${TOKEN}/stdout.log.gz`, bytes: 1024, sha256: "c".repeat(64) } },
};

function query(overrides: Json = {}): Json {
  return {
    specVersion: 1,
    type: "AGENT_QUERY",
    queryNumber: 1,
    commandId: COMMAND_ID,
    executionId: EXECUTION,
    dispatchToken: TOKEN,
    agentId: "example-server-dev",
    targetId: "example-app-dev",
    commandIssuedAt: "2026-10-10T20:00:00Z",
    notAfter: "2026-10-10T20:05:00Z",
    issuedAt: "2026-10-10T20:09:00Z",
    ...overrides,
  };
}

function agentRecord(overrides: Json = {}): Json {
  return {
    agentId: "example-server-dev",
    stage: "dev",
    roleId: "AROAEXAMPLEEXAMPLE001",
    commandQueueUrl: `${FAKE_SQS_QUEUE_BASE}/cicd-agent-dev-example-server-dev-cmd.fifo`,
    targets: ["example-app-dev", "example-api-dev"],
    minAgentVersion: "1.0.0",
    schemaVersion: 1,
    version: 1,
    updatedAt: "2026-10-10T12:00:00Z",
    updatedBy: "platform-admin",
    ...overrides,
  };
}

describe("SQS_AGENT schemas compile under the runtime Ajv options (strict)", () => {
  it.each([agentRecordSchemaPath, agentCommandSchemaPath, agentQuerySchemaPath, agentEventSchemaPath, agentHeartbeatSchemaPath])("%s", (p) => {
    expect(() => compileRuntime(p)).not.toThrow();
  });
});

describe("schemas/agent-record.schema.json", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = compileRuntime(agentRecordSchemaPath);
  });

  it("accepts a valid agent record serving several targets (one agent per server)", () => {
    expect(validate(agentRecord()), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["role ARN instead of role id", { roleId: "arn:aws:iam::123456789012:role/x" }],
    ["standard queue", { commandQueueUrl: `${FAKE_SQS_QUEUE_BASE}/cicd-agent-dev-x-cmd` }],
    ["foreign queue name", { commandQueueUrl: `${FAKE_SQS_QUEUE_BASE}/other.fifo` }],
    ["empty targets", { targets: [] }],
    ["duplicated targets", { targets: ["a-dev", "a-dev"] }],
    ["agentId too long", { agentId: `${LONG_AGENT}x` }],
    ["extra field", { secret: "x" }],
  ])("rejects %s", (_label, overrides) => {
    expect(validate(agentRecord(overrides))).toBe(false);
  });
});

describe("schemas/agent-command.schema.json", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = compileRuntime(agentCommandSchemaPath);
  });

  it("accepts a command with the AC-03 standard vector", () => {
    expect(validate(command()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a command with no argument (scriptArguments none)", () => {
    expect(validate(command({ args: [] }))).toBe(true);
  });

  it.each([
    ["a script path instead of a catalog id", { scriptId: "/opt/cicd/deploy.sh" }],
    ["a shell command field", { command: "rm -rf /" }],
    ["an argument with a newline", { args: ["--target-id", "x\nrm -rf /"] }],
    ["a commandId without the dispatch token", { commandId: EXECUTION }],
    ["fencing token 0", { fencingToken: 0 }],
    ["a timeout above the platform maximum", { timeoutSeconds: 3601 }],
    ["a log prefix outside logs/", { log: { bucket: "example-logs-dev", keyPrefix: "other/x/" } }],
    ["a short commit", { commit: "abc" }],
  ])("rejects %s", (_label, overrides) => {
    expect(validate(command(overrides))).toBe(false);
  });
});

describe("schemas/agent-event.schema.json", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = compileRuntime(agentEventSchemaPath);
  });

  it.each(Object.keys(PHASE_FIELDS))("accepts %s with its own fields", (phase) => {
    expect(validate(event(phase, PHASE_FIELDS[phase])), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["ACCEPTED", "acceptedAt"],
    ["STARTED", "startedAt"],
    ["HEARTBEAT", "elapsedMs"],
    ["FINISHED", "exitCode"],
    ["FINISHED", "timedOut"],
    ["NOT_STARTED", "reason"],
    ["LOST", "startedAt"],
    ["NEVER_SEEN", "journalEpoch"],
    ["NEVER_SEEN", "journalRetentionDays"],
    ["NO_RECORD", "journalEpoch"],
    ["LOG_UPLOADED", "log"],
  ])("rejects %s without %s", (phase, field) => {
    const fields = { ...PHASE_FIELDS[phase] };
    delete fields[field];
    expect(validate(event(phase, fields))).toBe(false);
  });

  it("NEVER_SEEN and NO_RECORD carry fencing token 0 (the agent never saw the command); every other phase needs >= 1", () => {
    expect(validate(event("NEVER_SEEN", { ...PHASE_FIELDS.NEVER_SEEN, fencingToken: 12 }))).toBe(false);
    expect(validate(event("FINISHED", { ...PHASE_FIELDS.FINISHED, fencingToken: 0 }))).toBe(false);
  });

  it.each([
    ["an unknown phase", event("DONE")],
    ["an unknown NOT_STARTED reason", event("NOT_STARTED", { reason: "MAYBE" })],
    ["seq 0", event("STARTED", { ...PHASE_FIELDS.STARTED, seq: 0 })],
    ["an exit code above 255", event("FINISHED", { ...PHASE_FIELDS.FINISHED, exitCode: 256 })],
    ["a log tail above 4 KB", event("FINISHED", { ...PHASE_FIELDS.FINISHED, logTail: "x".repeat(4097) })],
    ["an extra field", event("STARTED", { ...PHASE_FIELDS.STARTED, command: "x" })],
  ])("rejects %s", (_label, candidate) => {
    expect(validate(candidate)).toBe(false);
  });
});

describe("schemas/agent-query.schema.json and agent-heartbeat.schema.json", () => {
  it("accepts a valid query and refuses one without the command's issuedAt or notAfter (the agent needs them for the NEVER_SEEN rule)", () => {
    const validate = compileRuntime(agentQuerySchemaPath);
    expect(validate(query()), JSON.stringify(validate.errors)).toBe(true);
    for (const field of ["commandIssuedAt", "notAfter"]) {
      const q = query();
      delete q[field];
      expect(validate(q)).toBe(false);
    }
  });

  it("accepts an idle and a busy heartbeat, never a heartbeat that names another command format", () => {
    const validate = compileRuntime(agentHeartbeatSchemaPath);
    const base = { specVersion: 1, type: "AGENT_HEARTBEAT", agentId: "example-server-dev", agentVersion: "1.0.0", sentAt: "2026-10-10T20:01:00Z", clockOffsetMs: 12 };
    expect(validate({ ...base, running: [] })).toBe(true);
    expect(validate({ ...base, running: [COMMAND_ID] })).toBe(true);
    expect(validate({ ...base, running: ["not-a-command"] })).toBe(false);
  });
});

describe("cross-contract coherence", () => {
  const properties = (p: string): Record<string, { pattern?: string }> => read(p).properties as Record<string, { pattern?: string }>;

  it.each(["commandId", "executionId", "dispatchToken", "agentId", "targetId"])("%s has the same format in command, event and query", (field) => {
    const c = properties(agentCommandSchemaPath)[field]?.pattern;
    expect(c).toBeDefined();
    expect(properties(agentEventSchemaPath)[field]?.pattern).toBe(c);
    expect(properties(agentQuerySchemaPath)[field]?.pattern).toBe(c);
  });

  it("commandId format is exactly <executionId>:<dispatchToken>", () => {
    const p = properties(agentCommandSchemaPath);
    const strip = (s: string | undefined): string => (s ?? "").replace(/^\^/, "").replace(/\$$/, "");
    expect(strip(p.commandId?.pattern)).toBe(`${strip(p.executionId?.pattern)}:${strip(p.dispatchToken?.pattern)}`);
  });

  it("targetId and the request's targetId share one format (a request target is always a valid agent target)", () => {
    const request = read(deployRequestSchemaPath).properties as Record<string, { pattern?: string }>;
    expect(properties(agentCommandSchemaPath).targetId?.pattern).toBe(request.targetId?.pattern);
  });

  it("the agent record's agentId format equals the messages' and the target record's", () => {
    expect(properties(agentRecordSchemaPath).agentId?.pattern).toBe(properties(agentCommandSchemaPath).agentId?.pattern);
  });

  it("domain/agent-protocol builds commandIds the schemas accept and parses them back", () => {
    const validate = compileRuntime(agentCommandSchemaPath);
    const id = commandIdOf(LONG_EXECUTION, TOKEN);
    expect(validate(command({ commandId: id, executionId: LONG_EXECUTION, log: { bucket: "example-logs-dev", keyPrefix: `logs/example/dev/${LONG_TARGET}/${LONG_EXECUTION}/${TOKEN}/` }, targetId: LONG_TARGET }))).toBe(true);
    expect(parseCommandId(id)).toEqual({ executionId: LONG_EXECUTION, dispatchToken: TOKEN });
  });

  it("every FIFO group and deduplication id fits the SQS limit for the longest legal ids", () => {
    const id = commandIdOf(LONG_EXECUTION, TOKEN);
    for (const value of [
      fifo.commandGroup(LONG_TARGET),
      fifo.commandDeduplication(id),
      fifo.queryDeduplication(id, 9999),
      fifo.eventGroup(LONG_EXECUTION),
      fifo.eventDeduplication(id, 999999),
      fifo.heartbeatGroup(LONG_AGENT),
    ]) {
      expect(value.length).toBeLessThanOrEqual(FIFO_ID_MAX_LENGTH);
    }
  });

  it("a re-send of the same dispatch has the same deduplication id; a new dispatch never does", () => {
    const again = fifo.commandDeduplication(commandIdOf(EXECUTION, TOKEN));
    const next = fifo.commandDeduplication(commandIdOf(EXECUTION, "1f8b3c1e-2a4d-4b6f-8c9e-1a2b3c4d5e6f"));
    expect(again).toBe(fifo.commandDeduplication(COMMAND_ID));
    expect(next).not.toBe(again);
  });
});
