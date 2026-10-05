#!/usr/bin/env node
// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2, DD-15
//
// Real image-inspection gate for T-01 ("Done: image inspection green"). The
// static scanner (test/support/dockerfile-boundary-scanner.ts) is only a
// best-effort PRE-CHECK; THIS script is the authoritative boundary gate the
// task asks for: it (1) `docker build`s the Executor image from a given
// Dockerfile with a unique local tag, (2) inspects the built image's
// declared `Config.Volumes` and `Config.User` (host-side, no container run
// needed), (3) runs the image — forced to run as root via `docker run
// --user 0` — with an overridden entrypoint to sweep the filesystem (and
// PATH) for application-build toolchains and confirm no Docker socket is
// present inside the container, (4) prints a clear PASS/FAIL report and
// exits non-zero on FAIL, and (5) — since no Docker daemon is reachable in
// this development environment — exits with a distinct code (3) and a
// specific DEFERRED message instead of ever reporting PASS when it cannot
// actually check.
//
// T-01 attempt 4 review (verbatim findings) and what attempt 5 fixes here:
//   1. /app was pruned wholesale from the sweep and nothing there is on
//      PATH, so a full package manager shipped INSIDE the app tree was
//      invisible to both checks — e.g. npm added as a production
//      dependency lands at /app/node_modules/npm/ via `COPY --from=deps`
//      and is runnable via `node /app/node_modules/npm/bin/npm-cli.js`
//      without ever being named "npm" on disk. Fixed by: (a) no longer
//      pruning /app — only the pseudo-filesystems (/proc, /sys, /dev) are
//      pruned now, so /app/node_modules (including
//      /app/node_modules/.bin/<forbidden-name> symlinks) is swept like any
//      other path; (b) an explicit `-type d -path '*/node_modules/<name>'`
//      clause per forbidden name, so the mere presence of a forbidden
//      package's own directory is caught even when its entry-point file
//      is not itself named after the tool. Both match on exact
//      name/path-segment equality (never a wildcard around the forbidden
//      name itself), so a legitimate dependency whose name merely contains
//      a forbidden name as a substring (e.g. "my-npm-helper") is never
//      flagged.
//   2. The sweep ran as the image's non-root user and deliberately
//      filtered every "permission denied" error, so any toolchain under a
//      directory unreadable by that user (e.g. an npm global prefix
//      installed as root under /root, mode 0700) was silently skipped.
//      Fixed by: (a) the sweep now runs via `docker run --user 0`
//      (buildSweepRunArgs), so root can read everything and a legitimate
//      permission-denied read should no longer occur; (b) the
//      permission-denied filter is gone — ANY residual `find` stderr, and
//      any non-zero `find` exit status, now FAILs the gate; (c) because
//      the sweep is now forced to run as root, it can no longer itself
//      prove the image's DEFAULT user is non-root — that is checked
//      independently, host-side, via `docker image inspect --format
//      '{{.Config.User}}'` (evaluateUser), rejecting empty/"0"/"root".
//   3. The positive control only checked `command -v node`, which does not
//      prove the `find` sweep itself ran (e.g. if the stderr redirect
//      target could not be created, `find` was silently skipped and both
//      FOUND and the residual-error variable came back empty — read as a
//      clean scan). `find`'s own exit status was never read, and `grep`'s
//      absence would have been swallowed by `|| true`. Fixed by: (a) the
//      sweep's own `find` expression now also searches for "node", and the
//      gate requires the well-known path /usr/local/bin/node among the
//      hits before trusting any other (empty) part of the scan — if the
//      sweep did not run, this can never be satisfied; (b) `find`'s exit
//      status is captured and read explicitly (FIND_EXIT_STATUS); (c) the
//      stderr temp file is only used after confirming it can be created
//      (STDERR_CAPTURE_UNAVAILABLE otherwise, never silently skipped).
//   Advisory: `isForbiddenVolumePath` now also rejects `/run` and
//   `/run/*` (Debian symlinks /var/run -> /run), not just `/var/run`. The
//   in-container docker.sock check is checked at both `/var/run/docker.sock`
//   and `/run/docker.sock`, but this gate never mounts anything into the
//   container it runs — a real `docker run -v /var/run/docker.sock:...`
//   mount is a deploy-time decision this gate cannot simulate. The PASS
//   message says so explicitly instead of overclaiming, and names the
//   volume/socket/user checks it did perform.
//
// The pure decision functions (buildInContainerScript, buildSweepRunArgs,
// parseInspectionOutput, evaluateVolumes, evaluateUser,
// describeDockerUnavailable) are exported so they can be unit-tested
// without a Docker daemon — see test/unit/inspect-image.test.ts. Importing
// this module for those exports must never itself run the gate: main()
// only runs when this file is executed directly (see the
// `import.meta.url` guard at the bottom).
//
// No dependencies beyond Node's own standard library.
//
// Usage:
//   node scripts/inspect-image.mjs [--dockerfile <path>]
//   npm run inspect:image -- --dockerfile test/fixtures/dockerfiles/Dockerfile.falsifier-docker-cli
//
// Build context (T-03, design DD-19): with no override, this builds the
// REAL Dockerfile with the platform REPO ROOT as context (`docker build -f
// executor/Dockerfile .` from the repo root) — not executor/ — because its
// runtime stage COPYs pipeline-definitions/, schemas/ and deploy-scripts/
// from the repo root, as siblings of executor/. See resolveBuildContext().
// A `--dockerfile` override (e.g. the T-01 falsifier fixtures) keeps the
// OLD executor-root-context behavior, since those fixtures predate this
// change and COPY paths relative to executor/.
//
// Exit codes: 0 = PASS, 1 = FAIL (image built but boundary violated, or the
// build/run itself failed), 2 = usage error, 3 = DEFERRED (no Docker daemon).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXECUTOR_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(EXECUTOR_ROOT, "..");
const DEFAULT_DOCKERFILE = path.join(EXECUTOR_ROOT, "Dockerfile");

