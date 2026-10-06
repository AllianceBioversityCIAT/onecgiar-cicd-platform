// @akili-spec changes/cicd-executor-poc gate-b-plan K-6
// The owner-run launcher scripts, exercised with a FAKE node. The real Executor is never started.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(here, "..", "..", "..", "tools", "gate-b");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "run-executor-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const bashOk = (() => {
  const r = spawnSync("bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" });
  return r.error === undefined && r.status === 0 && r.stdout.trim() !== "";
})();

/** POSIX form of a path (C:\x -> /c/x when running Git Bash on Windows). */
function posix(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}` : p.replace(/\\/g, "/");
}

let counter = 0;
interface Fixture {
  dir: string;
  execDir: string;
  node: string;
  envFile: string;
  record: string;
  envDump: string;
  marker: string;
}
function fixture(opts: { version: string; env: string | Buffer; withDist?: boolean; waitForSignal?: boolean }): Fixture {
  const dir = path.join(tmpRoot, `f${counter++}`);
  const execDir = path.join(dir, "executor");
  mkdirSync(execDir, { recursive: true });
  if (opts.withDist !== false) {
    mkdirSync(path.join(execDir, "dist", "src", "main"), { recursive: true });
    writeFileSync(path.join(execDir, "dist", "src", "main", "index.js"), "// fake\n");
  }
  const record = path.join(dir, "node-calls.txt");
  const envDump = path.join(dir, "node-env.txt");
  const marker = path.join(dir, "term-marker.txt");
  const node = path.join(dir, "fake-node.sh");
  // Fake node: --version prints the version; otherwise records args, dumps only CICD_*/AWS_* env keys and, when asked, waits for SIGTERM.
  const wait = opts.waitForSignal
    ? `trap 'echo TERM > "${posix(marker)}"; exit 0' TERM\necho ready > "${posix(path.join(dir, "ready.txt"))}"\nsleep 30 >/dev/null 2>&1 &\nwait $!\n`
    : "";
  writeFileSync(
    node,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo ${opts.version}; exit 0; fi\necho "$@" >> "${posix(record)}"\nenv | grep -E '^(CICD_|AWS_)' | sort > "${posix(envDump)}"\n${wait}exit 0\n`,
  );
  chmodSync(node, 0o755);
  const envFile = path.join(dir, "executor.env");
  writeFileSync(envFile, opts.env);
  return { dir, execDir, node, envFile, record, envDump, marker };
}

function runSh(f: Fixture, extra: string[] = [], env?: NodeJS.ProcessEnv) {
  return spawnSync(
    "bash",
    [
      posix(path.join(toolsDir, "run-executor.sh")),
      "--env-file", posix(f.envFile),
      "--node", posix(f.node),
      "--executor-dir", posix(f.execDir),
      ...extra,
    ],
    { encoding: "utf8", timeout: 60_000, ...(env === undefined ? {} : { env }) },
  );
}

const GOOD_ENV = [
  "# comment",
  "",
  "AWS_PROFILE=<EXECUTOR_PROFILE_NAME>",
  "AWS_REGION=<AWS_REGION>",
  'CICD_TABLE_NAME="<EXECUTIONS_TABLE_NAME>"',
  "CICD_QUEUE_URL=https://fake.invalid/secret-looking-queue",
].join("\n");

