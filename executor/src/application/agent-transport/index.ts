// @akili-spec changes/cicd-executor-poc architecture-change-04 §3, §6–§9, §16; design §7.3 (X9–X16), DD-09, DD-28
// The asynchronous sqs-agent transport of the Executor (AC-04 E2). No method waits for a deploy, holds a session or
// renews a lock: the coordinator commits X9 (lock PINNED) and calls `send`; the agent's events arrive on the results
// queue and `applyEvent` closes the execution through the EXISTING transitions; the reconciler calls `reconcile` to
// re-drive lost sends, query a silent agent, and close an execution whose hard deadline passed (X16 + hold).
//
// Invariants (each enforced by a conditional write, never by memory):
//   - the command identity is fixed at X9 (`commandId = executionId:dispatchToken`): every re-send is the same command;
//   - an event is applied only for the execution's current dispatchToken, in DEPLOYING, with seq > lastEventSeq, from
//     the agent role snapshotted at X1 (SenderId); anything else is audit only;
//   - the lock is released only in the same transaction as a closing transition that proves no process exists, and is
//     HELD on X16; a held lock is released only by never-started evidence or an operator resolution (AP-3, OP-1);
//   - silence is never evidence: a silent agent is queried, and without an answer the execution ends X16 with a hold.
import {
  AGENT_PROTOCOL_DEFAULTS,
  commandIdOf,
  effectOfAgentEvent,
  fifo,
  hardDeadlineAt,
  holdDecision,
  neverSeenVerdict,
  parseCommandId,
  type AgentEventFacts,
  type AgentPhase,
  type NeverSeenVerdict,
  type NotStartedReason,
} from "../../domain/agent-protocol/index.js";
import { applyTransition, type TransitionResult } from "../../domain/state-machine/index.js";
import { nextLockRetry } from "../../domain/lock-policy/index.js";
import { versionCheckOf } from "../../domain/version-check/index.js";
import type { LockRetryRequestedEvent } from "../../domain/request-contract/index.js";
import type { AgentDispatcher } from "../../ports/agent-dispatcher.js";
import type { Clock } from "../../ports/clock.js";
import type { QueuePublisher } from "../../ports/queue-publisher.js";
import type { CicdResult } from "../../ports/deploy-transport.js";
import type { AgentDispatchState, AgentTargetSnapshot, ExecutionItem, LockItem } from "../../adapters/dynamodb-state-store/types.js";
import { isAgentSnapshot } from "../../adapters/dynamodb-state-store/types.js";
import type { ExecutionUpdatePatch } from "../../adapters/dynamodb-state-store/execution-repository.js";
import type { AgentEventAuditEntry, AgentEventDisposition, AgentLivenessEntry } from "../../adapters/dynamodb-state-store/agent-event-repository.js";
import { basePlanOf, buildPatch, toExecutionSnapshot, WAITING_LOCK_GRACE_MS, LOG_TAIL_MAX_CHARS } from "../deploy-coordinator/index.js";
import type { DeployExecutionStore, DeployTargetPort, DeployTransactionPort, WindowRevalidator } from "../deploy-coordinator/ports.js";

/** AP-7 timing, plus the reconciler's own cadence; every value is configurable. */
export interface AgentTiming {
  readonly notAfterSeconds: number;
  readonly killGraceSeconds: number;
  readonly clockSkewSeconds: number;
  readonly safetyMarginSeconds: number;
  /** A PENDING_SEND older than this is re-sent by the reconciler. */
  readonly resendAfterSeconds: number;
  /** Backoff between evidence queries (the last value repeats). */
  readonly queryBackoffSeconds: readonly number[];
  /** After this many unanswered queries on a held execution, the reconciler stops querying (operator only). */
  readonly maxQueries: number;
}

export const DEFAULT_AGENT_TIMING: AgentTiming = {
  notAfterSeconds: AGENT_PROTOCOL_DEFAULTS.notAfterSeconds,
  killGraceSeconds: AGENT_PROTOCOL_DEFAULTS.killGraceSeconds,
  clockSkewSeconds: AGENT_PROTOCOL_DEFAULTS.clockSkewSeconds,
  safetyMarginSeconds: AGENT_PROTOCOL_DEFAULTS.safetyMarginSeconds,
  resendAfterSeconds: 30,
  queryBackoffSeconds: [60, 120, 300, 600, 1800, 3600],
  maxQueries: 48,
};

/** Validation of the message contracts (compiled JSON Schemas in production); `undefined` means valid. */
export interface AgentContractValidators {
  command(body: unknown): readonly string[] | undefined;
  query(body: unknown): readonly string[] | undefined;
  event(body: unknown): readonly string[] | undefined;
  heartbeat(body: unknown): readonly string[] | undefined;
}

export interface AgentLockPort {
  get(lockKey: string): Promise<LockItem | undefined>;
}

/** The operator resolution path (OP-2), reused for verified never-started evidence. */
export interface HoldResolver {
  resolveWithEvidence(input: {
    readonly eventId: string;
    readonly targetId: string;
    readonly executionId: string;
    readonly resolvedBy: string;
    readonly note: string;
  }): Promise<"RECORDED" | "REJECTED" | "CONFLICT">;
}

