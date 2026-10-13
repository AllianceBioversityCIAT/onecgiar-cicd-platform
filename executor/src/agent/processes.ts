// @akili-spec changes/cicd-executor-poc architecture-change-04 §10.5, §23
// Supervisor-independent process checks of the agent (no systemd, PM2 or cgroup needed).
//
// A deploy script runs as the leader of its own process group (pgid = pid of the spawned `sudo` or script). If the
// agent process dies abruptly (SIGKILL, OOM, crash), nothing else stops that script. The next agent process therefore
// recognizes a script of its predecessor that is STILL RUNNING and stops it before it accepts any command:
//   - identity: the journaled pid must be alive AND have started inside the journaled spawn window, so a recycled pid
//     (an unrelated process, an application) is never signaled;
//   - only while the group LEADER (sudo / the script) still runs: once the script itself exited, whatever stayed in
//     its group is left alone (it is what the deploy started; the agent never signals after a script exited).
// Start times come from /proc (Linux). Elsewhere nothing can be verified, so nothing is signaled.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcessInspector {
  /** Start time (epoch ms, about 10 ms resolution) of a live process; undefined when gone or not verifiable. */
  startTimeMs(pid: number): number | undefined;
  /** Signals every process of a group the agent may signal (EPERM/ESRCH ignored). */
  signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

/** Linux: /proc/<pid>/stat field 22 (start time in clock ticks since boot, USER_HZ = 100) plus /proc/stat `btime`. */
export function createProcfsInspector(procRoot = "/proc"): ProcessInspector {
  let bootMs: number | undefined;
  const boot = (): number => {
    bootMs ??= Number(/^btime (\d+)$/m.exec(readFileSync(join(procRoot, "stat"), "utf8"))?.[1]) * 1000;
    return bootMs;
  };
  return {
    startTimeMs(pid) {
      try {
        const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
        // The command name may contain spaces or parentheses: fields are counted after its closing ")".
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[0] === "Z") return undefined; // a zombie is already gone
        const ticks = Number(fields[19]);
        const start = boot() + ticks * 10;
        return Number.isFinite(start) ? start : undefined;
      } catch {
        return undefined;
      }
    },
    signalGroup(pgid, signal) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // Gone, or not ours to signal.
      }
    },
  };
}

/** Where start times cannot be read: never signals (an unverifiable pid may belong to anything). */
export const UNVERIFIABLE_PROCESSES: ProcessInspector = {
  startTimeMs: () => undefined,
  signalGroup: () => undefined,
};

export function defaultProcessInspector(): ProcessInspector {
  return process.platform === "linux" ? createProcfsInspector() : UNVERIFIABLE_PROCESSES;
}

/** POSIX: true while any process (also another user's) is still in the process group. Always false on Windows. */
export function processGroupAlive(pgid: number): boolean {
  if (process.platform === "win32" || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
