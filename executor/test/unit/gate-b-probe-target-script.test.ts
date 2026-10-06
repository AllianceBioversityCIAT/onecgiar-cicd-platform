// @akili-spec changes/cicd-executor-poc gate-b-plan K-7 (D-5), design §6.5
// The owner-run, read-only target probe script: syntax, static safety rules and the CICD_RESULT line it emits.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCicdResult } from "../../src/adapters/ssh-deployer/cicd-result.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeDir = path.resolve(here, "..", "..", "..", "tools", "gate-b", "probe");
const SCRIPT = "target-probe.sh";
const scriptText = readFileSync(path.join(probeDir, SCRIPT), "utf8");

/** Runs bash with the probe directory as cwd and a relative script name (no Windows/WSL path translation). */
function bash(args: string[]): { status: number | null; stdout: string; stderr: string } | undefined {
  const version = spawnSync("bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" });
  if (version.error !== undefined || version.status !== 0 || version.stdout.trim() === "") return undefined;
  const r = spawnSync("bash", args, { cwd: probeDir, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const codeLines = scriptText
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"));
const code = codeLines.join("\n");

describe("target-probe.sh static rules (read-only probe)", () => {
  it("passes bash -n", (ctx) => {
    const r = bash(["-n", SCRIPT]);
    if (r === undefined) return ctx.skip(); // no usable bash on this machine
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("uses strict mode and a shebang", () => {
    expect(scriptText.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(code).toMatch(/^set -euo pipefail$/m);
  });

  it("never pulls, runs, stops, removes or execs containers, and only calls `docker --version`", () => {
    expect(code).not.toMatch(/docker\s+(run|pull|rm|stop|exec|start|kill|build|compose|system|image|container|volume|network)\b/);
    const uses = [...code.matchAll(/(command -v )?\bdocker\b( --version)?/g)].map((m) => m[0]);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(["command -v docker", "docker --version"]).toContain(use);
  });

  it("has no rm -rf, no sudo and no package or service management", () => {
    expect(code).not.toMatch(/rm\s+-[a-zA-Z]*r/);
    expect(code).not.toMatch(/\bsudo\b|\bsu\s|\bapt(-get)?\b|\byum\b|\bsystemctl\b|\bchmod\b|\bchown\b|\bmkdir\b|\btouch\b/);
  });

  it("removes only the probe lock file", () => {
    const rms = code.match(/\brm\b[^\n]*/g) ?? [];
    expect(rms).toEqual(['rm -f -- "$probe_lock"']);
  });

  it("writes only to the probe lock file (every redirection target is the lock, /dev/null or a file descriptor)", () => {
    const allowed = new Set(['"$probe_lock"', "/dev/null", "&1", "&2"]);
    for (const line of codeLines) {
      if (/^(printf|report)\b/.test(line)) continue; // quoted output text, not redirections
      for (const m of line.matchAll(/\d*>>?\s*(\S+)/g)) {
        expect(allowed.has(m[1]!.replace(/[);]+$/, ""))).toBe(true);
      }
    }
    expect(code).not.toMatch(/\btee\b/);
    // append redirection (never truncate) only to the probe lock
    for (const m of code.matchAll(/>>\s*(\S+)/g)) expect(m[1]!.replace(/[);]+$/, "")).toBe('"$probe_lock"');
  });

  it("does not reference the production deploy script or other scripts", () => {
    expect(code).not.toMatch(/deploy-container|deploy-scripts|\bcurl\b|\bwget\b|\bssh\b|\bscp\b/);
  });

  it("is not in the production deployScript enum", () => {
    const schema = JSON.parse(readFileSync(path.resolve(probeDir, "..", "..", "..", "schemas", "deployment.schema.json"), "utf8")) as {
      properties: { deployScript: { enum: string[] } };
    };
    expect(schema.properties.deployScript.enum).not.toContain(SCRIPT);
  });
});

describe("target-probe.sh CICD_RESULT line", () => {
  it("both documented result lines are accepted by parseCicdResult", () => {
    expect(parseCicdResult('probe.x=y\nCICD_RESULT {"status":"PROBE_OK","healthy":true}\n')).toEqual({ status: "PROBE_OK", healthy: true });
    expect(parseCicdResult('CICD_RESULT {"status":"PROBE_FAILED","healthy":false}\n')).toEqual({ status: "PROBE_FAILED", healthy: false });
    // the script's literal result lines are exactly these two
    expect(scriptText).toContain(`printf 'CICD_RESULT {"status":"PROBE_OK","healthy":true}\\n'`);
    expect(scriptText).toContain(`printf 'CICD_RESULT {"status":"PROBE_FAILED","healthy":false}\\n'`);
  });

  it("running it locally emits exactly one CICD_RESULT line, last, parsed by parseCicdResult", (ctx) => {
    const r = bash([SCRIPT]);
    if (r === undefined) return ctx.skip(); // no usable bash on this machine
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    expect(lines.filter((l) => l.startsWith("CICD_RESULT "))).toHaveLength(1);
    expect(lines[lines.length - 1]!.startsWith("CICD_RESULT ")).toBe(true);
    const result = parseCicdResult(r.stdout);
    expect(result).toBeDefined();
    // Where `flock` exists the whole probe runs; where it does not (e.g. Git Bash) the probe must say so and fail.
    if (r.stdout.includes("probe.flock_present=yes")) {
      expect(result?.status).toBe(r.stdout.includes("probe.docker_cli_present=yes") ? "PROBE_OK" : "PROBE_FAILED");
      expect(r.stdout).toContain("probe.flock_contention=busy");
      expect(r.stdout).toContain("probe.flock_release=free");
    } else {
      expect(result?.status).toBe("PROBE_FAILED");
      expect(r.stdout).toContain("probe.failed_checks=");
      expect(r.status).toBe(10);
    }
  });
});

describe("target-probe.sh lock path safety", () => {
  it("statically refuses a symlink or non-regular lock path, creates with noclobber and opens in append mode", () => {
    expect(code).toMatch(/\[ -L "\$probe_lock" \]/);
    expect(code).toMatch(/\[ ! -f "\$probe_lock" \]/);
    expect(code).toMatch(/set -o noclobber/);
    expect(code).toContain("lock_path_unsafe");
    expect(code).toContain("open_failed");
    expect(code).not.toMatch(/\d>\s*"\$probe_lock"/); // never a truncating open (only `>>`; the noclobber create uses `: >`)
  });

  function runWithLockPath(prepare: (dir: string) => boolean): { status: number | null; stdout: string; left: boolean } | undefined {
    const probe = bash(["-n", SCRIPT]);
    if (probe === undefined) return undefined;
    const scratch = mkdtempSync(path.join(here, "..", "..", "node_modules", ".gate-b-probe-lock-"));
    try {
      if (!prepare(scratch)) return undefined;
      const rel = path.relative(scratch, path.join(probeDir, SCRIPT)).split(path.sep).join("/");
      const r = spawnSync("bash", [rel], { cwd: scratch, encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: "." } });
      return { status: r.status, stdout: r.stdout, left: existsSync(path.join(scratch, "cicd-probe.lock")) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("a lock path that is a directory (not a regular file) fails with lock_path_unsafe and is left untouched", (ctx) => {
    const r = runWithLockPath((dir) => (mkdirSync(path.join(dir, "cicd-probe.lock")), true));
    if (r === undefined) return ctx.skip();
    expect(r.stdout).toContain("lock_path_unsafe");
    expect(parseCicdResult(r.stdout)?.status).toBe("PROBE_FAILED");
    expect(r.status).toBe(10);
    expect(r.left).toBe(true);
  });

  it("a symlinked lock path fails with lock_path_unsafe (skipped where the OS cannot create a real symlink)", (ctx) => {
    const r = runWithLockPath((dir) => {
      try {
        writeFileSync(path.join(dir, "target"), "x");
        symlinkSync("target", path.join(dir, "cicd-probe.lock"));
        return lstatSync(path.join(dir, "cicd-probe.lock")).isSymbolicLink();
      } catch {
        return false;
      }
    });
    if (r === undefined) return ctx.skip();
    expect(r.stdout).toContain("lock_path_unsafe");
    expect(parseCicdResult(r.stdout)?.status).toBe("PROBE_FAILED");
  });
});
