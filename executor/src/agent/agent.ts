// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §9.3, §10.1–§10.6, §12, §16
// The server agent (AC-04 E3): one per server and platform stage, many targets through its catalog.
//
// Per command, in this order (§10.3), every step journaled with fsync BEFORE the next one:
//   validate (schema, Executor SenderId, own agentId, catalog target + scriptId, argument vector, kill grace)
//   -> acceptance rule (duplicate, PREDATES_JOURNAL, clock skew, expiry, TARGET_ACTIVE, STALE_FENCING)
//   -> wait for a local slot (message kept invisible; BUSY at notAfter)
//   -> journal ACCEPTED + target state (active, highest fencing token) -> DeleteMessage
//   -> journal STARTING -> spawn -> journal STARTED -> ... -> journal FINISHED -> logs to S3.
// Every event goes through a persistent outbox (sent in seq order, survives restarts) and never blocks the start.
// Restart recovery: ACCEPTED without STARTING -> NOT_STARTED ABANDONED (never started later); STARTING or STARTED
// -> LOST, after stopping the script if it still runs unwatched (abrupt end of the previous process); FINISHED with
// pending logs -> upload retried.
// Real guarantee: a command STARTS AT MOST ONCE; an interrupted run is reported LOST (unknown effect), never re-run.
// Shutdown (SIGTERM, `shutdown()`): stop receiving at once (the in-flight long poll is aborted), hand every command still
// waiting for a slot back to the queue (never journaled, so nothing is lost), start nothing new, let running scripts
// finish within `shutdownGraceSeconds` (their own timeouts still apply), then interrupt what is left and report it LOST
// (the Executor keeps the target held), flush the outbox and exit. Applications are never signaled by the agent: a
// script that exited is never killed afterwards, and nothing the agent does touches Docker, PM2 or other services.
import {
  AGENT_PROTOCOL_DEFAULTS,
  clearActiveCommand,
  decideAcceptance,
  fifo,
  neverSeenVerdict,
  parseCommandId,
  type NotStartedReason,
} from "../domain/agent-protocol/index.js";
import { redactString } from "../observability/logger/redaction.js";
import type { AgentConfig, CatalogTarget } from "./config.js";
import type { AgentLogger, CommandSource, EventSink, LogStore, ReceivedCommandMessage, ScriptCredentials } from "./ports.js";
import { defaultProcessInspector, type ProcessInspector } from "./processes.js";
import { LocalScheduler } from "./scheduler.js";
import { startScript, type RunHandle, type SpawnFn } from "./runner.js";
import type { AgentStateStore, JournalEntry, JournalState } from "./state-store.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const AGENT_VERSION = "1.0.0";
const LOG_UPLOAD_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const NO_RECORD_SEQ_BASE = 900_000;
const DAY_MS = 86_400_000;

export interface MessageValidators {
  command(body: unknown): readonly string[] | undefined;
  query(body: unknown): readonly string[] | undefined;
}

/** Test hooks: throw at a crash point to simulate the agent dying there (the next instance recovers). */
export type CrashPoint = "AFTER_ACCEPTED" | "AFTER_DELETE" | "AFTER_STARTING";

export interface AgentDeps {
  readonly config: AgentConfig;
  readonly store: AgentStateStore;
  readonly source: CommandSource;
  readonly sink: EventSink;
  readonly logs: LogStore;
  readonly credentials?: ScriptCredentials;
  readonly validators: MessageValidators;
  readonly clock: { now(): number };
  /** Offset of the local clock to AWS (ms), as measured by the SDK; the agent refuses to start commands when too large. */
  readonly clockOffsetMs: () => number;
  readonly logger: AgentLogger;
  readonly spawn?: SpawnFn;
  readonly crashAt?: CrashPoint;
  /** Base environment of every script (allowlist); script-role credentials are added per run. */
  readonly baseEnv?: Readonly<Record<string, string>>;
  /** Identifies scripts of a previous agent process that still run (Linux /proc); default per platform. */
  readonly processes?: ProcessInspector;
  /** How long to keep reading a script's pipes after it exited (runner default 5 s; shorter in tests). */
  readonly stdioDrainMs?: number;
}

interface Command {
  readonly commandId: string;
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly fencingToken: number;
  readonly agentId: string;
  readonly targetId: string;
  readonly scriptId: string;
  readonly args: readonly string[];
  readonly issuedAt: string;
  readonly notAfter: string;
  readonly timeoutSeconds: number;
  readonly killGraceSeconds: number;
  readonly log: { readonly bucket: string; readonly keyPrefix: string };
  readonly commit: string;
  readonly requestId: string;
}

