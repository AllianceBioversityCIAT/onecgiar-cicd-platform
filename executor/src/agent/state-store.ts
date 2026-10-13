// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §10.3, §10.4, §10.5
// The agent's durable state under `stateDir` (0700): the journal (one file per command), the per-target state
// (highest fencing token, active command), the event outbox (one file per pending event) and the captured output.
// Every write is atomic: temporary file, fsync, rename (a crash leaves the old or the new file, never a torn one).
// The journal epoch is created once, at the first start: a recreated state directory gets a NEW epoch, so it can never
// prove anything about commands issued before it (NEVER_SEEN rule, PREDATES_JOURNAL).
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CicdResult } from "../ports/deploy-transport.js";
import type { AgentTargetState, NotStartedReason } from "../domain/agent-protocol/index.js";

export type JournalState = "ACCEPTED" | "STARTING" | "STARTED" | "FINISHED" | "NOT_STARTED" | "LOST";

export interface JournalResult {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly cicdResult?: CicdResult;
  readonly logTail?: string;
}

export interface JournalLog {
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly status: "PENDING" | "UPLOADED" | "FAILED" | "NONE";
  readonly firstAttemptAt?: number;
  readonly attempts: number;
  readonly key?: string;
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface JournalEntry {
  readonly commandId: string;
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly fencingToken: number;
  readonly targetId: string;
  readonly scriptId: string;
  readonly issuedAt: number;
  readonly notAfter: number;
  readonly state: JournalState;
  readonly acceptedAt?: number;
  readonly startingAt?: number;
  readonly startedAt?: number;
  readonly pid?: number;
  readonly finishedAt?: number;
  readonly result?: JournalResult;
  readonly notStartedReason?: NotStartedReason;
  /** Next event sequence number of this command (persisted: seq is monotonic across restarts). */
  readonly nextSeq: number;
  readonly log: JournalLog;
  /** The command as received (schema-valid), for the log metadata. */
  readonly command: Readonly<Record<string, unknown>>;
}

export interface OutboxItem {
  readonly commandId: string;
  readonly seq: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly groupId: string;
  readonly deduplicationId: string;
}

const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${String(process.pid)}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export class AgentStateStore {
  private readonly journalDir: string;
  private readonly targetsDir: string;
  private readonly outboxDir: string;
  private readonly outputDir: string;
  public readonly journalEpoch: number;

  public constructor(
    private readonly stateDir: string,
    now: number,
  ) {
    this.journalDir = join(stateDir, "journal");
    this.targetsDir = join(stateDir, "targets");
    this.outboxDir = join(stateDir, "outbox");
    this.outputDir = join(stateDir, "output");
    for (const dir of [stateDir, this.journalDir, this.targetsDir, this.outboxDir, this.outputDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const metaPath = join(stateDir, "meta.json");
    const meta = readJson<{ journalEpoch: number }>(metaPath);
    if (meta === undefined || !Number.isInteger(meta.journalEpoch)) {
      writeAtomic(metaPath, JSON.stringify({ journalEpoch: now }));
      this.journalEpoch = now;
    } else {
      this.journalEpoch = meta.journalEpoch;
    }
  }

  // ---- journal
  public getEntry(commandId: string): JournalEntry | undefined {
    return readJson<JournalEntry>(join(this.journalDir, `${safe(commandId)}.json`));
  }

  public putEntry(entry: JournalEntry): void {
    writeAtomic(join(this.journalDir, `${safe(entry.commandId)}.json`), JSON.stringify(entry));
  }

  public entries(): JournalEntry[] {
    return readdirSync(this.journalDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<JournalEntry>(join(this.journalDir, name)))
      .filter((e): e is JournalEntry => e !== undefined);
  }

  /** Removes closed entries older than the retention (their outbox and logs are done). */
  public prune(now: number, retentionDays: number, isClosed: (e: JournalEntry) => boolean): void {
    const limit = now - retentionDays * 86_400_000;
    for (const entry of this.entries()) {
      if (entry.issuedAt < limit && isClosed(entry)) {
        rmSync(join(this.journalDir, `${safe(entry.commandId)}.json`), { force: true });
        rmSync(join(this.outputDir, safe(entry.commandId)), { recursive: true, force: true });
      }
    }
  }

  // ---- target state (derived from the journal at start, persisted on every change)
  public getTarget(targetId: string): AgentTargetState {
    return readJson<AgentTargetState>(join(this.targetsDir, `${safe(targetId)}.json`)) ?? {};
  }

  public putTarget(targetId: string, state: AgentTargetState): void {
    writeAtomic(join(this.targetsDir, `${safe(targetId)}.json`), JSON.stringify(state));
  }

  // ---- outbox (one file per event; per command, sent in seq order)
  public enqueue(item: OutboxItem): void {
    writeAtomic(join(this.outboxDir, `${safe(item.commandId)}__${String(item.seq).padStart(6, "0")}.json`), JSON.stringify(item));
  }

  public pending(): OutboxItem[] {
    return readdirSync(this.outboxDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readJson<OutboxItem>(join(this.outboxDir, name)))
      .filter((i): i is OutboxItem => i !== undefined);
  }

  public sent(item: OutboxItem): void {
    rmSync(join(this.outboxDir, `${safe(item.commandId)}__${String(item.seq).padStart(6, "0")}.json`), { force: true });
  }

  // ---- captured output
  public outputPaths(commandId: string): { readonly dir: string; readonly stdout: string; readonly stderr: string } {
    const dir = join(this.outputDir, safe(commandId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { dir, stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") };
  }

  public outputExists(commandId: string): boolean {
    const dir = join(this.outputDir, safe(commandId));
    return existsSync(dir) && statSync(dir).isDirectory();
  }
}