describe.skipIf(!bashOk)("run-executor.sh", { timeout: 30_000 }, () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", posix(path.join(toolsDir, "run-executor.sh"))], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("dry run prints the command and redacted env, and never starts the main script", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV });
    const r = runSh(f, ["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("v22.11.0");
    expect(r.stdout).toContain("command:");
    expect(r.stdout).toContain("dist/src/main/index.js");
    expect(r.stdout).toContain("AWS_REGION=<set>");
    expect(r.stdout).toContain("CICD_TABLE_NAME=<set>");
    expect(r.stdout).not.toContain("secret-looking-queue");
    expect(r.stdout).not.toContain("<EXECUTIONS_TABLE_NAME>");
    expect(existsSync(f.record)).toBe(false);
  });

  it("refuses Node 20 with exit 2", () => {
    const f = fixture({ version: "v20.19.5", env: GOOD_ENV });
    const r = runSh(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Node major 22 is required");
    expect(existsSync(f.record)).toBe(false);
  });

  it.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])("refuses a static key (%s) in the env file", (key) => {
    const f = fixture({ version: "v22.11.0", env: `${GOOD_ENV}\n${key}=fake\n` });
    const r = runSh(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(key);
    expect(existsSync(f.record)).toBe(false);
  });

  it("refuses CICD_DYNAMODB_ENDPOINT unless explicitly allowed", () => {
    const f = fixture({ version: "v22.11.0", env: `${GOOD_ENV}\nCICD_DYNAMODB_ENDPOINT=http://localhost:8000\n` });
    const refused = runSh(f);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("CICD_DYNAMODB_ENDPOINT");
    const allowed = runSh(f, ["--allow-local-endpoint", "--dry-run"]);
    expect(allowed.status).toBe(0);
  });

  it("refuses when dist/src/main/index.js is missing", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV, withDist: false });
    const r = runSh(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("npm ci && npm run build");
  });

  it("runs the main script through the selected node and delivers the env to the child", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV });
    const r = runSh(f);
    expect(r.status).toBe(0);
    expect(readFileSync(f.record, "utf8").trim()).toBe("dist/src/main/index.js");
    const dump = readFileSync(f.envDump, "utf8");
    expect(dump).toContain("AWS_PROFILE=<EXECUTOR_PROFILE_NAME>");
    expect(dump).toContain("CICD_TABLE_NAME=<EXECUTIONS_TABLE_NAME>");
  });

  it("passes values literally: command substitution, backticks and '=' inside a value, with CRLF line endings", () => {
    const env = ["AWS_PROFILE=<P>", "CICD_A=$(echo x)", "CICD_B=`echo y`", "CICD_C=a=b=c", "CICD_D='quoted value'"].join("\r\n") + "\r\n";
    const f = fixture({ version: "v22.11.0", env });
    const r = runSh(f);
    expect(r.status).toBe(0);
    const dump = readFileSync(f.envDump, "utf8").split("\n");
    expect(dump).toContain("CICD_A=$(echo x)");
    expect(dump).toContain("CICD_B=`echo y`");
    expect(dump).toContain("CICD_C=a=b=c");
    expect(dump).toContain("CICD_D=quoted value");
    expect(dump).toContain("AWS_PROFILE=<P>");
  });

  it("strips a leading UTF-8 BOM from the first env line", () => {
    const f = fixture({ version: "v22.11.0", env: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("AWS_PROFILE=<P>\nCICD_A=1\n")]) });
    const r = runSh(f);
    expect(r.status).toBe(0);
    expect(readFileSync(f.envDump, "utf8")).toContain("AWS_PROFILE=<P>");
  });

  it("refuses when AWS_PROFILE is missing or empty", () => {
    for (const env of ["CICD_A=1\n", "AWS_PROFILE=\nCICD_A=1\n"]) {
      const f = fixture({ version: "v22.11.0", env });
      const r = runSh(f);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("AWS_PROFILE");
      expect(existsSync(f.record)).toBe(false);
    }
  });

  it("removes inherited static AWS keys from the child env and warns", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV });
    const r = runSh(f, [], { ...process.env, AWS_ACCESS_KEY_ID: "fake-id", AWS_SECRET_ACCESS_KEY: "fake-secret", AWS_SESSION_TOKEN: "fake-token" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("inherited AWS_ACCESS_KEY_ID is ignored");
    const dump = readFileSync(f.envDump, "utf8");
    expect(dump).not.toContain("AWS_ACCESS_KEY_ID");
    expect(dump).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(dump).not.toContain("AWS_SESSION_TOKEN");
  });

  it.each(["--env-file", "--node", "--executor-dir"])("fails fast with exit 2 when %s has no value", (opt) => {
    const r = spawnSync("bash", [posix(path.join(toolsDir, "run-executor.sh")), opt], { encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires a value");
  });

  it("forwards SIGTERM sent to the launcher to node (no orphan, ordered shutdown)", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV, waitForSignal: true });
    const ready = path.join(f.dir, "ready.txt");
    // One bash drives the launcher in the background, waits for node to be ready, sends SIGTERM to the launcher PID.
    const driver = [
      'bash "$1" --env-file "$2" --node "$3" --executor-dir "$4" &',
      "pid=$!",
      'for i in $(seq 1 100); do [ -f "$5" ] && break; sleep 0.1; done',
      '[ -f "$5" ] || { kill -KILL $pid 2>/dev/null; echo "node never became ready" >&2; exit 3; }',
      "kill -TERM $pid",
      "wait $pid",
    ].join("\n");
    const r = spawnSync(
      "bash",
      ["-c", driver, "driver", posix(path.join(toolsDir, "run-executor.sh")), posix(f.envFile), posix(f.node), posix(f.execDir), posix(ready)],
      { encoding: "utf8", timeout: 40_000 },
    );
    expect(r.stderr).not.toContain("never became ready");
    expect(existsSync(f.marker)).toBe(true);
  });
});

