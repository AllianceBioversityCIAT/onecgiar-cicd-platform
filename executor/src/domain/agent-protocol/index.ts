// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §7, §9, §10.2–§10.4, §17; design DD-09
// SQS_AGENT protocol rules, pure (no I/O, no clock): the single definition of the identities, deadlines,
// evidence rules and acceptance rules that the Executor (E2) and the agent (E3) both apply. Keeping them here
// lets the contract tests prove the AC-04 guarantees before either side is wired:
//   - a pinned lock never becomes acquirable by time (§9.1);
//   - NEVER_SEEN is evidence only under the journal rule, never from FIFO order alone (§6, §9.3);
//   - every agent event maps to exactly one effect on the execution and the lock (§7);
//   - the agent accepts a command only once, never with a lower fencing token, never while another command
//     of the same target is active, never a command older than its journal (§10.2–§10.4).
import { classifyExitCode } from "../errors/index.js";
import type { PersistedLockItem } from "../lock-policy/index.js";

/** AP-7 defaults (configurable). */
export const AGENT_PROTOCOL_DEFAULTS = {
  notAfterSeconds: 300,
  heartbeatSeconds: 60,
  killGraceSeconds: 30,
  clockSkewSeconds: 60,
  safetyMarginSeconds: 120,
  journalRetentionDays: 30,
} as const;

/** `leaseExpiresAt` of a PINNED lock (§5, §9.1): the existing `leaseExpiresAt < now` acquisition rule never holds for it. */
export const PINNED_LEASE_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

const EXECUTION_ID = /^[a-z0-9][a-z0-9-]{1,62}-[1-9][0-9]{0,11}$/;
const DISPATCH_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** SQS FIFO limit for MessageGroupId and MessageDeduplicationId. */
export const FIFO_ID_MAX_LENGTH = 128;

export class AgentProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Identities (§6)
// ---------------------------------------------------------------------------

/** `commandId = <executionId>:<dispatchToken>`: a re-send of the same dispatch has the same id; a new dispatch never does. */
export function commandIdOf(executionId: string, dispatchToken: string): string {
  if (!EXECUTION_ID.test(executionId)) throw new AgentProtocolError("invalid executionId");
  if (!DISPATCH_TOKEN.test(dispatchToken)) throw new AgentProtocolError("invalid dispatchToken");
  return `${executionId}:${dispatchToken}`;
}

export function parseCommandId(commandId: string): { readonly executionId: string; readonly dispatchToken: string } | undefined {
  const separator = commandId.lastIndexOf(":");
  if (separator < 0) return undefined;
  const executionId = commandId.slice(0, separator);
  const dispatchToken = commandId.slice(separator + 1);
  return EXECUTION_ID.test(executionId) && DISPATCH_TOKEN.test(dispatchToken) ? { executionId, dispatchToken } : undefined;
}

function fifoId(value: string): string {
  if (value.length > FIFO_ID_MAX_LENGTH) throw new AgentProtocolError("FIFO id longer than 128 characters");
  return value;
}

/** FIFO ids (§6). Groups: command queue by target, results queue by execution, heartbeats by agent. */
export const fifo = {
  commandGroup: (targetId: string): string => fifoId(targetId),
  commandDeduplication: (commandId: string): string => fifoId(commandId),
  queryDeduplication: (commandId: string, queryNumber: number): string => fifoId(`${commandId}:q${String(queryNumber)}`),
  eventGroup: (executionId: string): string => fifoId(executionId),
  eventDeduplication: (commandId: string, seq: number): string => fifoId(`${commandId}:${String(seq)}`),
  heartbeatGroup: (agentId: string): string => fifoId(`agent#${agentId}`),
};

// ---------------------------------------------------------------------------
// Deadlines (§8, §9, §17)
// ---------------------------------------------------------------------------

export interface DeadlineInput {
  readonly notAfterMs: number;
  readonly timeoutSeconds: number;
  readonly killGraceSeconds: number;
  readonly clockSkewSeconds: number;
  readonly safetyMarginSeconds: number;
}

/**
 * The latest moment any process of the command can exist if the agent honors its contract: it starts before
 * `notAfter` and kills the process group at `timeout + killGrace` (§9.2). Computed at X9, never extended.
 */
export function hardDeadlineAt(input: DeadlineInput): number {
  for (const value of [input.timeoutSeconds, input.killGraceSeconds, input.clockSkewSeconds, input.safetyMarginSeconds]) {
    if (!Number.isInteger(value) || value < 0) throw new AgentProtocolError("deadline components must be non-negative integers");
  }
  return input.notAfterMs + (input.timeoutSeconds + input.killGraceSeconds + input.clockSkewSeconds + input.safetyMarginSeconds) * 1000;
}

// ---------------------------------------------------------------------------
// Locks (§9.1)
// ---------------------------------------------------------------------------

export function isPinned(lock: PersistedLockItem): boolean {
  return lock.leaseExpiresAt === PINNED_LEASE_EXPIRES_AT;
}