interface Pending {
  readonly message: ReceivedCommandMessage;
  readonly command: Command;
  readonly target: CatalogTarget;
  readonly receivedAt: number;
  readonly notAfter: number;
}

export class SimulatedCrash extends Error {
  public constructor(public readonly point: CrashPoint) {
    super(`simulated crash at ${point}`);
  }
}

const TERMINAL: ReadonlySet<JournalState> = new Set(["FINISHED", "NOT_STARTED", "LOST"]);

export class Agent {
  private readonly scheduler: LocalScheduler;
  private readonly pending = new Map<string, Pending>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly interrupted = new Set<string>();
  /** Commands whose logs still have to reach S3 (an index, so an idle agent never re-reads the whole journal). */
  private readonly logsPending = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private draining = false;
  private pollAbort: AbortController | undefined;
  private lastPruneAt = 0;

  public constructor(private readonly deps: AgentDeps) {
    this.scheduler = new LocalScheduler(deps.config.maxParallel, deps.config.resources);
  }

  private now(): number {
    return this.deps.clock.now();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Start and recovery (§10.5)
  // ---------------------------------------------------------------------------------------------------------------

  /** Resolves every non-terminal journal entry left by a previous process, rebuilds target states, flushes the outbox. */
  public async start(): Promise<void> {
    const highest = new Map<string, number>();
    for (const entry of this.deps.store.entries()) {
      highest.set(entry.targetId, Math.max(highest.get(entry.targetId) ?? 0, entry.fencingToken));
      if (entry.state === "ACCEPTED") {
        // Accepted but never reached STARTING: provably never started, and it never will.
        this.finishNotStarted(entry, "ABANDONED");
      } else if (entry.state === "STARTING" || entry.state === "STARTED") {
        // Maybe started, interrupted with the previous agent process: unknown effect, never re-run. If that process died
        // abruptly its script may still run unwatched: stop it first, so no deploy outlives its agent.
        await this.stopOrphan(entry);
        const lost = this.save({ ...entry, state: "LOST", finishedAt: this.now(), log: { ...entry.log, status: "PENDING" } });
        this.emit(lost, "LOST", { startedAt: new Date(entry.startedAt ?? entry.startingAt ?? this.now()).toISOString() });
      }
    }
    for (const [targetId, token] of highest) this.deps.store.putTarget(targetId, { highestFencingToken: token });
    for (const entry of this.deps.store.entries()) if (entry.log.status === "PENDING") this.logsPending.add(entry.commandId);
    this.prune(this.now());
    await this.flushOutbox();
    await this.retryLogUploads();
  }

  /**
   * A script of the previous agent process that is still running (same pid, started inside the journaled spawn window,
   * group leader alive): SIGTERM to its group, SIGKILL after the kill grace. A recycled pid or a script that already
   * exited is never signaled. Real-time waits: this runs once, before any command is received.
   */
  private async stopOrphan(entry: JournalEntry): Promise<void> {
    const pid = entry.pid;
    if (pid === undefined || pid <= 0) return;
    const inspector = this.deps.processes ?? defaultProcessInspector();
    const from = (entry.startingAt ?? entry.startedAt ?? 0) - 2000;
    const to = (entry.startedAt ?? entry.startingAt ?? 0) + 2000;
    const ours = (): boolean => {
      const started = inspector.startTimeMs(pid);
      return started !== undefined && started >= from && started <= to;
    };
    if (!ours()) return;
    const ids = { executionId: entry.executionId, targetId: entry.targetId, pid };
    this.deps.logger.warn("a script of the previous agent process is still running: stopping it", ids);
    const gone = async (ms: number): Promise<boolean> => {
      for (let waited = 0; waited < ms; waited += 250) {
        if (!ours()) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return !ours();
    };
    inspector.signalGroup(pid, "SIGTERM");
    if (await gone((this.deps.config.targets[entry.targetId]?.killGraceSeconds ?? AGENT_PROTOCOL_DEFAULTS.killGraceSeconds) * 1000)) return;
    inspector.signalGroup(pid, "SIGKILL");
    if (!(await gone(5000))) this.deps.logger.error("a script of the previous agent process could not be stopped; it is reported LOST and the target stays held", ids);
  }

  /** Removes closed entries past the journal retention (events sent, logs settled); at start and once a day. */
  private prune(now: number): void {
    this.lastPruneAt = now;
    const unsent = new Set(this.deps.store.pending().map((i) => i.commandId));
    this.deps.store.prune(now, this.deps.config.journalRetentionDays, (e) => TERMINAL.has(e.state) && e.log.status !== "PENDING" && !unsent.has(e.commandId) && !this.running.has(e.commandId));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Shutdown (SIGTERM): drain, never kill applications
  // ---------------------------------------------------------------------------------------------------------------

  public get isDraining(): boolean {
    return this.draining;
  }

  /** Stops receiving (aborts the long poll) and hands every command still waiting for a slot back to the queue. */
  public async beginShutdown(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.pollAbort?.abort();
    for (const p of this.pending.values()) await this.handBack(p.message);
    this.pending.clear();
    this.deps.logger.info("shutdown: receiving stopped, waiting for running scripts", { running: [...this.running.keys()] });
  }

  /**
   * Drains: running scripts may finish within `graceMs`; what is still running then is interrupted and reported LOST
   * (never FINISHED: the agent cut it short, the target state is unknown). Persists everything and flushes the outbox.
   */
  public async shutdown(graceMs = this.deps.config.shutdownGraceSeconds * 1000): Promise<{ readonly finished: number; readonly interrupted: number }> {
    await this.beginShutdown();
    const atStart = this.running.size;
    let timer: NodeJS.Timeout | undefined;
    const inTime = await Promise.race([
      this.idle().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    let interrupted = 0;
    if (!inTime) {
      for (const [commandId, handle] of this.handles) {
        this.interrupted.add(commandId);
        handle.interrupt();
        interrupted += 1;
      }
      this.deps.logger.warn("shutdown grace expired: running scripts interrupted and reported LOST", { interrupted });
      await this.idle();
    }
    await this.flushOutbox();
    return { finished: atStart - interrupted, interrupted };
  }

  /** Back to the queue at once (visibility 0): it was never journaled, so the next agent process handles it normally. */
  private async handBack(message: ReceivedCommandMessage): Promise<void> {
    await this.deps.source.extendVisibility(message.receiptHandle, 0).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------------------------------------------

  /** One receive + processing round, then starts whatever pending command can run, then flushes the outbox. */
  public async pollOnce(): Promise<void> {
    const room = this.deps.config.maxPending - this.pending.size;
    if (room > 0 && !this.draining) {
      const abort = new AbortController();
      this.pollAbort = abort;
      let messages: readonly ReceivedCommandMessage[];
      try {
        messages = await this.deps.source.receive(Math.min(10, room), abort.signal);
      } catch (error) {
        if (!this.draining) throw error;
        messages = []; // the long poll was aborted by the shutdown
      } finally {
        this.pollAbort = undefined;
      }
      // A batch that arrives after the shutdown began is handed back untouched (no journal, no event).
      for (const message of messages) await (this.draining ? this.handBack(message) : this.handleMessage(message));
    }
    await this.tick();
  }

  /** Starts pending commands that fit, expires the ones that cannot start in time, flushes events, retries logs. */
  public async tick(): Promise<void> {
    const now = this.now();
    if (now - this.lastPruneAt >= DAY_MS) this.prune(now);
    if (this.draining) {
      // Nothing new starts during a shutdown; events and logs still go out.
      await this.flushOutbox();
      await this.retryLogUploads();
      return;
    }
    const requests = [...this.pending.values()].map((p) => ({
      commandId: p.command.commandId,
      targetId: p.target.targetId,
      resources: p.target.resources,
      receivedAt: p.receivedAt,
      notAfter: p.notAfter,
      p,
    }));
    const blockedBy: (typeof requests)[number][] = [];
    for (const request of this.scheduler.order(requests, now)) {
      const { p } = request;
      if (now > p.notAfter) {
        this.pending.delete(p.command.commandId);
        await this.reject(p.message, p.command, "BUSY");
        continue;
      }
      // Starvation guard: a younger command may not take what an older, starving command is waiting for.
      if (blockedBy.some((older) => this.scheduler.blocksYounger(older, request))) {
        await this.deps.source.extendVisibility(p.message.receiptHandle, 60).catch(() => undefined);
        continue;
      }
      if (this.scheduler.tryReserve(request)) {
        this.pending.delete(p.command.commandId);
        await this.acceptAndRun(p);
      } else {
        if (now - p.receivedAt > (p.notAfter - p.receivedAt) / 2) blockedBy.push(request);
        await this.deps.source.extendVisibility(p.message.receiptHandle, 60).catch(() => undefined);
      }
    }
    await this.flushOutbox();
    await this.retryLogUploads();
  }

  /** Resolves when every running script has ended and its FINISHED is journaled. */
  public async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  public startHeartbeat(): void {
    const send = (): void => {
      void this.deps.sink
        .send({
          body: {
            specVersion: 1,
            type: "AGENT_HEARTBEAT",
            agentId: this.deps.config.agentId,
            agentVersion: AGENT_VERSION,
            sentAt: new Date(this.now()).toISOString(),
            clockOffsetMs: Math.round(this.deps.clockOffsetMs()),
            running: [...this.running.keys()],
          },
          groupId: fifo.heartbeatGroup(this.deps.config.agentId),
          deduplicationId: `hb-${this.deps.config.agentId}-${String(this.now())}`,
        })
        .catch(() => undefined); // liveness only
    };
    send();
    this.heartbeatTimer = setInterval(send, this.deps.config.heartbeatSeconds * 1000);
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------------------------------------------

  public async handleMessage(message: ReceivedCommandMessage): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(message.body);
    } catch {
      this.deps.logger.warn("unparseable command message dropped", { messageId: message.messageId });
      await this.deps.source.delete(message.receiptHandle);
      return;
    }
    const type = (body as { type?: unknown } | null)?.type;
    if (type === "AGENT_QUERY") return this.handleQuery(message, body);
    if (type === "AGENT_COMMAND") return this.handleCommand(message, body);
    this.deps.logger.warn("unknown command message dropped", { messageId: message.messageId });
    await this.deps.source.delete(message.receiptHandle);
  }

  private senderIsExecutor(message: ReceivedCommandMessage): boolean {
    const senderId = message.senderId ?? "";
    const roleId = senderId.includes(":") ? senderId.slice(0, senderId.indexOf(":")) : senderId;
    return roleId === this.deps.config.executorRoleId;
  }

  /** The exact AC-03 vector the catalog mode allows (§10.2): nothing can be added, removed or reordered. */
  private argsMatch(command: Command, target: CatalogTarget): boolean {
    if (target.arguments === "none") return command.args.length === 0;
    const a = command.args;
    const head = ["--target-id", command.targetId, "--execution-id", command.executionId, "--fencing-token", String(command.fencingToken), "--commit-sha", command.commit];
    if (a.length < head.length || head.some((v, i) => a[i] !== v)) return false;
    const rest = a.slice(head.length);
    if (rest.length % 2 !== 0) return false;
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] !== "--artifact" || !/^[a-z0-9][a-z0-9-]{0,62}=sha256:[0-9a-f]{64}$/.test(rest[i + 1] ?? "")) return false;
    }
    return true;
  }

  private async handleCommand(message: ReceivedCommandMessage, body: unknown): Promise<void> {
    // Only the Executor role may command this agent (§11.4). Anything else is dropped WITHOUT a journal entry or an
    // event: a forged message must never be able to pre-claim (and so block) the commandId of a real future command.
    if (!this.senderIsExecutor(message)) {
      this.deps.logger.warn("command from an unauthorized sender dropped", { messageId: message.messageId });
      await this.deps.source.delete(message.receiptHandle);
      return;
    }
    const problems = this.deps.validators.command(body);
    const command = body as Command;
    const ids = typeof command.commandId === "string" ? parseCommandId(command.commandId) : undefined;
    if (problems !== undefined) {
      this.deps.logger.warn("invalid command", { messageId: message.messageId, problems });
      // With trustworthy identifiers the Executor learns the refusal; otherwise there is nobody to tell.
      if (ids !== undefined && Number.isInteger(command.fencingToken) && typeof command.targetId === "string") await this.reject(message, command, "REJECTED_SCHEMA");
      else await this.deps.source.delete(message.receiptHandle);
      return;
    }
    // A journaled command is never run again: re-send its last event (the Executor ignores duplicates).
    const existing = this.deps.store.getEntry(command.commandId);
    if (existing !== undefined) {
      this.resendLast(existing);
      await this.deps.source.delete(message.receiptHandle);
      return;
    }
    if (command.agentId !== this.deps.config.agentId) return this.reject(message, command, "REJECTED_AGENT");
    const target = this.deps.config.targets[command.targetId];
    if (target === undefined) return this.reject(message, command, "REJECTED_TARGET");
    if (target.scriptId !== command.scriptId) return this.reject(message, command, "REJECTED_SCRIPT");
    if (!this.argsMatch(command, target)) return this.reject(message, command, "REJECTED_ARGS");
    if (target.killGraceSeconds > command.killGraceSeconds) return this.reject(message, command, "REJECTED_CONFIG");
    if (target.scriptRoleArn !== undefined && this.deps.credentials === undefined) return this.reject(message, command, "REJECTED_CONFIG");

    const decision = decideAcceptance({
      commandId: command.commandId,
      fencingToken: command.fencingToken,
      issuedAtMs: Date.parse(command.issuedAt),
      notAfterMs: Date.parse(command.notAfter),
      journalEpochMs: this.deps.store.journalEpoch,
      journalHasCommand: false,
      targetState: this.deps.store.getTarget(command.targetId),
      nowMs: this.now(),
      clockOffsetMs: this.deps.clockOffsetMs(),
      clockSkewSeconds: this.deps.config.clockSkewSeconds,
    });
    if (decision.decision === "NOT_STARTED") return this.reject(message, command, decision.reason);
    if (decision.decision === "DUPLICATE") {
      await this.deps.source.delete(message.receiptHandle);
      return;
    }
    // Accepted by the rules: wait for a local slot (the message stays invisible meanwhile).
    this.pending.set(command.commandId, { message, command, target, receivedAt: this.now(), notAfter: Date.parse(command.notAfter) });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Accept and run (§10.3)
  // ---------------------------------------------------------------------------------------------------------------

  private async acceptAndRun(p: Pending): Promise<void> {
    const { command, target, message } = p;
    // Re-check under the slot: the target state may have changed while waiting.
    const recheck = decideAcceptance({
      commandId: command.commandId,
      fencingToken: command.fencingToken,
      issuedAtMs: Date.parse(command.issuedAt),
      notAfterMs: p.notAfter,
      journalEpochMs: this.deps.store.journalEpoch,
      journalHasCommand: this.deps.store.getEntry(command.commandId) !== undefined,
      targetState: this.deps.store.getTarget(command.targetId),
      nowMs: this.now(),
      clockOffsetMs: this.deps.clockOffsetMs(),
      clockSkewSeconds: this.deps.config.clockSkewSeconds,
    });
    if (recheck.decision !== "ACCEPT") {
      this.scheduler.release(target);
      if (recheck.decision === "NOT_STARTED") await this.reject(message, command, recheck.reason);
      else await this.deps.source.delete(message.receiptHandle);
      return;
    }
    const now = this.now();
    // 1. Journal ACCEPTED first, then the target claim (the journal is the source of truth on restart).
    let entry = this.save({
      commandId: command.commandId,
      executionId: command.executionId,
      dispatchToken: command.dispatchToken,
      fencingToken: command.fencingToken,
      targetId: command.targetId,
      scriptId: command.scriptId,
      issuedAt: Date.parse(command.issuedAt),
      notAfter: p.notAfter,
      state: "ACCEPTED",
      acceptedAt: now,
      nextSeq: 1,
      log: { bucket: command.log.bucket, keyPrefix: command.log.keyPrefix, status: "NONE", attempts: 0 },
      command: command as unknown as Record<string, unknown>,
    });
    this.deps.store.putTarget(command.targetId, recheck.nextState);
    this.crash("AFTER_ACCEPTED");
    entry = this.emit(entry, "ACCEPTED", { acceptedAt: new Date(now).toISOString() });
    // 2. The message can go: a redelivery would find the journal entry.
    await this.deps.source.delete(message.receiptHandle);
    this.crash("AFTER_DELETE");
    // 3. STARTING immediately before spawn: from here on, an interruption is LOST, never re-run.
    entry = this.save({ ...entry, state: "STARTING", startingAt: this.now() });
    this.crash("AFTER_STARTING");

    let env: Record<string, string> = { ...(this.deps.baseEnv ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" }) };
    if (target.scriptRoleArn !== undefined && this.deps.credentials !== undefined) {
      try {
        const c = await this.deps.credentials.forScript(target.scriptRoleArn, command.executionId);
        env = { ...env, AWS_ACCESS_KEY_ID: c.accessKeyId, AWS_SECRET_ACCESS_KEY: c.secretAccessKey, AWS_SESSION_TOKEN: c.sessionToken, AWS_REGION: this.deps.config.region };
      } catch (error) {
        // Nothing was spawned: provably not started.
        this.deps.logger.error("script role could not be assumed", { executionId: command.executionId, error: error instanceof Error ? error.message : String(error) });
        this.finishNotStarted(entry, "REJECTED_CONFIG");
        this.scheduler.release(target);
        return;
      }
    }
    const paths = this.deps.store.outputPaths(command.commandId);
    const timeoutSeconds = Math.min(command.timeoutSeconds, target.timeoutSeconds);
    const handle = startScript(
      {
        path: target.path,
        args: command.args,
        ...(target.runAs === undefined ? {} : { runAs: target.runAs }),
        sudoPath: this.deps.config.sudoPath,
        env,
        timeoutMs: timeoutSeconds * 1000,
        killGraceMs: target.killGraceSeconds * 1000,
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        capBytes: this.deps.config.outputCapBytes,
        ...(this.deps.stdioDrainMs === undefined ? {} : { stdioDrainMs: this.deps.stdioDrainMs }),
      },
      this.deps.spawn,
      () => this.now(),
    );
    entry = this.save({ ...entry, state: "STARTED", startedAt: this.now(), pid: handle.pid });
    entry = this.emit(entry, "STARTED", { startedAt: new Date(entry.startedAt as number).toISOString(), ...(handle.pid > 0 ? { pid: handle.pid } : {}) });

    this.handles.set(command.commandId, handle);
    const run = handle.done.then(async (result) => {
      const current = this.deps.store.getEntry(command.commandId) as JournalEntry;
      const logTail = redactString(result.stdoutTail).slice(-4096);
      if (result.stdioHeldOpen || result.leftoverProcesses) {
        // Never signaled by the agent; reported so the script can be fixed (apps belong to Docker, PM2 or systemd).
        this.deps.logger.warn("the script exited but left processes behind (not under a supervisor; the agent will not stop them)", {
          executionId: command.executionId,
          targetId: command.targetId,
          holdsOutput: result.stdioHeldOpen,
          inProcessGroup: result.leftoverProcesses,
        });
      }
      if (result.interrupted || this.interrupted.has(command.commandId)) {
        // Cut short by the agent's shutdown: the target state is unknown (LOST), the partial output is kept.
        const lost = this.save({
          ...current,
          state: "LOST",
          finishedAt: this.now(),
          result: { exitCode: result.exitCode, signal: result.signal, timedOut: false, durationMs: result.durationMs, logTail },
          log: { ...current.log, status: "PENDING" },
        });
        this.emit(lost, "LOST", { startedAt: new Date(current.startedAt ?? current.startingAt ?? this.now()).toISOString() });
        this.deps.store.putTarget(command.targetId, clearActiveCommand(this.deps.store.getTarget(command.targetId), command.commandId));
        this.scheduler.release(target);
        this.logsPending.add(command.commandId);
        await this.flushOutbox();
        await this.uploadLogs(this.deps.store.getEntry(command.commandId) as JournalEntry);
        return;
      }
      let finished = this.save({
        ...current,
        state: "FINISHED",
        finishedAt: this.now(),
        result: {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          ...(result.cicdResult === undefined ? {} : { cicdResult: result.cicdResult }),
          logTail,
        },
        log: { ...current.log, status: "PENDING" },
      });
      finished = this.emit(finished, "FINISHED", {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ...(result.cicdResult === undefined ? {} : { cicdResult: result.cicdResult }),
        logTail,
      });
      this.deps.store.putTarget(command.targetId, clearActiveCommand(this.deps.store.getTarget(command.targetId), command.commandId));
      this.scheduler.release(target);
      this.logsPending.add(command.commandId);
      await this.flushOutbox();
      await this.uploadLogs(finished);
    });
    this.running.set(command.commandId, run);
    void run.finally(() => {
      this.running.delete(command.commandId);
      this.handles.delete(command.commandId);
      this.interrupted.delete(command.commandId);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Queries (§9.3): FIFO order has already delivered any pending copy of the command
  // ---------------------------------------------------------------------------------------------------------------

  private async handleQuery(message: ReceivedCommandMessage, body: unknown): Promise<void> {
    if (this.deps.validators.query(body) !== undefined || !this.senderIsExecutor(message)) {
      this.deps.logger.warn("invalid or unauthorized query dropped", { messageId: message.messageId });
      await this.deps.source.delete(message.receiptHandle);
      return;
    }
    const q = body as { commandId: string; executionId: string; dispatchToken: string; targetId: string; agentId: string; queryNumber: number; commandIssuedAt: string; notAfter: string };
    const existing = this.deps.store.getEntry(q.commandId);
    if (existing !== undefined) {
      // The last journaled phase, with a new seq (so an Executor that missed it applies it).
      this.resendLast(existing);
    } else {
      const now = this.now();
      const verdict = neverSeenVerdict({
        commandIssuedAtMs: Date.parse(q.commandIssuedAt),
        notAfterMs: Date.parse(q.notAfter),
        journalEpochMs: this.deps.store.journalEpoch,
        journalRetentionDays: this.deps.config.journalRetentionDays,
        answeredAtMs: now,
        clockSkewSeconds: this.deps.config.clockSkewSeconds,
      });
      const base = { commandId: q.commandId, executionId: q.executionId, dispatchToken: q.dispatchToken, targetId: q.targetId };
      if (verdict.evidence) {
        // Tombstone: the command can never be accepted later (a late copy is a duplicate) and seq stays monotonic.
        const tombstone = this.save({
          ...base,
          fencingToken: 0,
          scriptId: "",
          issuedAt: Date.parse(q.commandIssuedAt),
          notAfter: Date.parse(q.notAfter),
          state: "NOT_STARTED",
          notStartedReason: "EXPIRED",
          nextSeq: 1,
          log: { bucket: "", keyPrefix: "", status: "NONE", attempts: 0 },
          command: {},
        });
        this.emit(tombstone, "NEVER_SEEN", { journalEpoch: new Date(this.deps.store.journalEpoch).toISOString(), journalRetentionDays: this.deps.config.journalRetentionDays });
      } else {
        this.enqueueEvent(base, NO_RECORD_SEQ_BASE + q.queryNumber, 0, "NO_RECORD", { journalEpoch: new Date(this.deps.store.journalEpoch).toISOString() });
      }
    }
    await this.deps.source.delete(message.receiptHandle);
    await this.flushOutbox();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Events, journal, outbox
  // ---------------------------------------------------------------------------------------------------------------

  private crash(point: CrashPoint): void {
    if (this.deps.crashAt === point) throw new SimulatedCrash(point);
  }

  private save(entry: JournalEntry): JournalEntry {
    this.deps.store.putEntry(entry);
    return entry;
  }

  private enqueueEvent(
    ids: { commandId: string; executionId: string; dispatchToken: string; targetId: string },
    seq: number,
    fencingToken: number,
    phase: string,
    extra: Record<string, unknown>,
  ): void {
    this.deps.store.enqueue({
      commandId: ids.commandId,
      seq,
      groupId: fifo.eventGroup(ids.executionId),
      deduplicationId: fifo.eventDeduplication(ids.commandId, seq),
      body: {
        specVersion: 1,
        type: "AGENT_EVENT",
        phase,
        commandId: ids.commandId,
        executionId: ids.executionId,
        dispatchToken: ids.dispatchToken,
        fencingToken,
        agentId: this.deps.config.agentId,
        targetId: ids.targetId,
        seq,
        sentAt: new Date(this.now()).toISOString(),
        agentVersion: AGENT_VERSION,
        ...extra,
      },
    });
  }

  /** Outbox FIRST, then the journal's seq: a crash in between re-sends the same seq (absorbed), never loses an event. */
  private emit(entry: JournalEntry, phase: string, extra: Record<string, unknown>): JournalEntry {
    const fencing = phase === "NEVER_SEEN" || phase === "NO_RECORD" ? 0 : entry.fencingToken;
    this.enqueueEvent(entry, entry.nextSeq, fencing, phase, extra);
    return this.save({ ...entry, nextSeq: entry.nextSeq + 1 });
  }

  private resendLast(entry: JournalEntry): void {
    switch (entry.state) {
      case "FINISHED":
        if (entry.result !== undefined) this.emit(entry, "FINISHED", { ...entry.result, logTail: entry.result.logTail ?? "" });
        return;
      case "NOT_STARTED":
        if (entry.fencingToken === 0) this.emit(entry, "NEVER_SEEN", { journalEpoch: new Date(this.deps.store.journalEpoch).toISOString(), journalRetentionDays: this.deps.config.journalRetentionDays });
        else this.emit(entry, "NOT_STARTED", { reason: entry.notStartedReason ?? "EXPIRED" });
        return;
      case "LOST":
        this.emit(entry, "LOST", { startedAt: new Date(entry.startedAt ?? entry.startingAt ?? entry.acceptedAt ?? this.now()).toISOString() });
        return;
      case "STARTED":
      case "STARTING":
        this.emit(entry, "STARTED", { startedAt: new Date(entry.startedAt ?? entry.startingAt ?? this.now()).toISOString() });
        return;
      case "ACCEPTED":
        this.emit(entry, "ACCEPTED", { acceptedAt: new Date(entry.acceptedAt ?? this.now()).toISOString() });
        return;
    }
  }

  private finishNotStarted(entry: JournalEntry, reason: NotStartedReason): void {
    const done = this.save({ ...entry, state: "NOT_STARTED", notStartedReason: reason, finishedAt: this.now() });
    this.emit(done, "NOT_STARTED", { reason });
    this.deps.store.putTarget(entry.targetId, clearActiveCommand(this.deps.store.getTarget(entry.targetId), entry.commandId));
  }

  /** Refusal before any acceptance: journaled (a redelivery is a duplicate), event queued, message deleted. */
  private async reject(message: ReceivedCommandMessage, command: Command, reason: NotStartedReason): Promise<void> {
    if (this.deps.store.getEntry(command.commandId) === undefined) {
      const entry = this.save({
        commandId: command.commandId,
        executionId: command.executionId,
        dispatchToken: command.dispatchToken,
        fencingToken: command.fencingToken,
        targetId: command.targetId,
        scriptId: typeof command.scriptId === "string" ? command.scriptId : "",
        issuedAt: Date.parse(command.issuedAt) || this.now(),
        notAfter: Date.parse(command.notAfter) || this.now(),
        state: "NOT_STARTED",
        notStartedReason: reason,
        nextSeq: 1,
        log: { bucket: "", keyPrefix: "", status: "NONE", attempts: 0 },
        command: {},
      });
      this.emit(entry, "NOT_STARTED", { reason });
    }
    this.deps.logger.warn("command not started", { executionId: command.executionId, reason });
    await this.deps.source.delete(message.receiptHandle);
  }

  /** Sends pending events in seq order per command; stops a command's stream at its first failure (order kept). */
  public async flushOutbox(): Promise<void> {
    const blocked = new Set<string>();
    for (const item of this.deps.store.pending()) {
      if (blocked.has(item.commandId)) continue;
      try {
        await this.deps.sink.send({ body: item.body, groupId: item.groupId, deduplicationId: item.deduplicationId });
        this.deps.store.sent(item);
      } catch {
        blocked.add(item.commandId); // connectivity: keep it, keep the order, retry later
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Logs (§12): redacted, gzipped, private; never delays FINISHED; retried until 24 h
  // ---------------------------------------------------------------------------------------------------------------

  private async uploadLogs(entry: JournalEntry): Promise<void> {
    if (entry.log.status !== "PENDING" || entry.log.bucket === "") {
      this.logsPending.delete(entry.commandId);
      return;
    }
    const now = this.now();
    const first = entry.log.firstAttemptAt ?? now;
    const paths = this.deps.store.outputPaths(entry.commandId);
    const read = (p: string): string => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    };
    const meta = {
      agentId: this.deps.config.agentId,
      agentVersion: AGENT_VERSION,
      executionId: entry.executionId,
      dispatchToken: entry.dispatchToken,
      targetId: entry.targetId,
      scriptId: entry.scriptId,
      commit: entry.command["commit"],
      requestId: entry.command["requestId"],
      state: entry.state,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      result: entry.result === undefined ? undefined : { exitCode: entry.result.exitCode, signal: entry.result.signal, timedOut: entry.result.timedOut, durationMs: entry.result.durationMs, cicdResult: entry.result.cicdResult },
    };
    const files = [
      { name: "stdout.log.gz", body: gzipSync(Buffer.from(redactString(read(paths.stdout)))), type: "text/plain", encoding: "gzip" },
      { name: "stderr.log.gz", body: gzipSync(Buffer.from(redactString(read(paths.stderr)))), type: "text/plain", encoding: "gzip" },
      { name: "meta.json", body: Buffer.from(JSON.stringify(meta)), type: "application/json", encoding: undefined },
    ];
    try {
      let bytes = 0;
      const hash = createHash("sha256");
      for (const f of files) {
        await this.deps.logs.put({ bucket: entry.log.bucket, key: `${entry.log.keyPrefix}${f.name}`, body: f.body, contentType: f.type, ...(f.encoding === undefined ? {} : { contentEncoding: f.encoding }) });
        bytes += f.body.length;
        hash.update(f.body);
      }
      const uploaded = this.save({ ...entry, log: { ...entry.log, status: "UPLOADED", attempts: entry.log.attempts + 1, firstAttemptAt: first, key: `${entry.log.keyPrefix}stdout.log.gz`, bytes, sha256: hash.digest("hex") } });
      this.emit(uploaded, "LOG_UPLOADED", { log: { status: "UPLOADED", key: uploaded.log.key, bytes, sha256: uploaded.log.sha256 } });
      this.logsPending.delete(entry.commandId);
    } catch (error) {
      const attempts = entry.log.attempts + 1;
      if (now - first >= LOG_UPLOAD_GIVE_UP_MS) {
        const failed = this.save({ ...entry, log: { ...entry.log, status: "FAILED", attempts, firstAttemptAt: first } });
        this.emit(failed, "LOG_UPLOADED", { log: { status: "FAILED" } });
        this.logsPending.delete(entry.commandId);
        this.deps.logger.error("log upload given up after 24 h; the local copy is kept", { executionId: entry.executionId });
      } else {
        this.save({ ...entry, log: { ...entry.log, attempts, firstAttemptAt: first } });
        this.deps.logger.warn("log upload failed; it will be retried", { executionId: entry.executionId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.flushOutbox();
  }

  public async retryLogUploads(): Promise<void> {
    for (const commandId of [...this.logsPending]) {
      if (this.running.has(commandId)) continue;
      const entry = this.deps.store.getEntry(commandId);
      if (entry === undefined) this.logsPending.delete(commandId);
      else if (TERMINAL.has(entry.state)) await this.uploadLogs(entry);
    }
  }
}

export { AGENT_PROTOCOL_DEFAULTS };
