// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
//
// Unit tests for the pure, testable parts of the real image-inspection gate
// (scripts/inspect-image.mjs). The gate's actual `docker build`/`docker run`
// orchestration cannot be exercised here (no Docker daemon reachable in this
// environment — see main()'s DEFERRED path), but the decision logic it
// depends on is pure and must be proven correct without one.
//
// T-01 attempt 4 review findings and the tests that lock in each fix:
//
//   1. /app was pruned wholesale, so a forbidden package manager shipped as
//      a production dependency (e.g. npm added to package.json, landing at
//      /app/node_modules/npm/ via `COPY --from=deps`) was invisible to both
//      the PATH check and the filesystem sweep. Fixed by no longer pruning
//      /app, plus an explicit node_modules-package-directory match. See the
//      "does not prune /app" and "flags a forbidden package manager
//      directory under any node_modules" tests below.
//   2. The sweep ran as the image's non-root user and filtered every
//      "permission denied" error, silently skipping any toolchain under a
//      directory unreadable by that user. Fixed by forcing the sweep to run
//      as root (buildSweepRunArgs: `docker run --user 0`) and treating ANY
//      residual find stderr / non-zero find exit status as FAIL — no more
//      filtering. The image's default (non-forced) user is now checked
//      independently via evaluateUser() against `Config.User`. See the
//      "buildSweepRunArgs" and "evaluateUser" describe blocks.
//   3. The positive control only checked `command -v node`, which doesn't
//      prove the `find` sweep itself ran. Fixed by making the sweep its own
//      positive control: `find` also searches for "node", and only finding
//      it at the well-known /usr/local/bin/node path satisfies it; find's
//      own exit status is captured and read; stderr is only redirected to a
//      temp file after confirming it can be created. See the "positive
//      control" tests below.
//   Advisory: isForbiddenVolumePath also rejects /run and /run/* now (not
//   just /var/run). See the "/run" volume tests.
//
// Falsifiers (quoted in the completion report):
//   - re-adding `-path /app` to the prune expression turns "does not prune
//     /app" red;
//   - removing `--user 0` from buildSweepRunArgs turns "forces the sweep to
//     run as root" red;
//   - removing `-name 'node'` from the find expression (or the
//     /usr/local/bin/node requirement) turns "requires /usr/local/bin/node
//     among the find hits" red, and turns the parseInspectionOutput
//     "FAILs as inconclusive when the positive control is missing" red for
//     real captured output lacking that marker;
//   - dropping /run from isForbiddenVolumePath turns "FAILs when Volumes
//     declares /run" red.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildInContainerScript,
  buildSweepRunArgs,
  evaluateUser,
  evaluateVolumes,
  FORBIDDEN_NAMES,
  parseInspectionOutput,
  resolveBuildContext,
} from "../../scripts/inspect-image.mjs";

const EXECUTOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(EXECUTOR_ROOT, "..");
const DEFAULT_DOCKERFILE = path.join(EXECUTOR_ROOT, "Dockerfile");

