// @akili-spec changes/cicd-executor-poc architecture-change-04 §10.1, §10.6, §10.7, §11.1, AP-4, AP-7
// Agent configuration (`<home>/config/agent.json`) and catalog (`<home>/config/catalog.json`), both root-owned and
// read once at start (home: `/opt/cicd-agent` by default, see infra/agent/README.md). Every value is validated here; an invalid file refuses to start (fail closed). The catalog is the
// ONLY source of script paths: a command names a catalog key (`scriptId`) for one of its targets, never a path.
import { isAbsolute } from "node:path";
import { AGENT_PROTOCOL_DEFAULTS } from "../domain/agent-protocol/index.js";

export interface CatalogTarget {
  readonly targetId: string;
  readonly scriptId: string;
  /** Absolute path of the root-owned script; never taken from a message. */
  readonly path: string;
  readonly arguments: "standard" | "none";
  /**
   * Deploy user for `sudo -n -u <runAs>`. Absent when the catalog says `"runAs": "self"` (the script runs as the agent
   * user, no sudo: for servers where the agent has no sudo rule) and in local tests.
   */
  readonly runAs?: string;
  readonly timeoutSeconds: number;
  readonly killGraceSeconds: number;
  /** Named shared resources this script needs (AC-04 §10.6). */
  readonly resources: readonly string[];
  /** Per-target script role (AP-2); its temporary credentials go to this script only. */
  readonly scriptRoleArn?: string;
}

export interface AgentConfig {
  readonly agentId: string;
  readonly stage: string;
  readonly region: string;
  readonly commandQueueUrl: string;
  readonly resultsQueueUrl: string;
  /** Role id of the Executor: the only sender whose commands are accepted (SenderId prefix, AC-04 §11.4). */
  readonly executorRoleId: string;
  readonly logBucket: string;
  /** Agent state (journal, target state, outbox, captured output); 0700, owned by the agent user. */
  readonly stateDir: string;
  readonly maxParallel: number;
  readonly maxPending: number;
  readonly resources: Readonly<Record<string, number>>;
  readonly journalRetentionDays: number;
  readonly heartbeatSeconds: number;
  readonly clockSkewSeconds: number;
  /** Cap of each captured stream (bytes); the rest is dropped and the truncation is marked. */
  readonly outputCapBytes: number;
  /**
   * Shutdown drain (SIGTERM): how long running scripts may go on before the agent interrupts them (reported LOST).
   * Default: the longest catalog timeout plus its kill grace, so a stop never cuts a deploy short of its own timeout.
   */
  readonly shutdownGraceSeconds: number;
  readonly sudoPath: string;
  readonly targets: Readonly<Record<string, CatalogTarget>>;
}

export class AgentConfigError extends Error {
  public constructor(public readonly problems: readonly string[]) {
    super(`invalid agent configuration: ${problems.join("; ")}`);
    this.name = "AgentConfigError";
  }
}

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const STAGE = /^[a-z][a-z0-9-]{0,15}$/;
const ROLE_ID = /^AROA[A-Z0-9]{17}$/;
// https, or plain http on the loopback interface only (a local SQS emulator, never a remote endpoint).
const FIFO_URL = /^(https:\/\/\S+|http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?\/\S+)\.fifo$/;
/** Catalog value of `runAs` for a script that runs as the agent user itself, without sudo. */
export const RUN_AS_SELF = "self";
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]{1,255}$/;
const POSIX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const RESOURCE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;