const psAvailable = process.platform === "win32" && spawnSync("powershell", ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe.skipIf(!psAvailable)("run-executor.ps1", { timeout: 30_000 }, () => {
  const ps1 = path.join(toolsDir, "run-executor.ps1");

  it("parses with zero errors", () => {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${ps1}',[ref]$t,[ref]$e);if($e.Count -gt 0){$e|ForEach-Object{$_.Message};exit 1}`,
      ],
      { encoding: "utf8" },
    );
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  // A `.cmd` shim stands in for node.exe (a real Node is not available in tests).
  function psFixture(version: string, env: string, withDist = true) {
    const f = fixture({ version, env, withDist });
    const cmd = path.join(f.dir, "fake-node.cmd");
    writeFileSync(cmd, `@echo off\r\nif "%1"=="--version" (echo ${version}& exit /b 0)\r\necho %* >> "${f.record}"\r\nexit /b 0\r\n`);
    return { ...f, node: cmd };
  }
  function runPs(f: { node: string; envFile: string; execDir: string }, extra: string[] = []) {
    return spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-EnvFile", f.envFile, "-NodePath", f.node, "-ExecutorDir", f.execDir, ...extra],
      { encoding: "utf8", timeout: 60_000 },
    );
  }

  it("dry run prints the redacted env and starts nothing", () => {
    const f = psFixture("v22.11.0", GOOD_ENV);
    const r = runPs(f, ["-DryRun"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("AWS_REGION=<set>");
    expect(r.stdout).not.toContain("secret-looking-queue");
    expect(existsSync(f.record)).toBe(false);
  });

  it("refuses Node 20 with exit 2", () => {
    const f = psFixture("v20.19.5", GOOD_ENV);
    const r = runPs(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Node major 22 is required");
  });

  it("refuses a static key (naming it) and a local endpoint", () => {
    const key = runPs(psFixture("v22.11.0", `${GOOD_ENV}\nAWS_SECRET_ACCESS_KEY=fake\n`));
    expect(key.status).toBe(2);
    expect(key.stderr).toContain("AWS_SECRET_ACCESS_KEY");
    expect(runPs(psFixture("v22.11.0", `${GOOD_ENV}\nCICD_DYNAMODB_ENDPOINT=http://localhost:8000\n`)).status).toBe(2);
  });

  it("refuses when dist is missing", () => {
    expect(runPs(psFixture("v22.11.0", GOOD_ENV, false)).status).toBe(2);
  });

  it("refuses when AWS_PROFILE is missing", () => {
    const r = runPs(psFixture("v22.11.0", "CICD_A=1\n"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("AWS_PROFILE");
  });

  it("removes inherited static keys from the child env, warns, and passes values literally", () => {
    const f = psFixture("v22.11.0", `${GOOD_ENV}\nCICD_A=$(echo x)\nCICD_C=a=b\n`);
    // The .cmd shim dumps the whole environment.
    writeFileSync(f.node, `@echo off\r\nif "%1"=="--version" (echo v22.11.0& exit /b 0)\r\nset > "${f.envDump}"\r\nexit /b 0\r\n`);
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-EnvFile", f.envFile, "-NodePath", f.node, "-ExecutorDir", f.execDir],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, AWS_ACCESS_KEY_ID: "fake-id" } },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("inherited AWS_ACCESS_KEY_ID is ignored");
    const dump = readFileSync(f.envDump, "utf8");
    expect(dump).not.toContain("AWS_ACCESS_KEY_ID");
    expect(dump).toContain("CICD_A=$(echo x)");
    expect(dump).toContain("CICD_C=a=b");
  });
});