// Binaries that must never be reachable inside the shipped image, whether
// via PATH (`command -v`), on disk as a file/symlink (`find`), or present as
// an installed package directory under any `node_modules` (`find -type d`).
export const FORBIDDEN_NAMES = [
  "npm",
  "npx",
  "corepack",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
  "mvn",
  "java",
  "javac",
  "gradle",
  "docker",
  "dockerd",
  "pip",
  "pip3",
];

// The positive control: proves the sweep's `find` invocation actually ran
// (as opposed to being silently skipped, e.g. because its stderr target
// could not be created) by requiring it to find Node itself at its
// well-known install path in the node:22-slim base image.
const POSITIVE_CONTROL_NAME = "node";
const POSITIVE_CONTROL_PATH = "/usr/local/bin/node";

// The filesystem sweep runs from `/` and prunes only the pseudo-filesystems
// that are neither useful to scan nor safe to traverse. The Executor's own
// application tree (/app, including /app/node_modules) is deliberately NOT
// pruned: a forbidden package manager shipped as a production dependency
// would otherwise be invisible to the sweep (see finding #1 above).
export const PRUNE_PATHS = ["/proc", "/sys", "/dev"];

const BOUNDARY_FAIL_PREFIX = "BOUNDARY_FAIL:";
const BOUNDARY_OK_MARKER = "BOUNDARY_OK";

/**
 * Builds the POSIX `sh` script (no bash-isms — this runs via
 * `docker run --entrypoint sh`, and the base image is not guaranteed to
 * carry bash) that runs INSIDE the built image, forced to run as root
 * (see buildSweepRunArgs), to check the NFR-01 boundary. Every failure path
 * prints a single, greppable `BOUNDARY_FAIL:<KIND>[:...details]` line and
 * sets a FAIL flag rather than exiting immediately, so one run reports
 * every violation found instead of only the first. The script exits 0 and
 * prints BOUNDARY_OK only if nothing failed.
 */