export interface AgentAuditPort {
  record(entry: AgentEventAuditEntry): Promise<boolean>;
  recordLiveness(entry: AgentLivenessEntry): Promise<void>;
}

export interface AgentRegistryPort {
  /** The agent's role id when AGENT#{agentId} exists and is valid; used for heartbeats only (events use the snapshot). */
  agentRoleId(agentId: string): Promise<string | undefined>;
}

export interface AgentTransportDeps {
  readonly executions: DeployExecutionStore;
  readonly transactions: Pick<DeployTransactionPort, "closeWithRelease" | "markUnknownTargetState">;
  readonly locks: AgentLockPort;
  readonly target: Pick<DeployTargetPort, "recordDeployed">;
  readonly windows: WindowRevalidator;
  readonly dispatcher: AgentDispatcher;
  readonly queue: QueuePublisher;
  readonly audit: AgentAuditPort;
  readonly resolver: HoldResolver;
  readonly registry: AgentRegistryPort;
  readonly validators: AgentContractValidators;
  readonly clock: Clock;
  readonly logBucket: string;
  readonly deployTimeoutMinutes: number;
  readonly timing?: AgentTiming;
  readonly newEventId?: () => string;
  readonly onError?: (message: string, fields: Record<string, unknown>) => void;
  readonly onWarn?: (message: string, fields: Record<string, unknown>) => void;
}

export type AgentSendOutcome = "SENT" | "SEND_FAILED" | "INVALID_COMMAND" | "STALE";

export type AgentEventOutcome =
  | { readonly outcome: "INVALID"; readonly problems: readonly string[] }
  | { readonly outcome: "REFUSED"; readonly reason: string }
  | { readonly outcome: "UNKNOWN_EXECUTION" }
  | { readonly outcome: "DUPLICATE" }
  | { readonly outcome: "LATE" }
  | { readonly outcome: "PROGRESS" }
  | { readonly outcome: "NOT_EVIDENCE" }
  | { readonly outcome: "CLOSED"; readonly transitionId: string; readonly status: string }
  | { readonly outcome: "HOLD_RELEASED" }
  | { readonly outcome: "OPERATOR_REQUIRED" }
  /** A concurrent writer moved the execution: the message must be redelivered (the event is re-applied on fresh state). */
  | { readonly outcome: "RETRY" };

export type AgentReconcileAction =
  | "AGENT_COMMAND_RESENT"
  | "AGENT_QUERY_SENT"
  | "UNKNOWN_TARGET_STATE"
  | "HOLD_QUERY_SENT"
  | "HOLD_QUERIES_EXHAUSTED"
  | "HOLD_CLEARED"
  | "SKIPPED";

export interface AgentTransport {
  /** X9 fields of an sqs-agent dispatch (outbox state and deadlines). */
  dispatchFields(item: ExecutionItem, dispatchToken: string, now: number): { readonly agent: AgentDispatchState; readonly deadlineAt: number };
  /** Sends the CURRENT dispatch's command (first send and every re-send: same commandId). Never waits for the agent. */
  send(item: ExecutionItem): Promise<AgentSendOutcome>;
  /** One AGENT_EVENT from the results queue, with the role id of its SenderId. */
  applyEvent(body: unknown, senderRoleId: string | undefined): Promise<AgentEventOutcome>;
  /** One AGENT_HEARTBEAT (liveness only). */
  applyHeartbeat(body: unknown, senderRoleId: string | undefined): Promise<"RECORDED" | "REFUSED" | "INVALID">;
  /** Reconciler entry for an sqs-agent execution found by GSI2 (DEPLOYING, or held in the HOLD partition). */
  reconcile(item: ExecutionItem, now: number): Promise<AgentReconcileAction>;
}

type Accepted = Extract<TransitionResult, { accepted: true }>;

