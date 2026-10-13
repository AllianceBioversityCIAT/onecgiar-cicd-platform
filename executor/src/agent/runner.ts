// @akili-spec changes/cicd-executor-poc architecture-change-04 §10.5, §10.7, §12
// Runs ONE catalog script: `sudo -n [--preserve-env=<keys>] -u <deploy user> -- <path> <args...>` with no shell, an
// environment allowlist and its own process group. stdout/stderr go to 0600 files capped at `capBytes` (truncation
// marked); the last part of stdout stays in memory for CICD_RESULT and the log tail. Timeout: SIGTERM to the whole
// group, SIGKILL after the kill grace.
// The run ends when the SCRIPT process exits, not when its output pipes close: a deploy hands the application to its
// own supervisor (Docker, a PM2 daemon, a systemd unit of the application) and ends. If something it left behind still
// holds the pipes, the agent stops reading after `stdioDrainMs` (flagged `stdioHeldOpen`) and never signals the
// process group after the script exited, so an application process is never killed by the agent.
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { parseCicdResult } from "../adapters/ssh-deployer/cicd-result.js";
import { processGroupAlive } from "./processes.js";
import type { CicdResult } from "../ports/deploy-transport.js";

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface RunRequest {
  readonly path: string;
  readonly args: readonly string[];
  readonly runAs?: string;
  readonly sudoPath: string;
  /** Exactly the variables the script may see (allowlist + its script-role credentials). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly capBytes: number;
  /** How long to keep reading the pipes after the script exited (output still in flight). */
  readonly stdioDrainMs?: number;
}

export interface RunResult {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly cicdResult?: CicdResult;
  /** Last 4 KB of stdout, NOT yet redacted (the caller redacts). */
  readonly stdoutTail: string;
  /** A process left behind by the script still held its stdout/stderr when the agent stopped reading. */
  readonly stdioHeldOpen: boolean;
  /** POSIX: processes the script started are still in its process group after it exited (never signaled). */
  readonly leftoverProcesses: boolean;
  /** Ended by `interrupt()` (agent shutdown past its grace), not by itself or its timeout. */
  readonly interrupted: boolean;
}

export interface RunHandle {
  readonly pid: number;
  readonly done: Promise<RunResult>;
  /** Shutdown past the grace: SIGTERM to the group, SIGKILL after the kill grace (no-op once the script exited). */
  interrupt(): void;
}

const TAIL_BYTES = 64 * 1024;
const STDIO_DRAIN_MS = 5000;
const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

/**
 * Kills the whole process group (POSIX) or process tree (Windows, local tests only). Without `afterExit` it does nothing
 * once the script exited; `afterExit` is only used by the SIGKILL of a timeout or an interruption that already started.
 */
export function killTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL", afterExit = false): void {
  if (child.pid === undefined) return;
  if (!afterExit && (child.exitCode !== null || child.signalCode !== null)) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone.
  }
}

/** Output file capped at `capBytes`; `write` returns false while the file stream is saturated (the caller pauses). */
function capped(path: string, capBytes: number): { stream: WriteStream; write(chunk: Buffer): boolean; truncated(): boolean } {
  const stream = createWriteStream(path, { mode: 0o600 });
  let written = 0;
  let cut = false;
  return {
    stream,
    write(chunk: Buffer) {
      if (written >= capBytes) {
        cut = true;
        return true;
      }
      const room = capBytes - written;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) cut = true;
      written += part.length;
      return stream.write(part);
    },
    truncated: () => cut,
  };
}