export function buildInContainerScript() {
  const findNames = [...FORBIDDEN_NAMES, POSITIVE_CONTROL_NAME];
  const pruneExpr = PRUNE_PATHS.map((p) => `-path ${p}`).join(" -o ");
  const nameExpr = findNames.map((n) => `-name '${n}'`).join(" -o ");
  const nodeModulesDirExpr = FORBIDDEN_NAMES.map((n) => `-path '*/node_modules/${n}'`).join(" -o ");
  const findCommand =
    "find / \\( " +
    pruneExpr +
    " \\) -prune -o \\( \\( \\( -type f -o -type l \\) \\( " +
    nameExpr +
    " \\) \\) -o \\( -type d \\( " +
    nodeModulesDirExpr +
    ' \\) \\) \\) -print 2>"$FIND_ERR_FILE"';

  return [
    "set -u",
    "FAIL=0",
    "NODE_WELLKNOWN_FOUND=0",
    "FIND_AVAILABLE=1",
    "STDERR_CAPTURE_OK=1",
    "",
    "# 1) command -v for every forbidden name: resolves through PATH and",
    "#    through any symlink chain (e.g. Debian's alternatives system:",
    "#    /usr/bin/mvn -> /etc/alternatives/mvn -> /usr/share/maven/bin/mvn),",
    "#    independent of where on disk the real target lives.",
    `for name in ${FORBIDDEN_NAMES.join(" ")}; do`,
    '  resolved=$(command -v "$name" 2>/dev/null) || resolved=""',
    '  if [ -n "$resolved" ]; then',
    '    echo "' + BOUNDARY_FAIL_PREFIX + 'COMMAND:$name:$resolved"',
    "    FAIL=1",
    "  fi",
    "done",
    "",
    "# 2) `find` availability. If `find` itself is not on PATH, the",
    "#    filesystem sweep below cannot run at all — this must FAIL, never",
    "#    be silently read as a clean scan.",
    "if ! command -v find >/dev/null 2>&1; then",
    '  echo "' + BOUNDARY_FAIL_PREFIX + 'FIND_UNAVAILABLE"',
    "  FAIL=1",
    "  FIND_AVAILABLE=0",
    "fi",
    "",
    "# 3) only redirect find's stderr to a temp file after confirming that",
    "#    file can actually be created; an empty residual-error read is",
    "#    meaningless if the redirect target itself could never be written.",
    'FIND_ERR_FILE="/tmp/.inspect-image-find-err.$$"',
    'if [ "$FIND_AVAILABLE" = "1" ]; then',
    '  if ! ( : > "$FIND_ERR_FILE" ) 2>/dev/null; then',
    '    echo "' + BOUNDARY_FAIL_PREFIX + 'STDERR_CAPTURE_UNAVAILABLE"',
    "    FAIL=1",
    "    STDERR_CAPTURE_OK=0",
    "  else",
    '    rm -f "$FIND_ERR_FILE"',
    "  fi",
    "fi",
    "",
    "# 4) filesystem sweep from /, pruning only pseudo-filesystems (NOT",
    "#    /app: see finding #1). Matches regular files and symlinks by",
    "#    exact basename, AND directories whose path ends in",
    "#    */node_modules/<forbidden-name>, so a forbidden package manager's",
    "#    own directory is caught even if its entry-point file is not",
    "#    itself named after the tool (e.g. node_modules/npm/bin/npm-cli.js).",
    "#    This sweep doubles as its own positive control: 'node' is",
    "#    included in the name search, and finding it at the well-known",
    "#    /usr/local/bin/node path is what proves the sweep actually ran.",
    "#    This runs as root (docker run --user 0, see buildSweepRunArgs), so",
    "#    a legitimate permission-denied read should not occur: ANY residual",
    "#    stderr, and any non-zero `find` exit status, both FAIL the gate",
    "#    rather than being filtered as benign.",
    'if [ "$FIND_AVAILABLE" = "1" ] && [ "$STDERR_CAPTURE_OK" = "1" ]; then',
    `  FOUND=$(${findCommand})`,
    "  FIND_STATUS=$?",
    '  FIND_RESIDUAL_ERR=$(cat "$FIND_ERR_FILE" 2>/dev/null)',
    '  rm -f "$FIND_ERR_FILE" 2>/dev/null',
    '  if [ "$FIND_STATUS" -ne 0 ]; then',
    '    echo "' + BOUNDARY_FAIL_PREFIX + 'FIND_EXIT_STATUS:$FIND_STATUS"',
    "    FAIL=1",
    "  fi",
    '  if [ -n "$FIND_RESIDUAL_ERR" ]; then',
    '    echo "' + BOUNDARY_FAIL_PREFIX + 'FIND_ERROR:$FIND_RESIDUAL_ERR"',
    "    FAIL=1",
    "  fi",
    '  if [ -n "$FOUND" ]; then',
    "    while IFS= read -r hit; do",
    '      base=${hit##*/}',
    `      if [ "\$base" = "${POSITIVE_CONTROL_NAME}" ]; then`,
    `        if [ "\$hit" = "${POSITIVE_CONTROL_PATH}" ]; then`,
    "          NODE_WELLKNOWN_FOUND=1",
    "        fi",
    '        echo "FIND_HIT_NODE:$hit"',
    "      else",
    '        echo "' + BOUNDARY_FAIL_PREFIX + 'FIND:$hit"',
    "        FAIL=1",
    "      fi",
    "    done <<FIND_HITS_EOF",
    "$FOUND",
    "FIND_HITS_EOF",
    "  fi",
    "fi",
    "",
    "# 5) positive control verdict: if the sweep did not actually run (find",
    "#    unavailable, stderr capture unavailable) or ran but somehow never",
    "#    saw Node at its well-known path, the whole scan is inconclusive",
    "#    and must FAIL rather than be read as clean.",
    'if [ "$NODE_WELLKNOWN_FOUND" != "1" ]; then',
    '  echo "' + BOUNDARY_FAIL_PREFIX + 'POSITIVE_CONTROL_MISSING"',
    "  FAIL=1",
    "fi",
    "",
    "# 6) must not have a mounted (or otherwise present) Docker socket at",
    "#    either of its common locations (Debian symlinks /var/run -> /run).",
    "#    NOTE: this gate never mounts anything into the container it runs,",
    "#    so this can only ever catch a socket baked into the image itself —",
    "#    a real `docker run -v /var/run/docker.sock:...` host mount is a",
    "#    deploy-time decision this in-container check cannot simulate.",
    "for sock in /var/run/docker.sock /run/docker.sock; do",
    '  if [ -e "$sock" ]; then',
    '    echo "' + BOUNDARY_FAIL_PREFIX + 'DOCKER_SOCKET:$sock"',
    "    FAIL=1",
    "  fi",
    "done",
    "",
    'if [ "$FAIL" = "1" ]; then',
    "  exit 1",
    "fi",
    `echo "${BOUNDARY_OK_MARKER}"`,
    "exit 0",
  ].join("\n");
}