interface EventBody {
  readonly phase: AgentPhase;
  readonly commandId: string;
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly fencingToken: number;
  readonly agentId: string;
  readonly targetId: string;
  readonly seq: number;
  readonly sentAt: string;
  readonly acceptedAt?: string;
  readonly startedAt?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly durationMs?: number;
  readonly cicdResult?: CicdResult;
  readonly logTail?: string;
  readonly reason?: NotStartedReason;
  readonly journalEpoch?: string;
  readonly journalRetentionDays?: number;
  readonly log?: { readonly status: "UPLOADED" | "FAILED"; readonly key?: string; readonly bytes?: number; readonly sha256?: string };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function createAgentTransport(deps: AgentTransportDeps): AgentTransport {
  const timing = deps.timing ?? DEFAULT_AGENT_TIMING;
  const newEventId = deps.newEventId ?? (() => globalThis.crypto.randomUUID());
  const nowMs = (): number => deps.clock.now().getTime();
  const marginMs = (timing.clockSkewSeconds + timing.safetyMarginSeconds) * 1000;
  const warn = (message: string, fields: Record<string, unknown>): void => deps.onWarn?.(message, fields);
  const error = (message: string, fields: Record<string, unknown>): void => deps.onError?.(message, fields);

  function snapshotOf(item: ExecutionItem): AgentTargetSnapshot {
    if (!isAgentSnapshot(item.targetSnapshot)) throw new Error("agent-transport: not an sqs-agent execution");
    return item.targetSnapshot;
  }

  function backoff(queriesSent: number): number {
    const list = timing.queryBackoffSeconds;
    return (list[Math.min(queriesSent, list.length - 1)] ?? 3600) * 1000;
  }

  // -------------------------------------------------------------------------
  // Dispatch (§8)
  // -------------------------------------------------------------------------

  function dispatchFields(item: ExecutionItem, dispatchToken: string, now: number): { agent: AgentDispatchState; deadlineAt: number } {
    const s = snapshotOf(item);
    const timeoutSeconds = deps.deployTimeoutMinutes * 60;
    const notAfter = now + timing.notAfterSeconds * 1000;
    const agent: AgentDispatchState = {
      commandId: commandIdOf(item.executionId, dispatchToken),
      dispatchState: "PENDING_SEND",
      issuedAt: now,
      notAfter,
      hardDeadlineAt: hardDeadlineAt({
        notAfterMs: notAfter,
        timeoutSeconds,
        killGraceSeconds: timing.killGraceSeconds,
        clockSkewSeconds: timing.clockSkewSeconds,
        safetyMarginSeconds: timing.safetyMarginSeconds,
      }),
      timeoutSeconds,
      killGraceSeconds: timing.killGraceSeconds,
      sendAttempts: 0,
      lastEventSeq: 0,
      queriesSent: 0,
      log: {
        bucket: deps.logBucket,
        keyPrefix: `logs/${s.project}/${s.environment}/${item.targetId}/${item.executionId}/${dispatchToken}/`,
      },
    };
    // First reconciler checkpoint: a lost send is re-driven after `resendAfterSeconds`.
    return { agent, deadlineAt: now + timing.resendAfterSeconds * 1000 };
  }

  function commandOf(item: ExecutionItem): Record<string, unknown> {
    const s = snapshotOf(item);
    const a = item.agent as AgentDispatchState;
    return {
      specVersion: 1,
      type: "AGENT_COMMAND",
      commandId: a.commandId,
      executionId: item.executionId,
      dispatchToken: item.dispatchToken,
      fencingToken: item.fencingToken,
      agentId: s.agentId,
      targetId: item.targetId,
      scriptId: s.scriptId,
      args: [...basePlanOf(item, deps.deployTimeoutMinutes).scriptArgs(item.fencingToken as number)],
      issuedAt: iso(a.issuedAt),
      notAfter: iso(a.notAfter),
      timeoutSeconds: a.timeoutSeconds,
      killGraceSeconds: a.killGraceSeconds,
      log: { bucket: a.log?.bucket, keyPrefix: a.log?.keyPrefix },
      commit: item.commitSha,
      requestId: item.requestId,
      project: s.project,
      environment: s.environment,
    };
  }

  async function send(item: ExecutionItem): Promise<AgentSendOutcome> {
    const a = item.agent;
    if (item.status !== "DEPLOYING" || a === undefined || item.dispatchToken === undefined || item.fencingToken === undefined) return "STALE";
    const s = snapshotOf(item);
    const body = commandOf(item);
    const problems = deps.validators.command(body);
    if (problems !== undefined) {
      // A command we cannot build is never sent; the execution fails closed (X11), releasing the pinned lock.
      error("agent command invalid", { executionId: item.executionId, problems });
      await closeNeverStarted(item, "AGENT_DISPATCH_FAILED", "INVALID_COMMAND");
      return "INVALID_COMMAND";
    }
    const now = nowMs();
    try {
      await deps.dispatcher.send({
        queueUrl: s.commandQueueUrl,
        body,
        groupId: fifo.commandGroup(item.targetId),
        deduplicationId: fifo.commandDeduplication(a.commandId),
      });
    } catch (cause) {
      // The outbox keeps PENDING_SEND: the reconciler re-sends the SAME command (no new dispatch, no new token).
      warn("agent command send failed; the reconciler will re-send it", { executionId: item.executionId, error: cause instanceof Error ? cause.message : String(cause) });
      await deps.executions.update(
        item.executionId,
        { status: "DEPLOYING", version: item.version, dispatchToken: item.dispatchToken },
        { agent: { ...a, sendAttempts: a.sendAttempts + 1 }, activeStatus: "EXECUTION", deadlineAt: now + timing.resendAfterSeconds * 1000 } as ExecutionUpdatePatch,
      );
      return "SEND_FAILED";
    }
    // Informational: a lost write is harmless (the re-send is absorbed); events, not SENT, are authoritative.
    const nextCheck = (a.acceptedAt ?? item.execStartedAt) !== undefined ? a.hardDeadlineAt : a.notAfter + marginMs;
    await deps.executions.update(
      item.executionId,
      { status: "DEPLOYING", version: item.version, dispatchToken: item.dispatchToken },
      { agent: { ...a, dispatchState: "SENT", sentAt: a.sentAt ?? now, sendAttempts: a.sendAttempts + 1 }, activeStatus: "EXECUTION", deadlineAt: nextCheck } as ExecutionUpdatePatch,
    );
    return "SENT";
  }

  async function sendQuery(item: ExecutionItem): Promise<boolean> {
    const s = snapshotOf(item);
    const a = item.agent as AgentDispatchState;
    const queryNumber = a.queriesSent + 1;
    const body = {
      specVersion: 1,
      type: "AGENT_QUERY",
      queryNumber,
      commandId: a.commandId,
      executionId: item.executionId,
      dispatchToken: item.dispatchToken,
      agentId: s.agentId,
      targetId: item.targetId,
      commandIssuedAt: iso(a.issuedAt),
      notAfter: iso(a.notAfter),
      issuedAt: iso(nowMs()),
    };
    const problems = deps.validators.query(body);
    if (problems !== undefined) {
      error("agent query invalid", { executionId: item.executionId, problems });
      return false;
    }
    try {
      await deps.dispatcher.send({
        queueUrl: s.commandQueueUrl,
        body,
        groupId: fifo.commandGroup(item.targetId),
        deduplicationId: fifo.queryDeduplication(a.commandId, queryNumber),
      });
      return true;
    } catch (cause) {
      warn("agent query send failed; the next tick retries", { executionId: item.executionId, error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Closing (§7, §9): every close is one transaction with the lock
  // -------------------------------------------------------------------------

  function expectedOf(item: ExecutionItem): { status: "DEPLOYING"; version: number; dispatchToken: string } {
    return { status: "DEPLOYING", version: item.version, dispatchToken: item.dispatchToken as string };
  }

  async function closeAndRelease(item: ExecutionItem, t: Accepted, patch: ExecutionUpdatePatch): Promise<AgentEventOutcome> {
    const done = await deps.transactions.closeWithRelease({
      executionId: item.executionId,
      expected: expectedOf(item),
      patch,
      lockKey: item.targetId,
      owner: item.executionId,
      fencingToken: item.fencingToken as number,
      now: nowMs(),
    });
    if (done.outcome === "EXECUTION_CONFLICT") return { outcome: "RETRY" };
    if (done.outcome === "LOCK_CONDITION_FAILED") {
      // The pinned lock is not ours: never write a closing state that would look like a release. Operator attention.
      error("agent close refused: the pinned lock is not owned by this execution", { executionId: item.executionId, transitionId: t.transitionId });
      return { outcome: "REFUSED", reason: "LOCK_NOT_OWNED" };
    }
    return { outcome: "CLOSED", transitionId: t.transitionId, status: t.next.status };
  }

  async function closeUnknown(item: ExecutionItem, t: Accepted, extra: Record<string, unknown>, queryLater: boolean, holdReason: string): Promise<AgentEventOutcome> {
    const now = nowMs();
    const base = buildPatch(t, now, { extra: { ...extra, hold: { since: now } } });
    // §9.3: a silent agent is still queried while the target is held (HOLD partition of GSI2).
    const patch = (queryLater ? { ...base, activeStatus: "HOLD", deadlineAt: now + backoff(0) } : base) as ExecutionUpdatePatch;
    const done = await deps.transactions.markUnknownTargetState({
      executionId: item.executionId,
      expected: expectedOf(item),
      patch,
      lockKey: item.targetId,
      entry: { executionId: item.executionId, since: now },
      now,
      hold: { owner: item.executionId, fencingToken: item.fencingToken as number, reason: holdReason },
    });
    if (done.outcome === "EXECUTION_CONFLICT") return { outcome: "RETRY" };
    if (!done.held) error("X16 written but the lock was not this execution's to hold", { executionId: item.executionId });
    return { outcome: "CLOSED", transitionId: t.transitionId, status: t.next.status };
  }

  /** Never started, proved by the agent or by the dispatch: X14 (retry) for a transient cause, X11 otherwise. */
  async function closeNeverStarted(item: ExecutionItem, code: "AGENT_REJECTED" | "AGENT_DISPATCH_FAILED" | "RETRY", cause: string): Promise<AgentEventOutcome> {
    const now = nowMs();
    const a = item.agent as AgentDispatchState;
    if (code !== "RETRY") {
      const t = applyTransition(toExecutionSnapshot(item), { kind: "FAIL_BEFORE_EXEC", dispatchToken: item.dispatchToken as string, code });
      if (!t.accepted) return { outcome: "NOT_EVIDENCE" };
      return closeAndRelease(item, t, buildPatch(t, now, { extra: { agent: { ...a, cause } } }));
    }
    const plan = basePlanOf(item, deps.deployTimeoutMinutes);
    const v3 = await deps.windows.revalidate("V3", plan.window, now + plan.timeoutMinutes * 60_000);
    const attempts = (item.lockWaitAttempts ?? 0) + 1;
    const retry = nextLockRetry({ lockWaitStartedAt: item.lockWaitStartedAt ?? now, lockWaitAttempts: attempts - 1, now });
    const delaySeconds = retry.action === "RETRY" ? retry.delaySeconds : 0;
    const nextAttemptAt = now + delaySeconds * 1000;
    const t = applyTransition(
      { ...toExecutionSnapshot(item), lockWaitAttempts: attempts },
      { kind: "AGENT_NOT_STARTED", dispatchToken: item.dispatchToken as string, v3Valid: v3.ok, now, nextAttemptAt },
    );
    if (!t.accepted) return { outcome: "NOT_EVIDENCE" };
    const patch =
      t.transitionId === "X14"
        ? buildPatch(t, now, { deadlineAt: nextAttemptAt + WAITING_LOCK_GRACE_MS, extra: { lockWaitAttempts: attempts, agent: undefined } })
        : buildPatch(t, now, { extra: { lockWaitAttempts: attempts, agent: { ...a, cause } } });
    const closed = await closeAndRelease(item, t, patch);
    if (closed.outcome === "CLOSED" && t.transitionId === "X14") {
      // CW-2: nextAttemptAt is persisted; now publish the retry (the attempt is the new execution.attempt + 1).
      const event: LockRetryRequestedEvent = {
        specVersion: 1,
        eventId: newEventId(),
        eventType: "LOCK_RETRY_REQUESTED",
        timestamp: deps.clock.now().toISOString(),
        source: "executor",
        executionId: item.executionId,
        attempt: t.next.attempt + 1,
      };
      await deps.queue.publish({ body: { ...event }, delaySeconds });
    }
    return closed;
  }

  async function closeFinished(item: ExecutionItem, ev: EventBody): Promise<AgentEventOutcome> {
    const now = nowMs();
    const a = item.agent as AgentDispatchState;
    const exitCode = ev.exitCode as number;
    const logTail = ev.logTail?.slice(-LOG_TAIL_MAX_CHARS);
    const result = {
      code: exitCode,
      ...(ev.cicdResult === undefined ? {} : { cicdResult: JSON.stringify(ev.cicdResult) }),
      ...(logTail === undefined ? {} : { logTail }),
    };
    // execStartedAt is set from STARTED; a FINISHED proves the start even if STARTED was lost.
    const startedAt = item.execStartedAt ?? (Date.parse(ev.sentAt) - (ev.durationMs ?? 0));
    const current = { ...toExecutionSnapshot(item), execStartedAt: startedAt };
    if (ev.timedOut === true) {
      const t = applyTransition(current, { kind: "AGENT_UNKNOWN", dispatchToken: item.dispatchToken as string });
      if (!t.accepted) return { outcome: "NOT_EVIDENCE" };
      return closeUnknown(item, t, { execStartedAt: startedAt, result, agent: { ...a, cause: "TIMEOUT" } }, false, "TIMEOUT");
    }
    if (exitCode === 50) return closeNeverStartedAfterBusyExit(item, result);
    const t = applyTransition(current, { kind: "SCRIPT_EXITED", dispatchToken: item.dispatchToken as string, exitCode, v3Valid: true, now, nextAttemptAt: now });
    if (!t.accepted) {
      // An exit outside the contract on a run without execStartedAt cannot use SCRIPT_EXITED's X16 guard.
      const u = applyTransition(current, { kind: "AGENT_UNKNOWN", dispatchToken: item.dispatchToken as string });
      if (!u.accepted) return { outcome: "NOT_EVIDENCE" };
      return closeUnknown(item, u, { execStartedAt: startedAt, result, agent: { ...a, cause: `EXIT_${String(exitCode)}` } }, false, `EXIT_${String(exitCode)}`);
    }
    const extra: Record<string, unknown> = {
      execStartedAt: startedAt,
      result,
      agent: { ...a, lastEventSeq: ev.seq },
      ...(t.transitionId !== "X16" && ev.cicdResult === undefined ? { cicdResultMissing: true } : {}),
    };
    if (t.transitionId === "X16") return closeUnknown(item, t, extra, false, `EXIT_${String(exitCode)}`);
    if (t.transitionId === "X12") {
      const written = await deps.target.recordDeployed({
        lockKey: item.targetId,
        fencingToken: item.fencingToken as number,
        lastDeployed: { sourceRef: item.order.sourceRef, runNumber: item.order.runNumber, executionId: item.executionId, commitSha: item.commitSha },
        ...(ev.cicdResult?.deployedImages === undefined ? {} : { currentImages: ev.cicdResult.deployedImages }),
        ...(ev.cicdResult?.previousImages === undefined ? {} : { previousImages: ev.cicdResult.previousImages }),
        updatedAt: now,
      });
      Object.assign(extra, written.written ? {} : { targetWriteRejected: true }, versionCheckOf(item, ev.cicdResult));
    }
    return closeAndRelease(item, t, buildPatch(t, now, { extra }));
  }

  /** Exit 50: the target mutex was held and nothing was done (AC-03): X14 or X15, like the SSH path. */
  async function closeNeverStartedAfterBusyExit(item: ExecutionItem, result: Record<string, unknown>): Promise<AgentEventOutcome> {
    const now = nowMs();
    const plan = basePlanOf(item, deps.deployTimeoutMinutes);
    const v3 = await deps.windows.revalidate("V3", plan.window, now + plan.timeoutMinutes * 60_000);
    const attempts = (item.lockWaitAttempts ?? 0) + 1;
    const retry = nextLockRetry({ lockWaitStartedAt: item.lockWaitStartedAt ?? now, lockWaitAttempts: attempts - 1, now });
    const delaySeconds = retry.action === "RETRY" ? retry.delaySeconds : 0;
    const nextAttemptAt = now + delaySeconds * 1000;
    const t = applyTransition(
      { ...toExecutionSnapshot(item), lockWaitAttempts: attempts },
      { kind: "SCRIPT_EXITED", dispatchToken: item.dispatchToken as string, exitCode: 50, v3Valid: v3.ok, now, nextAttemptAt },
    );
    if (!t.accepted) return { outcome: "NOT_EVIDENCE" };
    const patch =
      t.transitionId === "X14"
        ? buildPatch(t, now, { deadlineAt: nextAttemptAt + WAITING_LOCK_GRACE_MS, extra: { lockWaitAttempts: attempts, agent: undefined } })
        : buildPatch(t, now, { extra: { lockWaitAttempts: attempts, result } });
    const closed = await closeAndRelease(item, t, patch);
    if (closed.outcome === "CLOSED" && t.transitionId === "X14") {
      const event: LockRetryRequestedEvent = {
        specVersion: 1,
        eventId: newEventId(),
        eventType: "LOCK_RETRY_REQUESTED",
        timestamp: deps.clock.now().toISOString(),
        source: "executor",
        executionId: item.executionId,
        attempt: t.next.attempt + 1,
      };
      await deps.queue.publish({ body: { ...event }, delaySeconds });
    }
    return closed;
  }

  // -------------------------------------------------------------------------
  // Events (§6, §7)
  // -------------------------------------------------------------------------

  function neverSeenOf(item: ExecutionItem, ev: EventBody): NeverSeenVerdict | undefined {
    if (ev.phase !== "NEVER_SEEN" || ev.journalEpoch === undefined || ev.journalRetentionDays === undefined) return undefined;
    const a = item.agent as AgentDispatchState;
    return neverSeenVerdict({
      commandIssuedAtMs: a.issuedAt,
      notAfterMs: a.notAfter,
      journalEpochMs: Date.parse(ev.journalEpoch),
      journalRetentionDays: ev.journalRetentionDays,
      answeredAtMs: Date.parse(ev.sentAt),
      clockSkewSeconds: timing.clockSkewSeconds,
    });
  }

  async function audit(item: ExecutionItem, ev: EventBody, disposition: AgentEventDisposition): Promise<boolean> {
    return deps.audit.record({
      executionId: item.executionId,
      dispatchToken: ev.dispatchToken,
      seq: ev.seq,
      phase: ev.phase,
      agentId: ev.agentId,
      sentAt: ev.sentAt,
      receivedAt: nowMs(),
      disposition,
      ...(ev.reason === undefined ? {} : { reason: ev.reason }),
      ...(ev.exitCode === undefined ? {} : { exitCode: ev.exitCode }),
    });
  }

  async function applyProgress(item: ExecutionItem, ev: EventBody): Promise<AgentEventOutcome> {
    const a = item.agent as AgentDispatchState;
    const next: Record<string, unknown> = { ...a, lastEventSeq: ev.seq };
    const patch: Record<string, unknown> = { activeStatus: "EXECUTION", deadlineAt: item.deadlineAt };
    if (ev.phase === "ACCEPTED") {
      next.acceptedAt = Date.parse(ev.acceptedAt as string);
      patch.deadlineAt = a.hardDeadlineAt; // from now on only the hard deadline matters (no query needed)
    }
    if (ev.phase === "STARTED") {
      if (item.execStartedAt === undefined) patch.execStartedAt = Date.parse(ev.startedAt as string);
      patch.deadlineAt = a.hardDeadlineAt;
    }
    if (ev.phase === "HEARTBEAT") next.lastHeartbeatAt = Date.parse(ev.sentAt);
    if (ev.phase === "LOG_UPLOADED" && ev.log !== undefined) next.log = { ...(a.log ?? {}), ...ev.log };
    patch.agent = next;
    const done = await deps.executions.update(item.executionId, expectedOf(item), patch as ExecutionUpdatePatch);
    return done ? { outcome: "PROGRESS" } : { outcome: "RETRY" };
  }

  async function applyToHeld(item: ExecutionItem, ev: EventBody, facts: AgentEventFacts): Promise<AgentEventOutcome> {
    const lock = await deps.locks.get(item.targetId);
    const heldByThis = lock !== undefined && lock.hold === true && lock.owner === item.executionId && lock.fencingToken === item.fencingToken;
    if (!heldByThis) {
      await audit(item, ev, "LATE");
      return { outcome: "LATE" };
    }
    const decision = holdDecision(facts);
    if (decision === "KEEP") {
      await audit(item, ev, "NOT_EVIDENCE");
      return { outcome: "NOT_EVIDENCE" };
    }
    if (decision === "OPERATOR_REQUIRED") {
      // OP-1: a late FINISHED (or LOST) is evidence for the operator, never an automatic release.
      await audit(item, ev, "OPERATOR_REQUIRED");
      warn("late agent result on a held target: operator resolution required", { executionId: item.executionId, phase: ev.phase, exitCode: ev.exitCode });
      await stopHoldQueries(item);
      return { outcome: "OPERATOR_REQUIRED" };
    }
    // Verified never-started evidence: the same resolution path as an operator (OP-2), with the agent as actor.
    const resolved = await deps.resolver.resolveWithEvidence({
      eventId: `agent-evidence:${ev.commandId}:${String(ev.seq)}`,
      targetId: item.targetId,
      executionId: item.executionId,
      resolvedBy: `agent:${ev.agentId}`,
      note: `${ev.phase}${ev.reason === undefined ? "" : ` ${ev.reason}`}: the command never started`,
    });
    if (resolved === "CONFLICT") return { outcome: "RETRY" };
    if (resolved === "REJECTED") {
      await audit(item, ev, "NOT_EVIDENCE");
      return { outcome: "NOT_EVIDENCE" };
    }
    await audit(item, ev, "HOLD_RELEASED");
    await stopHoldQueries(item);
    return { outcome: "HOLD_RELEASED" };
  }

  /** Leaves the HOLD partition (no more queries): the hold itself is unchanged. */
  async function stopHoldQueries(item: ExecutionItem): Promise<void> {
    const fresh = await deps.executions.get(item.executionId);
    if (fresh === undefined || fresh.activeStatus !== "HOLD") return;
    await deps.executions.update(fresh.executionId, { status: "UNKNOWN_TARGET_STATE", version: fresh.version }, { activeStatus: undefined, deadlineAt: undefined } as ExecutionUpdatePatch);
  }

  async function applyEvent(body: unknown, senderRoleId: string | undefined): Promise<AgentEventOutcome> {
    const problems = deps.validators.event(body);
    if (problems !== undefined) return { outcome: "INVALID", problems };
    const ev = body as EventBody;
    const parsed = parseCommandId(ev.commandId);
    if (parsed === undefined || parsed.executionId !== ev.executionId || parsed.dispatchToken !== ev.dispatchToken) {
      return { outcome: "INVALID", problems: ["commandId is not <executionId>:<dispatchToken>"] };
    }
    const item = await deps.executions.get(ev.executionId);
    if (item === undefined) return { outcome: "UNKNOWN_EXECUTION" };
    if (!isAgentSnapshot(item.targetSnapshot)) return { outcome: "REFUSED", reason: "NOT_AN_AGENT_TARGET" };
    const s = item.targetSnapshot;
    // §11.4: the sender is the agent role snapshotted at X1, the event names that agent and that target.
    if (senderRoleId === undefined || senderRoleId !== s.agentRoleId) return { outcome: "REFUSED", reason: "SENDER_NOT_THE_TARGET_AGENT" };
    if (ev.agentId !== s.agentId || ev.targetId !== item.targetId) return { outcome: "REFUSED", reason: "AGENT_OR_TARGET_MISMATCH" };

    const facts: AgentEventFacts = {
      phase: ev.phase,
      ...(ev.reason === undefined ? {} : { reason: ev.reason }),
      ...(ev.exitCode === undefined ? {} : { exitCode: ev.exitCode }),
      ...(ev.timedOut === undefined ? {} : { timedOut: ev.timedOut }),
    };
    const isCurrent = item.dispatchToken === ev.dispatchToken && item.agent !== undefined;
    if (isCurrent && ev.phase === "NEVER_SEEN") {
      const verdict = neverSeenOf(item, ev);
      if (verdict !== undefined) Object.assign(facts, { neverSeen: verdict });
    }

    if (item.status === "UNKNOWN_TARGET_STATE" && isCurrent) return applyToHeld(item, ev, facts);
    if (item.status !== "DEPLOYING" || !isCurrent) {
      await audit(item, ev, "LATE");
      return { outcome: "LATE" };
    }
    if ((ev.fencingToken !== 0 && ev.fencingToken !== item.fencingToken)) {
      await audit(item, ev, "LATE");
      return { outcome: "REFUSED", reason: "FENCING_TOKEN_MISMATCH" };
    }
    const a = item.agent as AgentDispatchState;
    if (ev.seq <= a.lastEventSeq) {
      await audit(item, ev, "DUPLICATE");
      return { outcome: "DUPLICATE" };
    }

    const effect = effectOfAgentEvent(facts);
    if (effect.kind === "PROGRESS") {
      const out = await applyProgress(item, ev);
      if (out.outcome === "PROGRESS") await audit(item, ev, "PROGRESS");
      return out;
    }
    if (effect.kind === "NOT_EVIDENCE") {
      await audit(item, ev, "NOT_EVIDENCE");
      return { outcome: "NOT_EVIDENCE" };
    }
    let out: AgentEventOutcome;
    if (ev.phase === "FINISHED") out = await closeFinished(item, ev);
    else if (ev.phase === "LOST") {
      const startedAt = item.execStartedAt ?? Date.parse(ev.startedAt as string);
      const t = applyTransition({ ...toExecutionSnapshot(item), execStartedAt: startedAt }, { kind: "AGENT_UNKNOWN", dispatchToken: item.dispatchToken as string });
      out = t.accepted ? await closeUnknown(item, t, { execStartedAt: startedAt, agent: { ...a, lastEventSeq: ev.seq, cause: "AGENT_LOST" } }, false, "AGENT_LOST") : { outcome: "NOT_EVIDENCE" };
    } else if (effect.transition === "X11") out = await closeNeverStarted(item, "AGENT_REJECTED", effect.cause);
    else out = await closeNeverStarted(item, "RETRY", effect.cause); // NOT_STARTED retry causes and valid NEVER_SEEN
    if (out.outcome === "CLOSED") await audit(item, ev, "APPLIED");
    return out;
  }

  async function applyHeartbeat(body: unknown, senderRoleId: string | undefined): Promise<"RECORDED" | "REFUSED" | "INVALID"> {
    if (deps.validators.heartbeat(body) !== undefined) return "INVALID";
    const hb = body as { agentId: string; agentVersion: string; sentAt: string; clockOffsetMs: number; running: string[] };
    const roleId = await deps.registry.agentRoleId(hb.agentId);
    if (roleId === undefined || senderRoleId !== roleId) return "REFUSED";
    await deps.audit.recordLiveness({ agentId: hb.agentId, agentVersion: hb.agentVersion, lastSeenAt: nowMs(), clockOffsetMs: hb.clockOffsetMs, running: hb.running });
    return "RECORDED";
  }

  // -------------------------------------------------------------------------
  // Reconciliation (§8, §9.3)
  // -------------------------------------------------------------------------

  async function reconcile(item: ExecutionItem, now: number): Promise<AgentReconcileAction> {
    const a = item.agent;
    if (a === undefined || item.dispatchToken === undefined) return "SKIPPED";

    if (item.status === "UNKNOWN_TARGET_STATE") {
      if (item.activeStatus !== "HOLD") return "SKIPPED";
      const lock = await deps.locks.get(item.targetId);
      const stillHeld = lock !== undefined && lock.hold === true && lock.owner === item.executionId;
      if (!stillHeld) {
        await stopHoldQueries(item);
        return "HOLD_CLEARED";
      }
      if (a.queriesSent >= timing.maxQueries) {
        await stopHoldQueries(item);
        warn("held target: the agent never answered the evidence queries; operator resolution required", { executionId: item.executionId });
        return "HOLD_QUERIES_EXHAUSTED";
      }
      const sent = await sendQuery(item);
      await deps.executions.update(
        item.executionId,
        { status: "UNKNOWN_TARGET_STATE", version: item.version },
        { agent: { ...a, ...(sent ? { queriesSent: a.queriesSent + 1, lastQueryAt: now } : {}) }, activeStatus: "HOLD", deadlineAt: now + backoff(a.queriesSent) } as ExecutionUpdatePatch,
      );
      return sent ? "HOLD_QUERY_SENT" : "SKIPPED";
    }

    if (item.status !== "DEPLOYING") return "SKIPPED";
    const expected = expectedOf(item);

    // Hard deadline: no process of this command can exist any more if the agent honors its contract; the outcome is
    // unknown unless an event said otherwise, so X16 with a hold (silence is never evidence) and keep querying.
    if (now >= a.hardDeadlineAt) {
      const t = applyTransition(toExecutionSnapshot(item), { kind: "RECONCILE_OVERDUE_DEPLOYING", now, silenceIsUnknown: true });
      if (!t.accepted) return "SKIPPED";
      const out = await closeUnknown(item, t, { agent: { ...a, cause: "HARD_DEADLINE" } }, true, "HARD_DEADLINE");
      return out.outcome === "CLOSED" ? "UNKNOWN_TARGET_STATE" : "SKIPPED";
    }

    // Lost send: re-send the SAME command while it can still start.
    if (a.dispatchState === "PENDING_SEND" && now < a.notAfter - timing.safetyMarginSeconds * 1000) {
      const sent = await send(item);
      return sent === "SENT" ? "AGENT_COMMAND_RESENT" : "SKIPPED";
    }

    const started = a.acceptedAt !== undefined || item.execStartedAt !== undefined;
    if (!started && now >= a.notAfter + marginMs) {
      const sent = await sendQuery(item);
      const nextCheck = Math.min(now + backoff(a.queriesSent), a.hardDeadlineAt);
      await deps.executions.update(
        item.executionId,
        expected,
        { agent: { ...a, ...(sent ? { queriesSent: a.queriesSent + 1, lastQueryAt: now } : {}) }, activeStatus: "EXECUTION", deadlineAt: nextCheck } as ExecutionUpdatePatch,
      );
      return sent ? "AGENT_QUERY_SENT" : "SKIPPED";
    }

    // Nothing to do yet: move the checkpoint to the next moment that matters.
    const nextCheck = started ? a.hardDeadlineAt : a.dispatchState === "PENDING_SEND" ? a.notAfter + marginMs : a.notAfter + marginMs;
    if (nextCheck !== item.deadlineAt) {
      await deps.executions.update(item.executionId, expected, { activeStatus: "EXECUTION", deadlineAt: nextCheck } as ExecutionUpdatePatch);
    }
    return "SKIPPED";
  }

  return { dispatchFields, send, applyEvent, applyHeartbeat, reconcile };
}