function int(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * Validates the raw JSON of agent.json and catalog.json. `allowRelativePaths` exists only for local tests (temporary
 * directories on any OS); production paths must be absolute POSIX paths without `.` or `..` segments.
 */
export function loadAgentConfig(rawConfig: unknown, rawCatalog: unknown, opts: { readonly allowRelativePaths?: boolean } = {}): AgentConfig {
  const problems: string[] = [];
  const c = (rawConfig ?? {}) as Record<string, unknown>;
  const k = (rawCatalog ?? {}) as Record<string, unknown>;
  const str = (obj: Record<string, unknown>, name: string, pattern: RegExp, where: string): string => {
    const value = obj[name];
    if (typeof value !== "string" || !pattern.test(value)) {
      problems.push(`${where}.${name} is missing or invalid`);
      return "";
    }
    return value;
  };
  const path = (value: unknown, where: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      problems.push(`${where} is missing`);
      return "";
    }
    if (!opts.allowRelativePaths && (!ABSOLUTE_PATH.test(value) || /(^|\/)\.{1,2}(\/|$)/.test(value))) {
      problems.push(`${where} must be an absolute path without . or .. segments`);
    }
    return value;
  };

  const agentId = str(c, "agentId", AGENT_ID, "agent");
  const stage = str(c, "stage", STAGE, "agent");
  const region = str(c, "region", /^[a-z]{2}(-[a-z]+)+-[0-9]$/, "agent");
  const commandQueueUrl = str(c, "commandQueueUrl", FIFO_URL, "agent");
  const resultsQueueUrl = str(c, "resultsQueueUrl", FIFO_URL, "agent");
  const executorRoleId = str(c, "executorRoleId", ROLE_ID, "agent");
  const logBucket = str(c, "logBucket", BUCKET, "agent");
  // A local directory: an absolute path of this platform, without . or .. segments.
  const stateDir = typeof c.stateDir === "string" && isAbsolute(c.stateDir) && !/(^|[\\/])\.{1,2}([\\/]|$)/.test(c.stateDir) ? c.stateDir : "";
  if (stateDir === "") problems.push("agent.stateDir must be an absolute path without . or .. segments");
  const sudoPath = c.sudoPath === undefined ? "/usr/bin/sudo" : path(c.sudoPath, "agent.sudoPath");
  const maxParallel = int(c.maxParallel ?? 2, 1, 64);
  const maxPending = int(c.maxPending ?? 20, 1, 1000);
  const journalRetentionDays = int(c.journalRetentionDays ?? AGENT_PROTOCOL_DEFAULTS.journalRetentionDays, 1, 3650);
  const heartbeatSeconds = int(c.heartbeatSeconds ?? AGENT_PROTOCOL_DEFAULTS.heartbeatSeconds, 5, 600);
  const clockSkewSeconds = int(c.clockSkewSeconds ?? AGENT_PROTOCOL_DEFAULTS.clockSkewSeconds, 1, 600);
  const outputCapBytes = int(c.outputCapBytes ?? 20 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
  for (const [name, value] of Object.entries({ maxParallel, maxPending, journalRetentionDays, heartbeatSeconds, clockSkewSeconds, outputCapBytes })) {
    if (value === undefined) problems.push(`agent.${name} is out of range`);
  }

  const resources: Record<string, number> = {};
  for (const [name, capacity] of Object.entries((c.resources ?? {}) as Record<string, unknown>)) {
    if (!RESOURCE.test(name) || int(capacity, 1, 64) === undefined) problems.push(`agent.resources.${name} is invalid`);
    else resources[name] = capacity as number;
  }

  if (k.agentId !== agentId) problems.push("catalog.agentId must equal agent.agentId");
  const targets: Record<string, CatalogTarget> = {};
  const scripts = new Set<string>();
  for (const [targetId, rawTarget] of Object.entries((k.targets ?? {}) as Record<string, unknown>)) {
    const where = `catalog.targets.${targetId}`;
    if (!ID.test(targetId)) {
      problems.push(`${where}: invalid targetId`);
      continue;
    }
    const t = (rawTarget ?? {}) as Record<string, unknown>;
    const scriptId = str(t, "scriptId", ID, where);
    if (scripts.has(scriptId)) problems.push(`${where}.scriptId is used by another target`);
    scripts.add(scriptId);
    const args = t.arguments ?? "standard";
    if (args !== "standard" && args !== "none") problems.push(`${where}.arguments must be standard or none`);
    const runAs = t.runAs === undefined || t.runAs === RUN_AS_SELF ? undefined : str(t, "runAs", POSIX_USER, where);
    const timeoutSeconds = int(t.timeoutSeconds, 60, 3600);
    const killGraceSeconds = int(t.killGraceSeconds ?? AGENT_PROTOCOL_DEFAULTS.killGraceSeconds, 5, 600);
    if (timeoutSeconds === undefined) problems.push(`${where}.timeoutSeconds must be 60..3600`);
    if (killGraceSeconds === undefined) problems.push(`${where}.killGraceSeconds must be 5..600`);
    const needs = Array.isArray(t.resources) ? (t.resources as unknown[]) : [];
    for (const r of needs) if (typeof r !== "string" || resources[r] === undefined) problems.push(`${where}.resources names an undeclared resource`);
    const scriptRoleArn = t.scriptRoleArn === undefined ? undefined : str(t, "scriptRoleArn", ROLE_ARN, where);
    if (t.runAs === undefined && !opts.allowRelativePaths) problems.push(`${where}.runAs is required: a deploy user (through sudo) or "${RUN_AS_SELF}" (the agent user, no sudo)`);
    targets[targetId] = {
      targetId,
      scriptId,
      path: path(t.path, `${where}.path`),
      arguments: args as "standard" | "none",
      ...(runAs === undefined ? {} : { runAs }),
      timeoutSeconds: timeoutSeconds ?? 0,
      killGraceSeconds: killGraceSeconds ?? 0,
      resources: needs as string[],
      ...(scriptRoleArn === undefined ? {} : { scriptRoleArn }),
    };
  }
  if (Object.keys(targets).length === 0) problems.push("catalog.targets is empty");
  const longestRun = Math.max(0, ...Object.values(targets).map((t) => t.timeoutSeconds + t.killGraceSeconds));
  const shutdownGraceSeconds = int(c.shutdownGraceSeconds ?? longestRun, 0, 4200);
  if (shutdownGraceSeconds === undefined) problems.push("agent.shutdownGraceSeconds must be 0..4200");
  if (problems.length > 0) throw new AgentConfigError(problems);

  return {
    agentId,
    stage,
    region,
    commandQueueUrl,
    resultsQueueUrl,
    executorRoleId,
    logBucket,
    stateDir,
    maxParallel: maxParallel as number,
    maxPending: maxPending as number,
    resources,
    journalRetentionDays: journalRetentionDays as number,
    heartbeatSeconds: heartbeatSeconds as number,
    clockSkewSeconds: clockSkewSeconds as number,
    outputCapBytes: outputCapBytes as number,
    shutdownGraceSeconds: shutdownGraceSeconds as number,
    sudoPath,
    targets,
  };
}