/**
 * Builds the `docker run` argument list used to execute the in-container
 * sweep script. The sweep is deliberately forced to run as root
 * (`--user 0`) so that a directory unreadable by the image's own non-root
 * user (e.g. an npm global prefix installed as root under /root, mode
 * 0700) cannot silently hide a forbidden toolchain from the scan — see
 * finding #2. The image's DEFAULT user is checked separately, host-side,
 * via evaluateUser(), since forcing root here means this run can no longer
 * itself prove what user the image runs as by default.
 */
export function buildSweepRunArgs(tag, script) {
  return ["run", "--rm", "--user", "0", "--entrypoint", "sh", tag, "-c", script];
}

const FAIL_REASON_DESCRIBERS = {
  COMMAND: (parts) => `forbidden toolchain "${parts[0]}" resolvable on PATH at "${parts.slice(1).join(":")}"`,
  FIND: (parts) => `forbidden toolchain found on disk at "${parts.join(":")}" (file, symlink, or node_modules package directory)`,
  FIND_UNAVAILABLE: () => "inspection inconclusive: `find` is not available inside the image",
  FIND_ERROR: (parts) => `inspection inconclusive: find reported unexpected errors: ${parts.join(":")}`,
  FIND_EXIT_STATUS: (parts) =>
    `inspection inconclusive: \`find\` exited with a non-zero status (${parts[0] ?? "unknown"}), so the sweep cannot be trusted`,
  STDERR_CAPTURE_UNAVAILABLE: () =>
    "inspection inconclusive: could not create a temp file to capture find's stderr, so an apparently-clean result cannot be trusted",
  POSITIVE_CONTROL_MISSING: () =>
    `inspection inconclusive: positive control (node at ${POSITIVE_CONTROL_PATH}) was not found by the sweep; the scan result cannot be trusted`,
  DOCKER_SOCKET: (parts) => `docker socket is present inside the container at "${parts.join(":") || "(unknown path)"}"`,
};