describe("buildInContainerScript (in-container POSIX sh boundary check)", () => {
  const script = buildInContainerScript();

  it("forbids git in the runtime image (N-18, AC2): listed, checked via command -v and swept on disk", () => {
    expect(FORBIDDEN_NAMES).toContain("git");
    expect(script).toMatch(/for name in .*\bgit\b/);
    expect(script).toContain("-name 'git'");
  });

  it("is POSIX sh, not bash: no bash-only constructs", () => {
    expect(script).not.toMatch(/\[\[/);
    expect(script).not.toMatch(/\blocal\s+\w/);
    expect(script).not.toMatch(/\bfunction\s+\w+\s*\(/);
    expect(script).not.toMatch(/\$\{\w+\[@\]\}/); // bash arrays
  });

  it("checks every forbidden name with `command -v` (catches alternatives-style symlinks found via PATH)", () => {
    for (const name of FORBIDDEN_NAMES) {
      expect(script).toMatch(new RegExp(`for name in [^\\n]*\\b${name}\\b`));
    }
    expect(script).toContain('command -v "$name"');
  });

  it("includes -type l in the find type filter (catches symlinked binaries outside PATH, e.g. a direct /usr/share/maven/bin/mvn)", () => {
    expect(script).toMatch(/-type f\s+-o\s+-type l/);
  });

  it("does not prune /app: the Executor's own app tree (including /app/node_modules) is swept too", () => {
    expect(script).not.toMatch(/-path \/app\b/);
  });

  it("prunes only the pseudo-filesystems /proc, /sys, /dev", () => {
    expect(script).toMatch(/find \//);
    for (const pruned of ["/proc", "/sys", "/dev"]) {
      expect(script).toContain(`-path ${pruned}`);
    }
    expect(script).toMatch(/-prune/);
  });

  it("flags a forbidden package manager directory under any node_modules by exact path-segment match (e.g. /app/node_modules/npm)", () => {
    for (const name of FORBIDDEN_NAMES) {
      expect(script).toContain(`-path '*/node_modules/${name}'`);
    }
    // Exact segment match only — never a wildcard around the forbidden name
    // itself, so a legitimate dependency merely containing the substring
    // (e.g. "my-npm-helper") is never matched.
    expect(script).not.toContain("*npm*");
    expect(script).not.toContain("*/node_modules/*npm");
  });

  it("requires /usr/local/bin/node among the find hits as its own positive control (not just `command -v node`)", () => {
    expect(script).toContain("-name 'node'");
    expect(script).toContain("/usr/local/bin/node");
    expect(script).toContain("NODE_WELLKNOWN_FOUND");
    expect(script).toContain("POSITIVE_CONTROL_MISSING");
  });

  it("captures find's own exit status and fails on non-zero rather than trusting a suppressed failure", () => {
    expect(script).toContain("FIND_STATUS=$?");
    expect(script).toContain("FIND_EXIT_STATUS");
  });

  it("only redirects find's stderr to a temp file after verifying it is creatable, else FAILs", () => {
    expect(script).toContain("STDERR_CAPTURE_UNAVAILABLE");
    expect(script).toMatch(/:\s*>\s*"\$FIND_ERR_FILE"/);
  });

  it("does NOT filter permission-denied errors out of find's residual stderr (the sweep now runs as root)", () => {
    expect(script).not.toMatch(/permission denied/i);
    expect(script).not.toContain("grep");
  });

  it("checks find's own availability rather than trusting a suppressed failure", () => {
    expect(script).toContain("FIND_UNAVAILABLE");
    expect(script).toMatch(/command -v find/);
  });

  it("fails if a docker socket exists at /var/run/docker.sock or /run/docker.sock inside the container", () => {
    expect(script).toContain("/var/run/docker.sock");
    expect(script).toContain("/run/docker.sock");
    expect(script).toContain("DOCKER_SOCKET");
  });

  it("only emits BOUNDARY_OK and exits 0 when nothing failed", () => {
    expect(script).toContain("BOUNDARY_OK");
    expect(script.trim().endsWith("exit 0")).toBe(true);
  });
});

describe("buildSweepRunArgs (forces the in-container sweep to run as root)", () => {
  it("forces the sweep to run as root via --user 0", () => {
    const args = buildSweepRunArgs("cicd-executor-inspect:tag", "the-script");
    const userFlagIndex = args.indexOf("--user");
    expect(userFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[userFlagIndex + 1]).toBe("0");
  });

  it("overrides the entrypoint to sh and passes the tag and script through unchanged", () => {
    const args = buildSweepRunArgs("cicd-executor-inspect:tag", "the-script");
    expect(args).toEqual(["run", "--rm", "--user", "0", "--entrypoint", "sh", "cicd-executor-inspect:tag", "-c", "the-script"]);
  });
});

describe("parseInspectionOutput (verdict from the in-container script's output)", () => {
  it("FAILs on a symlinked mvn path line found by find", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:FIND:/usr/share/maven/bin/mvn\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/mvn/);
  });

  it("FAILs on a forbidden package manager directory found under /app/node_modules", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:FIND:/app/node_modules/npm\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/node_modules/);
  });

  it("FAILs on a command -v hit for an alternatives-style symlink (e.g. java)", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:COMMAND:java:/usr/bin/java\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/java/);
  });

  it("FAILs as inconclusive when the positive control is missing, even with no other findings", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:POSITIVE_CONTROL_MISSING\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/inconclusive/i);
    expect(verdict.reasons.join(" ")).toMatch(/\/usr\/local\/bin\/node/);
  });

  it("FAILs as inconclusive when find exits non-zero", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:FIND_EXIT_STATUS:2\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/inconclusive/i);
  });

  it("FAILs as inconclusive when the stderr capture file could not be created", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:STDERR_CAPTURE_UNAVAILABLE\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/inconclusive/i);
  });

  it("FAILs on any residual find stderr, with no permission-denied carve-out", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:FIND_ERROR:find: /some/path: Permission denied\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/inconclusive/i);
  });

  it("FAILs when the docker socket is present", () => {
    const verdict = parseInspectionOutput({
      stdout: "BOUNDARY_FAIL:DOCKER_SOCKET:/var/run/docker.sock\n",
      exitCode: 1,
    });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/socket/i);
  });

  it("FAILs as inconclusive on garbled/empty output rather than defaulting to PASS", () => {
    const verdict = parseInspectionOutput({ stdout: "", exitCode: 1 });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reasons.join(" ")).toMatch(/inconclusive/i);
  });

  it("FAILs as inconclusive when BOUNDARY_OK is printed but the exit code is non-zero", () => {
    const verdict = parseInspectionOutput({ stdout: "BOUNDARY_OK\n", exitCode: 1 });
    expect(verdict.status).toBe("FAIL");
  });

  it("ignores informational FIND_HIT_NODE lines (not a BOUNDARY_FAIL) when evaluating the verdict", () => {
    const verdict = parseInspectionOutput({
      stdout: "FIND_HIT_NODE:/usr/local/bin/node\nBOUNDARY_OK\n",
      exitCode: 0,
    });
    expect(verdict).toEqual({ status: "PASS", reasons: [] });
  });

  it("PASSes only when BOUNDARY_OK is present, exit code is 0, and no BOUNDARY_FAIL markers exist", () => {
    const verdict = parseInspectionOutput({ stdout: "BOUNDARY_OK\n", exitCode: 0 });
    expect(verdict).toEqual({ status: "PASS", reasons: [] });
  });
});