export function startScript(request: RunRequest, spawnFn: SpawnFn = nodeSpawn as SpawnFn, now: () => number = Date.now): RunHandle {
  const command = request.runAs === undefined ? request.path : request.sudoPath;
  const preserve = Object.keys(request.env).filter((k) => k.startsWith("AWS_"));
  const args =
    request.runAs === undefined
      ? [...request.args]
      : ["-n", ...(preserve.length > 0 ? [`--preserve-env=${preserve.join(",")}`] : []), "-u", request.runAs, "--", request.path, ...request.args];
  const started = now();
  const child = spawnFn(command, args, {
    shell: false,
    detached: process.platform !== "win32",
    env: { ...request.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = capped(request.stdoutPath, request.capBytes);
  const err = capped(request.stderrPath, request.capBytes);
  // The last TAIL_BYTES of stdout as a list of chunks (joined once at the end, never per chunk).
  const tailChunks: Buffer[] = [];
  let tailBytes = 0;
  const keepTail = (chunk: Buffer): void => {
    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailChunks.length > 1 && tailBytes - (tailChunks[0] as Buffer).length >= TAIL_BYTES) tailBytes -= (tailChunks.shift() as Buffer).length;
  };
  // Backpressure: a saturated output file pauses the pipe instead of buffering in the agent's memory.
  const pipe = (source: NodeJS.ReadableStream | null, sink: ReturnType<typeof capped>, onChunk?: (chunk: Buffer) => void): void => {
    source?.on("data", (chunk: Buffer) => {
      onChunk?.(chunk);
      if (!sink.write(chunk)) {
        source.pause();
        sink.stream.once("drain", () => source.resume());
      }
    });
  };
  pipe(child.stdout, out, keepTail);
  pipe(child.stderr, err);

  let timedOut = false;
  let interrupted = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    if (killTimer !== undefined) return;
    killTree(child, "SIGTERM");
    // The group SIGKILL follows even if the script itself exits first: what it started for this run goes too.
    killTimer = setTimeout(() => killTree(child, "SIGKILL", true), request.killGraceMs);
    killTimer.unref();
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);

  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      const ended = (stream: NodeJS.ReadableStream | null): Promise<boolean> =>
        stream === null || (stream as { readableEnded?: boolean }).readableEnded === true
          ? Promise.resolve(true)
          : new Promise((r) => {
              stream.once("end", () => r(true));
              stream.once("close", () => r(true));
            });
      let drainTimer: NodeJS.Timeout | undefined;
      const drained = Promise.race([
        Promise.all([ended(child.stdout), ended(child.stderr)]).then(() => true),
        new Promise<boolean>((r) => {
          drainTimer = setTimeout(() => r(false), request.stdioDrainMs ?? STDIO_DRAIN_MS);
        }),
      ]);
      const close = (s: WriteStream): Promise<void> => new Promise((r) => s.end(() => r()));
      void drained.then(async (complete) => {
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        // Stop reading only; our pipe ends close, nothing is signaled.
        if (!complete) for (const s of [child.stdout, child.stderr]) s?.destroy();
        await Promise.all([close(out.stream), close(err.stream)]);
        const joined = Buffer.concat(tailChunks);
        const stdoutTail = joined.subarray(Math.max(0, joined.length - TAIL_BYTES)).toString("utf8");
        const cicdResult = parseCicdResult(stdoutTail, out.truncated());
        const exitCode = code ?? (signal !== null ? SIGNAL_EXIT[signal] ?? 255 : 255);
        resolve({
          exitCode: Math.min(Math.max(exitCode, 0), 255),
          signal: signal ?? null,
          timedOut,
          durationMs: now() - started,
          stdoutTruncated: out.truncated(),
          stderrTruncated: err.truncated(),
          ...(cicdResult === undefined ? {} : { cicdResult }),
          stdoutTail: stdoutTail.slice(-4096),
          stdioHeldOpen: !complete,
          leftoverProcesses: child.pid !== undefined && processGroupAlive(child.pid),
          interrupted,
        });
      });
    };
    child.on("exit", finish);
    child.on("error", () => finish(255, null));
  });
  return {
    pid: child.pid ?? -1,
    done,
    interrupt() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      interrupted = true;
      terminate();
    },
  };
}