function describeBoundaryFailLine(line) {
  const rest = line.slice(BOUNDARY_FAIL_PREFIX.length);
  const [kind, ...parts] = rest.split(":");
  const describe = kind ? FAIL_REASON_DESCRIBERS[kind] : undefined;
  if (describe) {
    return describe(parts);
  }
  return `unrecognized boundary failure line: "${line}"`;
}

/**
 * Turns the in-container script's raw stdout and exit code into a verdict.
 * Pure: takes exactly what `spawnSync` would hand back (as plain data, not a
 * live process), so it is unit-testable without ever running Docker.
 *
 * PASSes ONLY when every expected marker lines up: exit code 0, the
 * BOUNDARY_OK line present, and zero BOUNDARY_FAIL lines. Any other
 * combination — including output that is empty, truncated, or reports
 * BOUNDARY_OK next to a non-zero exit code — is reported as FAIL, never as
 * PASS, with a reason explaining why the result could not be trusted.
 */
export function parseInspectionOutput({ stdout, exitCode }) {
  const lines = (stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const failLines = lines.filter((line) => line.startsWith(BOUNDARY_FAIL_PREFIX));
  const hasOkMarker = lines.includes(BOUNDARY_OK_MARKER);

  if (failLines.length === 0 && hasOkMarker && exitCode === 0) {
    return { status: "PASS", reasons: [] };
  }

  if (failLines.length > 0) {
    return { status: "FAIL", reasons: failLines.map(describeBoundaryFailLine) };
  }

  return {
    status: "FAIL",
    reasons: [
      `inspection inconclusive: expected the "${BOUNDARY_OK_MARKER}" marker with exit code 0, got exit code ${String(
        exitCode,
      )} and no recognizable boundary markers in the output`,
    ],
  };
}

// Any declared volume at or under /var/run or /run (Debian symlinks
// /var/run -> /run), or anywhere naming docker.sock, can be used at
// `docker run` time to mount a host Docker socket into the container
// without the Dockerfile itself giving any indication — so this is checked
// independently of the in-container scan.
function isForbiddenVolumePath(volumePath) {
  const normalized = volumePath.replace(/\/+$/, "") || "/";
  return (
    normalized === "/var/run" ||
    normalized.startsWith("/var/run/") ||
    normalized === "/run" ||
    normalized.startsWith("/run/") ||
    /docker\.sock/i.test(normalized)
  );
}

/**
 * Evaluates a built image's `docker image inspect --format
 * '{{json .Config.Volumes}}'` result (already JSON-parsed: an object keyed
 * by declared volume path, or `null`/`undefined` when none are declared).
 * Pure and independent of parseInspectionOutput — a Dockerfile can declare
 * a dangerous VOLUME without any process inside the running container ever
 * revealing it.
 */
export function evaluateVolumes(volumes) {
  if (volumes === null || volumes === undefined) {
    return { ok: true, reasons: [] };
  }
  const reasons = [];
  for (const volumePath of Object.keys(volumes)) {
    if (isForbiddenVolumePath(volumePath)) {
      reasons.push(
        `image declares a volume at "${volumePath}", which can be used to mount a host Docker socket, /var/run, or /run at \`docker run\` time`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Evaluates a built image's `docker image inspect --format
 * '{{.Config.User}}'` result: an empty string means Docker runs the
 * container as root by default (no USER instruction took effect); "0" or
 * "root" (optionally followed by ":<group>") are rejected too. Anything
 * else (a named non-root user, or a non-zero numeric UID) is accepted.
 *
 * This check exists because the in-container sweep (buildInContainerScript)
 * is now deliberately forced to run as root (`docker run --user 0`, see
 * buildSweepRunArgs) so it can read everywhere a forbidden toolchain might
 * be hiding — which means that run can no longer itself prove what user the
 * image runs as BY DEFAULT. This is that proof instead: pure, host-side,
 * and independent of any container run.
 */
export function evaluateUser(configUser) {
  const raw = (configUser ?? "").trim();
  if (raw.length === 0) {
    return { ok: false, reasons: ["image declares no USER (Config.User is empty): it defaults to running as root"] };
  }
  const userPart = raw.split(":")[0] ?? "";
  if (userPart === "0" || userPart.toLowerCase() === "root") {
    return { ok: false, reasons: [`image's default user is root (Config.User = "${raw}")`] };
  }
  return { ok: true, reasons: [] };
}

/**
 * Turns a failed `docker info` attempt (as plain data: the `spawnSync`
 * result shape) into a specific, actionable DEFERRED message, instead of
 * one generic "docker daemon unavailable" line that does not distinguish
 * "docker is not installed here" from "docker is installed but the daemon
 * is not reachable" from "the daemon socket exists but this user lacks
 * permission to use it".
 */
export function describeDockerUnavailable({ error, status, stderr }) {
  if (error) {
    if (error.code === "ENOENT") {
      return "DEFERRED: docker CLI not found on PATH";
    }
    return `DEFERRED: could not invoke the docker CLI (${error.message})`;
  }
  const stderrText = String(stderr ?? "");
  if (/permission denied/i.test(stderrText)) {
    return "DEFERRED: docker CLI present but permission denied reaching the daemon (check docker group membership / access to the daemon socket)";
  }
  if (/daemon is not running/i.test(stderrText) || /cannot connect to the docker daemon/i.test(stderrText)) {
    return "DEFERRED: docker CLI present but no docker daemon is reachable (daemon is not running)";
  }
  return `DEFERRED: docker daemon unavailable (docker info exited ${String(status)})`;
}

/**
 * Decides the `docker build` context directory and the `-f`/`--file` value
 * to pass alongside it (design DD-19: pipeline-definitions/, schemas/ and
 * deploy-scripts/ are packaged into the image at build time, and they live
 * at the platform REPO ROOT, as siblings of executor/ — so the real,
 * shipped Dockerfile must be built with the repo root as context, not
 * executor/ itself).
 *
 * The DEFAULT Dockerfile (no `--dockerfile` override) is built with the
 * repo root as context and a dockerfile path relative to it
 * ("executor/Dockerfile"), matching exactly how its COPY instructions are
 * now written.
 *
 * A `--dockerfile` OVERRIDE (used by the T-01 falsifier fixtures under
 * executor/test/fixtures/dockerfiles/, which predate this change and still
 * COPY paths relative to executor/) keeps the OLD behavior: context =
 * executor/, dockerfile = the given path as-is. Those fixtures are
 * deliberately not rewritten here (T-01's "do not fix this file" notice);
 * this keeps them building exactly as before.
 */
export function resolveBuildContext(dockerfilePath) {
  if (path.resolve(dockerfilePath) === path.resolve(DEFAULT_DOCKERFILE)) {
    return { context: REPO_ROOT, dockerfileArg: path.relative(REPO_ROOT, DEFAULT_DOCKERFILE) };
  }
  return { context: EXECUTOR_ROOT, dockerfileArg: dockerfilePath };
}

function parseArgs(argv) {
  let dockerfile = DEFAULT_DOCKERFILE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dockerfile") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--dockerfile requires a path argument");
      }
      dockerfile = path.resolve(value);
      i++;
      continue;
    }
    throw new Error(`unrecognized argument: ${argv[i]}`);
  }
  return { dockerfile };
}