/** The fenced condition of every release or hold change: only the owning execution with its own token (§9.1). */
export function mayChangeLock(lock: PersistedLockItem | undefined, executionId: string, fencingToken: number): boolean {
  return lock !== undefined && lock.owner === executionId && lock.fencingToken === fencingToken;
}

// ---------------------------------------------------------------------------
// NEVER_SEEN evidence (§6, §9.3)
// ---------------------------------------------------------------------------

export interface NeverSeenContext {
  readonly commandIssuedAtMs: number;
  readonly notAfterMs: number;
  /** When the answering agent's journal was created. */
  readonly journalEpochMs: number;
  readonly journalRetentionDays: number;
  /** When the agent answered (event `sentAt`). */
  readonly answeredAtMs: number;
  readonly clockSkewSeconds: number;
}

export type NeverSeenVerdict =
  | { readonly evidence: true }
  | { readonly evidence: false; readonly reason: "JOURNAL_NOT_OLDER_THAN_COMMAND" | "OUTSIDE_RETENTION" | "BEFORE_START_WINDOW_CLOSED" };

/**
 * NEVER_SEEN proves "never started and never will" only if ALL hold: the journal existed before the command was
 * issued (a lost or recreated journal proves nothing); the command is inside the journal retention; and the
 * answer was given after `notAfter + skew` (before that, a delayed copy could still arrive and start). FIFO
 * order is not part of the rule: it only makes a positive answer likely, never sufficient.
 */
export function neverSeenVerdict(ctx: NeverSeenContext): NeverSeenVerdict {
  if (!(ctx.journalEpochMs < ctx.commandIssuedAtMs)) return { evidence: false, reason: "JOURNAL_NOT_OLDER_THAN_COMMAND" };
  if (ctx.answeredAtMs - ctx.commandIssuedAtMs > ctx.journalRetentionDays * 86_400_000) return { evidence: false, reason: "OUTSIDE_RETENTION" };
  if (!(ctx.answeredAtMs > ctx.notAfterMs + ctx.clockSkewSeconds * 1000)) return { evidence: false, reason: "BEFORE_START_WINDOW_CLOSED" };
  return { evidence: true };
}

// ---------------------------------------------------------------------------
// Effect of an agent event (§7)
// ---------------------------------------------------------------------------

export type AgentPhase = "ACCEPTED" | "STARTED" | "HEARTBEAT" | "FINISHED" | "NOT_STARTED" | "LOST" | "NEVER_SEEN" | "NO_RECORD" | "LOG_UPLOADED";

export type NotStartedReason =
  | "EXPIRED"
  | "BUSY"
  | "ABANDONED"
  | "CLOCK_SKEW"
  | "PREDATES_JOURNAL"
  | "TARGET_ACTIVE"
  | "STALE_FENCING"
  | "REJECTED_SCHEMA"
  | "REJECTED_SENDER"
  | "REJECTED_AGENT"
  | "REJECTED_TARGET"
  | "REJECTED_SCRIPT"
  | "REJECTED_ARGS"
  | "REJECTED_CONFIG";

export interface AgentEventFacts {
  readonly phase: AgentPhase;
  readonly reason?: NotStartedReason;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  /** Required for NEVER_SEEN: the verdict of `neverSeenVerdict`. */
  readonly neverSeen?: NeverSeenVerdict;
}

export type AgentEventEffect =
  /** Closes a DEPLOYING execution through an EXISTING transition; `lock` is the lock's fate in the same transaction. */
  | { readonly kind: "CLOSE"; readonly transition: "X11" | "X12" | "X13" | "X14" | "X16"; readonly lock: "RELEASE" | "HOLD"; readonly cause: string }
  /** Recorded (acceptedAt, execStartedAt, heartbeat, log); no state or lock change. */
  | { readonly kind: "PROGRESS" }
  /** Proves nothing: the execution and the lock stay as they are. */
  | { readonly kind: "NOT_EVIDENCE" };

const NEVER_STARTED_RETRY: ReadonlySet<NotStartedReason> = new Set(["EXPIRED", "BUSY", "ABANDONED", "CLOCK_SKEW", "PREDATES_JOURNAL", "TARGET_ACTIVE"]);