describe("evaluateVolumes (host-side `docker image inspect .Config.Volumes` check)", () => {
  it("FAILs when Volumes declares /var/run/docker.sock", () => {
    const verdict = evaluateVolumes({ "/var/run/docker.sock": {} });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/docker\.sock/);
  });

  it("FAILs when Volumes declares /var/run itself", () => {
    const verdict = evaluateVolumes({ "/var/run": {} });
    expect(verdict.ok).toBe(false);
  });

  it("FAILs when Volumes declares /run (Debian symlinks /var/run -> /run)", () => {
    const verdict = evaluateVolumes({ "/run": {} });
    expect(verdict.ok).toBe(false);
  });

  it("FAILs when Volumes declares /run/docker.sock", () => {
    const verdict = evaluateVolumes({ "/run/docker.sock": {} });
    expect(verdict.ok).toBe(false);
  });

  it("passes an image with an unrelated declared volume (e.g. /data)", () => {
    const verdict = evaluateVolumes({ "/data": {} });
    expect(verdict).toEqual({ ok: true, reasons: [] });
  });

  it("passes when Volumes is null (none declared)", () => {
    expect(evaluateVolumes(null)).toEqual({ ok: true, reasons: [] });
  });
});

describe("evaluateUser (host-side `docker image inspect .Config.User` check)", () => {
  it("FAILs when Config.User is empty (image defaults to root)", () => {
    const verdict = evaluateUser("");
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/root/i);
  });

  it("FAILs when Config.User is null/undefined", () => {
    expect(evaluateUser(null).ok).toBe(false);
    expect(evaluateUser(undefined).ok).toBe(false);
  });

  it('FAILs when Config.User is "0"', () => {
    expect(evaluateUser("0").ok).toBe(false);
  });

  it('FAILs when Config.User is "root"', () => {
    expect(evaluateUser("root").ok).toBe(false);
  });

  it('FAILs when Config.User is "root:root"', () => {
    expect(evaluateUser("root:root").ok).toBe(false);
  });

  it('FAILs when Config.User is "0:0"', () => {
    expect(evaluateUser("0:0").ok).toBe(false);
  });

  it('passes when Config.User is a named non-root user (e.g. "executor")', () => {
    expect(evaluateUser("executor")).toEqual({ ok: true, reasons: [] });
  });

  it("passes when Config.User is a non-zero numeric UID", () => {
    expect(evaluateUser("1000")).toEqual({ ok: true, reasons: [] });
  });
});

describe("resolveBuildContext (T-03, design DD-19: definitions live at the repo root, outside executor/)", () => {
  it("builds the DEFAULT (real) Dockerfile with the REPO ROOT as context and a repo-root-relative -f path", () => {
    const { context, dockerfileArg } = resolveBuildContext(DEFAULT_DOCKERFILE);
    expect(context).toBe(REPO_ROOT);
    expect(dockerfileArg).toBe(path.join("executor", "Dockerfile"));
  });

  it("keeps the OLD executor-root context for a --dockerfile override (T-01 falsifier fixtures)", () => {
    const falsifierPath = path.join(EXECUTOR_ROOT, "test", "fixtures", "dockerfiles", "Dockerfile.falsifier-docker-cli");
    const { context, dockerfileArg } = resolveBuildContext(falsifierPath);
    expect(context).toBe(EXECUTOR_ROOT);
    expect(dockerfileArg).toBe(falsifierPath);
  });
});