function checkDockerAvailability() {
  const result = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (!result.error && result.status === 0) {
    return { available: true };
  }
  return { available: false, message: describeDockerUnavailable(result) };
}

function inspectVolumes(tag) {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{json .Config.Volumes}}", tag], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reasons: [`could not inspect image Config.Volumes for ${tag}`] };
  }
  let volumes;
  try {
    volumes = JSON.parse((result.stdout ?? "").trim() || "null");
  } catch {
    return { ok: false, reasons: [`could not parse Config.Volumes JSON for ${tag}: ${result.stdout}`] };
  }
  return evaluateVolumes(volumes);
}

function inspectUserConfig(tag) {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Config.User}}", tag], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reasons: [`could not inspect image Config.User for ${tag}`] };
  }
  return evaluateUser((result.stdout ?? "").trim());
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const { dockerfile } = args;

  if (!existsSync(dockerfile)) {
    console.error(`FAIL: Dockerfile not found at ${dockerfile}`);
    process.exitCode = 2;
    return;
  }

  const availability = checkDockerAvailability();
  if (!availability.available) {
    // Never report PASS when the gate could not actually run.
    console.log(availability.message);
    process.exitCode = 3;
    return;
  }

  const tag = `cicd-executor-inspect:${Date.now()}-${randomBytes(4).toString("hex")}`;
  const { context, dockerfileArg } = resolveBuildContext(dockerfile);

  console.log(`Building image ${tag}`);
  console.log(`  Dockerfile: ${dockerfileArg}`);
  console.log(`  Context:    ${context}`);
  const build = spawnSync("docker", ["build", "-f", dockerfileArg, "-t", tag, context], {
    stdio: "inherit",
  });
  if (build.error || build.status !== 0) {
    console.error("FAIL: docker build failed");
    process.exitCode = 1;
    return;
  }

  try {
    const volumesVerdict = inspectVolumes(tag);
    if (!volumesVerdict.ok) {
      console.error("FAIL: image declares a forbidden volume:");
      for (const reason of volumesVerdict.reasons) console.error(`  - ${reason}`);
      process.exitCode = 1;
      return;
    }

    const userVerdict = inspectUserConfig(tag);
    if (!userVerdict.ok) {
      console.error("FAIL: image's default (non-forced) user is not safely non-root:");
      for (const reason of userVerdict.reasons) console.error(`  - ${reason}`);
      process.exitCode = 1;
      return;
    }

    const inContainerScript = buildInContainerScript();
    console.log(
      "Running boundary inspection inside the built image, forced to run as root (docker run --user 0) " +
        "so the sweep cannot silently skip a directory unreadable by the image's own non-root user; " +
        "the image's DEFAULT user was already checked separately above (Config.User).",
    );
    const run = spawnSync("docker", buildSweepRunArgs(tag, inContainerScript), { encoding: "utf8" });

    if (run.error) {
      console.error(`FAIL: could not run image ${tag}: ${run.error.message}`);
      process.exitCode = 1;
      return;
    }

    const stdout = (run.stdout ?? "").trim();
    const stderr = (run.stderr ?? "").trim();
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    const verdict = parseInspectionOutput({ stdout, exitCode: run.status });
    if (verdict.status === "PASS") {
      console.log(
        `PASS: ${tag} — no forbidden toolchain reachable via PATH, on disk (files/symlinks), or as a ` +
          "node_modules package directory (including under /app); its default user (Config.User) is non-root; " +
          "it declares no Docker-socket-capable volume (/var/run, /run, or anything naming docker.sock); and no " +
          "docker.sock is present in this run. Note: this gate inspects the image as built and runs it with no " +
          "mounts of its own — it does not simulate a real `docker run -v /var/run/docker.sock:...` host mount " +
          "made at deploy time; verify that separately before deployment.",
      );
      process.exitCode = 0;
      return;
    }

    console.error(`FAIL: boundary inspection failed for image ${tag}:`);
    for (const reason of verdict.reasons) console.error(`  - ${reason}`);
    process.exitCode = 1;
  } finally {
    spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
  }
}

// Only run the gate when this file is executed directly (`node
// scripts/inspect-image.mjs` / `npm run inspect:image`) — never as a side
// effect of importing its pure functions for unit tests.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  main();
}
