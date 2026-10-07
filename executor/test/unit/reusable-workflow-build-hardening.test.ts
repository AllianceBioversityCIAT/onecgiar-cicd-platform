// @akili-spec changes/cicd-executor-poc requirements FR-22; design DD-24, DD-29 (SR-1, Gate B security correction)
//
// Adversarial, EXECUTED test of the build-hardening steps of the reusable workflow. The `run:` scripts of
// "Validate build inputs" and "Build units (no AWS credentials yet)" are extracted from the parsed YAML and
// run with bash against a temporary $GITHUB_WORKSPACE and a fake `docker` on PATH (records argv and the
// environment keys it sees). Rule under test: ANY symbolic link on a context or Dockerfile path is rejected
// (even one pointing inside the workspace), as are absolute, `..`, remote and non-existent paths.
// Skipped (never passed) only when bash+jq+realpath cannot run or symbolic links cannot be created.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "../contract/support/schema-paths.js";

interface Step {
  name?: string;
  run?: string;
}
const wf = parse(readFileSync(path.join(repoRoot, ".github", "workflows", "deploy-request.reusable.yml"), "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const steps = wf.jobs["push-and-send"]!.steps;
const validateScript = steps.find((s) => s.name === "Validate build inputs")!.run!;
const buildScript = steps.find((s) => s.name === "Build units (no AWS credentials yet)")!.run!;

const posix = (p: string): string => p.split(path.sep).join("/");
const bashOk = spawnSync("bash", ["-c", "jq --version && realpath --version"], { encoding: "utf8" }).status === 0;

const root = mkdtempSync(path.join(tmpdir(), "build-hardening-"));
const ws = path.join(root, "ws");
const outside = path.join(root, "outside");
const bin = path.join(root, "bin");
const dockerLog = path.join(root, "docker.log");
const dockerEnv = path.join(root, "docker.env");
const runnerTemp = path.join(root, "tmp");

// Real symbolic links are needed; on Windows they may require privileges.
function probeSymlinks(): boolean {
  try {
    const t = path.join(root, "probe-target");
    mkdirSync(t);
    symlinkSync(t, path.join(root, "probe-link"), "dir");
    return spawnSync("bash", ["-c", `[ -L "${posix(path.join(root, "probe-link"))}" ]`]).status === 0;
  } catch {
    return false;
  }
}
const enabled = bashOk && probeSymlinks();

beforeAll(() => {
  if (!enabled) return;
  for (const d of [ws, outside, bin, runnerTemp]) mkdirSync(d, { recursive: true });
  mkdirSync(path.join(ws, "app", "server"), { recursive: true });
  writeFileSync(path.join(ws, "app", "server", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(ws, "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(outside, "Dockerfile"), "FROM scratch\n");
  mkdirSync(path.join(outside, "ctx"));
  mkdirSync(path.join(outside, "b"));
  symlinkSync(path.join(outside, "ctx"), path.join(ws, "ctx-link"), "dir");
  symlinkSync(outside, path.join(ws, "a-link"), "dir");
  symlinkSync(path.join(outside, "Dockerfile"), path.join(ws, "Dockerfile.escape"), "file");
  symlinkSync("Dockerfile", path.join(ws, "Dockerfile.inside"), "file");
  symlinkSync("app", path.join(ws, "app-inside-link"), "dir");
  // Fake docker: records argv and the NAMES of its environment variables.
  const shim = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${posix(dockerLog)}"`,
    `env | cut -d= -f1 | sort > "${posix(dockerEnv)}"`,
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(path.join(bin, "docker"), shim);
  chmodSync(path.join(bin, "docker"), 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("AWS_") && !k.startsWith("ACTIONS_")) env[k] = v;
  }
  return {
    ...env,
    PATH: `${posix(bin)}:${env["PATH"] ?? ""}`,
    GITHUB_WORKSPACE: posix(ws),
    RUNNER_TEMP: posix(runnerTemp),
    RUN_ID: "123",
    RUN_ATTEMPT: "1",
    ...extra,
  };
}
function run(script: string, units: unknown[], extra: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], { encoding: "utf8", cwd: ws, env: baseEnv({ UNITS: JSON.stringify(units), ...extra }) });
}
const validate = (units: unknown[]) => run(validateScript, units);

describe.skipIf(!enabled)("SR-1 build hardening (executed: bash, jq, real symlinks, fake docker)", () => {
  it("accepts plain valid units and builds them with a local tag, `--` before the context, and no OIDC request variables", () => {
    const units = [
      { unit: "server", context: "app/server" },
      { unit: "root", context: ".", dockerfile: "Dockerfile" },
    ];
    expect(validate(units).status).toBe(0);
    rmSync(dockerLog, { force: true });
    const r = run(buildScript, units, {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "fake-url",
      ACTIONS_RUNTIME_TOKEN: "fake-runtime",
      ACTIONS_CACHE_URL: "fake-cache",
      ACTIONS_RESULTS_URL: "fake-results",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(dockerLog, "utf8").trim().split("\n")).toEqual([
      "build --file Dockerfile --tag cicd-local/server:123-1 -- app/server",
      "build --file Dockerfile --tag cicd-local/root:123-1 -- .",
    ]);
    const seen = readFileSync(dockerEnv, "utf8");
    for (const k of ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_CACHE_URL", "ACTIONS_RESULTS_URL"]) {
      expect(seen, k).not.toContain(k);
    }
    expect(readFileSync(path.join(runnerTemp, "local-images.tsv"), "utf8")).toBe(
      "server\tcicd-local/server:123-1\nroot\tcicd-local/root:123-1\n",
    );
  });

  const rejected: Array<[string, unknown[]]> = [
    ["a context symlinked to a directory outside the workspace", [{ unit: "u", context: "ctx-link" }]],
    ["a context with an intermediate symlinked component (a-link/b)", [{ unit: "u", context: "a-link/b" }]],
    ["a context reached through a symlink that stays INSIDE the workspace (any symlink is rejected)", [{ unit: "u", context: "app-inside-link/server" }]],
    ["a Dockerfile symlinked to a file outside the workspace", [{ unit: "u", context: ".", dockerfile: "Dockerfile.escape" }]],
    ["a Dockerfile symlinked to a file INSIDE the workspace (any symlink is rejected)", [{ unit: "u", context: ".", dockerfile: "Dockerfile.inside" }]],
    ["an absolute context", [{ unit: "u", context: "/etc" }]],
    ["an absolute Dockerfile", [{ unit: "u", context: ".", dockerfile: "/etc/hostname" }]],
    ["a context `../x`", [{ unit: "u", context: "../x" }]],
    ["a context `a/../../x`", [{ unit: "u", context: "a/../../x" }]],
    ["a Dockerfile `../Dockerfile`", [{ unit: "u", context: ".", dockerfile: "../Dockerfile" }]],
    ["a remote https context", [{ unit: "u", context: "https://example.invalid/repo.git" }]],
    ["a remote git@ context", [{ unit: "u", context: "git@host:repo" }]],
    ["a context that does not exist", [{ unit: "u", context: "missing" }]],
    ["a Dockerfile that does not exist", [{ unit: "u", context: ".", dockerfile: "Missing.Dockerfile" }]],
    ["a context that is a file, not a directory", [{ unit: "u", context: "Dockerfile" }]],
    ["a Dockerfile that is a directory", [{ unit: "u", context: ".", dockerfile: "app" }]],
    ["a context with a trailing newline (control character)", [{ unit: "u", context: "app\n" }]],
    ["a Dockerfile with a trailing newline (control character)", [{ unit: "u", context: ".", dockerfile: "Dockerfile\n" }]],
    ["a context starting with a dash",[{ unit: "u", context: "-x" }]],
  ];
  it.each(rejected)("rejects %s, naming only the unit, and never reaches docker", (_title, units) => {
    rmSync(dockerLog, { force: true });
    const r = validate(units);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toContain("build input rejected for unit u");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("fails closed at build time when an AWS credential variable is present, without invoking docker", () => {
    rmSync(dockerLog, { force: true });
    const r = run(buildScript, [{ unit: "server", context: "app/server" }], { AWS_ACCESS_KEY_ID: "fake" });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("cloud credentials are present");
    expect(existsSync(dockerLog)).toBe(false);
  });

  it("fails the build step when docker fails (set -e) and records no local image", () => {
    const failing = path.join(root, "bin-fail");
    mkdirSync(failing, { recursive: true });
    writeFileSync(path.join(failing, "docker"), "#!/usr/bin/env bash\nexit 7\n");
    chmodSync(path.join(failing, "docker"), 0o755);
    const env = baseEnv({ UNITS: JSON.stringify([{ unit: "server", context: "app/server" }]) });
    env["PATH"] = `${posix(failing)}:${env["PATH"]}`;
    const r = spawnSync("bash", ["-c", buildScript], { encoding: "utf8", cwd: ws, env });
    expect(r.status).not.toBe(0);
    expect(readFileSync(path.join(runnerTemp, "local-images.tsv"), "utf8")).toBe("");
  });
});

describe.skipIf(enabled)("SR-1 build hardening (SKIPPED: bash+jq+realpath or symbolic links unavailable)", () => {
  it.skip("is not executed in this environment", () => {});
});
