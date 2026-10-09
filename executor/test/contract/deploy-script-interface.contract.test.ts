// @akili-spec changes/cicd-executor-poc design §6.5, §7.5; requirements FR-12, FR-13; tasks R-9a
// Cross-component contract (task R-9a): the argument vector the Executor builds
// (deployPlanOf), sent as the exact SSH command line the transport runs
// (buildRemoteCommand, interpreted by a POSIX shell like a remote exec), is
// accepted by the reference target-side script deploy-scripts/deploy-container.sh,
// and the script's last stdout line is a CICD_RESULT the Executor parses
// (parseCicdResult). docker, aws and flock are the test shims of
// deploy-scripts/test/lib/shims, so this proves the interface, not real Docker
// or kernel-lock behavior (deferred to the first real deployment on a target).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";
import { buildRemoteCommand, parseCicdResult } from "../../src/adapters/ssh-deployer/index.js";
import { deployPlanOf } from "../../src/application/deploy-coordinator/index.js";
import { versionCheckOf } from "../../src/domain/version-check/index.js";
import { repoRoot } from "./support/schema-paths.js";

/** A POSIX bash that can run the script with its shims (Git Bash on Windows, bash on Linux); not a WSL stub. */
function shellPath(dir: string): string | undefined {
  const r = spawnSync("bash", ["-c", "pwd"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().startsWith("/") ? r.stdout.trim() : undefined;
}
const deployScriptsDir = path.join(repoRoot, "deploy-scripts");
const shellDeployScripts = shellPath(deployScriptsDir);

const SERVER_DIGEST = `sha256:${"2".repeat(64)}`;
const CLIENT_DIGEST = `sha256:${"3".repeat(64)}`;

function execution(scriptPath: string): ExecutionItem {
  return {
    executionId: "example-app-dev-7",
    targetId: "example-app-dev",
    commitSha: "a".repeat(40),
    artifacts: { server: SERVER_DIGEST, client: CLIENT_DIGEST },
    targetSnapshot: {
      version: 1,
      project: "example",
      environment: "dev",
      host: "target.example.internal",
      user: "deploy",
      hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
      credentialRef: "cicd-poc/dev/example-app-dev/ssh",
      deployScript: scriptPath,
      deployWindowPolicy: "not-required",
      sourceRepositoryId: "123456789",
    },
  } as unknown as ExecutionItem;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(path.join(tmpdir(), "cicd-script-contract-"));
  sandboxes.push(dir);
  for (const sub of ["lock", "docker-state", "targets"]) mkdirSync(path.join(dir, sub), { recursive: true });
  writeFileSync(path.join(dir, "docker.log"), "");
  writeFileSync(path.join(dir, "aws.log"), "");
  writeFileSync(
    path.join(dir, "targets", "example-app-dev.conf"),
    [
      "unit.server.repository=registry.example.invalid/team/app-server",
      "unit.server.container=example-app-server",
      "unit.client.repository=registry.example.invalid/team/app-client",
      "unit.client.container=example-app-client",
      "",
    ].join("\n"),
  );
  const shimDir = `${shellDeployScripts}/test/lib/shims`;
  const env = {
    ...process.env,
    CICD_LOCK_DIR: path.join(dir, "lock"),
    CICD_TARGET_CONFIG_DIR: path.join(dir, "targets"),
    DOCKER_STATE_DIR: path.join(dir, "docker-state"),
    DOCKER_LOG: path.join(dir, "docker.log"),
    AWS_FAKE_LOG: path.join(dir, "aws.log"),
    SHIM_DIR: shimDir,
  };
  return { dir, env };
}

/** Runs the exact remote command line through `bash -c`, as sshd hands an exec request to the login shell. */
function runRemote(command: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-c", `PATH="$SHIM_DIR:$PATH"; ${command}`], { env, encoding: "utf8" });
}

describe.skipIf(shellDeployScripts === undefined)("Executor ↔ reference deploy script (design §6.5, R-9a)", () => {
  it("the deployPlanOf vector, sent as the SSH command line, deploys and returns a CICD_RESULT the Executor parses", () => {
    const scriptPath = `${shellDeployScripts}/deploy-container.sh`;
    const plan = deployPlanOf(execution(scriptPath));
    const args = plan.scriptArgs(7);
    expect(args.slice(0, 8)).toEqual([
      "--target-id", "example-app-dev",
      "--execution-id", "example-app-dev-7",
      "--fencing-token", "7",
      "--commit-sha", "a".repeat(40),
    ]);
    const { dir, env } = sandbox();
    const run = runRemote(buildRemoteCommand(plan.scriptPath, args), env);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const result = parseCicdResult(run.stdout);
    expect(result).toBeDefined();
    expect(result?.status).toBe("SUCCESS");
    expect(result?.deployedImages).toEqual({
      "example-app-server": `registry.example.invalid/team/app-server@${SERVER_DIGEST}`,
      "example-app-client": `registry.example.invalid/team/app-client@${CLIENT_DIGEST}`,
    });
    const dockerLog = readFileSync(path.join(dir, "docker.log"), "utf8");
    expect(dockerLog).toContain(`docker pull registry.example.invalid/team/app-server@${SERVER_DIGEST}`);
    expect(dockerLog).toContain(`docker pull registry.example.invalid/team/app-client@${CLIENT_DIGEST}`);
    const lock = readFileSync(path.join(dir, "lock", "example-app-dev.lock"), "utf8");
    expect(lock).toContain("targetId=example-app-dev");
    expect(lock).toContain("fencingToken=7");
    expect(lock).toContain(`commitSha=${"a".repeat(40)}`);
  });

  it("a unit the target configuration does not know is a usage error (exit 2, no CICD_RESULT, no docker call)", () => {
    const scriptPath = `${shellDeployScripts}/deploy-container.sh`;
    const item = execution(scriptPath);
    const plan = deployPlanOf({ ...item, artifacts: { worker: SERVER_DIGEST } } as ExecutionItem);
    const { dir, env } = sandbox();
    const run = runRemote(buildRemoteCommand(plan.scriptPath, plan.scriptArgs(7)), env);
    expect(run.status).toBe(2);
    expect(parseCicdResult(run.stdout)).toBeUndefined();
    expect(readFileSync(path.join(dir, "docker.log"), "utf8")).toBe("");
  });
});


// AC-03 G-4: a NON-Docker script generated from the technology-neutral template (only its PLATFORM
// block replaced, the way platform scripts are produced from Jenkins stages) driven by the Executor's
// own plan in both argument modes. The phases only write marker files: no docker, aws or ECR involved.
describe.skipIf(shellDeployScripts === undefined)("Executor ↔ template-generated non-Docker script (AC-03, G-4)", () => {
  const FIXED_COMMIT = "c".repeat(40);
  const platformBlock = [
    'TARGET_LOCK_NAME="example-app-dev"',
    'phase_prepare() { : > "$CICD_MARKERS/prepared"; }',
    `phase_switch() { : > "$CICD_MARKERS/switched"; DEPLOYED_COMMIT="\${REQUESTED_COMMIT:-${FIXED_COMMIT}}"; }`,
    "phase_restore() { return 1; }",
  ].join("\n");

  function generate(dir: string): string {
    const template = readFileSync(path.join(deployScriptsDir, "templates", "deploy-script-template.sh"), "utf8");
    const begin = template.indexOf("# ===== BEGIN PLATFORM");
    const end = template.indexOf("# ===== END PLATFORM");
    expect(begin).toBeGreaterThan(0);
    const beginLineEnd = template.indexOf("\n", begin) + 1;
    const generated = template.slice(0, beginLineEnd) + platformBlock + "\n" + template.slice(end);
    writeFileSync(path.join(dir, "deploy-example-dev.sh"), generated);
    return `${shellPath(dir) as string}/deploy-example-dev.sh`;
  }

  it.each(["none", "standard"] as const)("%s mode: the plan's exact SSH command line runs the script, and the result is version-checked", (mode) => {
    const { dir, env } = sandbox();
    mkdirSync(path.join(dir, "markers"));
    const scriptPath = generate(dir);
    const base = execution(scriptPath);
    const item = { ...base, artifacts: {}, targetSnapshot: { ...base.targetSnapshot, scriptArguments: mode } } as ExecutionItem;
    const plan = deployPlanOf(item);
    expect(plan.scriptArgs(7)).toEqual(
      mode === "none" ? [] : ["--target-id", "example-app-dev", "--execution-id", "example-app-dev-7", "--fencing-token", "7", "--commit-sha", "a".repeat(40)],
    );
    const run = runRemote(buildRemoteCommand(plan.scriptPath, plan.scriptArgs(7)), { ...env, CICD_MARKERS: path.join(dir, "markers") });
    expect(run.status).toBe(0);
    const result = parseCicdResult(run.stdout);
    expect(result?.status).toBe("SUCCESS");
    if (mode === "standard") {
      expect(result?.deployedCommit).toBe("a".repeat(40));
      expect(versionCheckOf(item, result)).toEqual({ versionCheck: "VERIFIED", versionGuaranteed: true });
    } else {
      // The script was never told the version and deployed its own fixed commit: reported, never confirmed.
      expect(result?.deployedCommit).toBe(FIXED_COMMIT);
      expect(versionCheckOf(item, result)).toEqual({ versionCheck: "MISMATCH", versionGuaranteed: false });
    }
    expect(readFileSync(path.join(dir, "docker.log"), "utf8")).toBe("");
  });
});