/** §7, for an execution in DEPLOYING whose `dispatchToken` matches the event. */
export function effectOfAgentEvent(facts: AgentEventFacts): AgentEventEffect {
  switch (facts.phase) {
    case "ACCEPTED":
    case "STARTED":
    case "HEARTBEAT":
    case "LOG_UPLOADED":
      return { kind: "PROGRESS" };
    case "NO_RECORD":
      return { kind: "NOT_EVIDENCE" };
    case "NEVER_SEEN":
      return facts.neverSeen?.evidence === true
        ? { kind: "CLOSE", transition: "X14", lock: "RELEASE", cause: "AGENT_NEVER_SEEN" }
        : { kind: "NOT_EVIDENCE" };
    case "LOST":
      return { kind: "CLOSE", transition: "X16", lock: "HOLD", cause: "AGENT_LOST" };
    case "NOT_STARTED": {
      if (facts.reason === undefined) return { kind: "NOT_EVIDENCE" };
      if (NEVER_STARTED_RETRY.has(facts.reason)) return { kind: "CLOSE", transition: "X14", lock: "RELEASE", cause: `AGENT_NOT_STARTED_${facts.reason}` };
      return { kind: "CLOSE", transition: "X11", lock: "RELEASE", cause: `AGENT_${facts.reason}` };
    }
    case "FINISHED": {
      if (facts.timedOut === true) return { kind: "CLOSE", transition: "X16", lock: "HOLD", cause: "TIMEOUT" };
      if (facts.exitCode === undefined) return { kind: "NOT_EVIDENCE" };
      const exit = classifyExitCode(facts.exitCode);
      if (exit.kind === "SUCCESS") return { kind: "CLOSE", transition: "X12", lock: "RELEASE", cause: "EXIT_0" };
      if (exit.kind === "FAILED") return { kind: "CLOSE", transition: "X13", lock: "RELEASE", cause: exit.code };
      if (exit.kind === "TARGET_BUSY") return { kind: "CLOSE", transition: "X14", lock: "RELEASE", cause: "TARGET_BUSY" };
      return { kind: "CLOSE", transition: "X16", lock: "HOLD", cause: `EXIT_${String(facts.exitCode)}` };
    }
  }
}

/** §9.1: what a late or query event does to a HELD lock of an execution already in UNKNOWN_TARGET_STATE. */
export type HoldDecision = "RELEASE_AUTOMATIC" | "OPERATOR_REQUIRED" | "KEEP";

export function holdDecision(facts: AgentEventFacts): HoldDecision {
  if (facts.phase === "NOT_STARTED" && facts.reason !== undefined) return "RELEASE_AUTOMATIC"; // proves no process ever existed
  if (facts.phase === "NEVER_SEEN") return facts.neverSeen?.evidence === true ? "RELEASE_AUTOMATIC" : "KEEP";
  if (facts.phase === "FINISHED" || facts.phase === "LOST") return "OPERATOR_REQUIRED"; // the process is gone, the target state is not known (OP-1)
  return "KEEP";
}

// ---------------------------------------------------------------------------
// Agent acceptance (§10.2–§10.4)
// ---------------------------------------------------------------------------

/** Persisted per target on the agent (`/var/lib/cicd-agent/targets/<targetId>.json`). */
export interface AgentTargetState {
  readonly highestFencingToken?: number;
  readonly activeCommandId?: string;
}

export interface AcceptanceInput {
  readonly commandId: string;
  readonly fencingToken: number;
  readonly issuedAtMs: number;
  readonly notAfterMs: number;
  readonly journalEpochMs: number;
  readonly journalHasCommand: boolean;
  readonly targetState: AgentTargetState;
  readonly nowMs: number;
  readonly clockOffsetMs: number;
  readonly clockSkewSeconds: number;
}

export type AcceptanceDecision =
  | { readonly decision: "ACCEPT"; readonly nextState: AgentTargetState }
  /** Already journaled: never run again; re-send the last journaled event. */
  | { readonly decision: "DUPLICATE" }
  | { readonly decision: "NOT_STARTED"; readonly reason: NotStartedReason };

/** The order matters: a journaled command is a duplicate even when it has since expired or been superseded. */
export function decideAcceptance(input: AcceptanceInput): AcceptanceDecision {
  if (input.journalHasCommand) return { decision: "DUPLICATE" };
  if (input.issuedAtMs < input.journalEpochMs) return { decision: "NOT_STARTED", reason: "PREDATES_JOURNAL" };
  if (Math.abs(input.clockOffsetMs) > input.clockSkewSeconds * 1000) return { decision: "NOT_STARTED", reason: "CLOCK_SKEW" };
  if (input.nowMs > input.notAfterMs) return { decision: "NOT_STARTED", reason: "EXPIRED" };
  const { highestFencingToken, activeCommandId } = input.targetState;
  if (activeCommandId !== undefined && activeCommandId !== input.commandId) return { decision: "NOT_STARTED", reason: "TARGET_ACTIVE" };
  if (highestFencingToken !== undefined && input.fencingToken <= highestFencingToken) return { decision: "NOT_STARTED", reason: "STALE_FENCING" };
  return { decision: "ACCEPT", nextState: { highestFencingToken: input.fencingToken, activeCommandId: input.commandId } };
}

/** §10.4: `activeCommandId` is cleared only when the command reached FINISHED, NOT_STARTED or LOST; the token is kept. */
export function clearActiveCommand(state: AgentTargetState, commandId: string): AgentTargetState {
  if (state.activeCommandId !== commandId) return state;
  return state.highestFencingToken === undefined ? {} : { highestFencingToken: state.highestFencingToken };
}
