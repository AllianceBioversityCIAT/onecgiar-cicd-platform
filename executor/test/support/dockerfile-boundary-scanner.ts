// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
//
// Static scanner for the Executor's Dockerfile final stage. It is NOT a
// single regex: it parses stages, resolves `FROM <local-stage>` and
// `COPY --from=<ref>` transitively against locally defined stages (by name
// or numeric index) so a stage alias can never smuggle a forbidden image's
// toolchain in, tokenizes RUN command lines (shell AND exec form) into
// individual invocations with env-assignment/path-prefix normalization, and
// runs a set of independent rules against the final stage (and, for the
// npm/corepack/yarn removal rules, the whole local-stage inheritance chain
// the final stage is built from). Each rule has a dedicated negative
// fixture in dockerfile-boundary-scanner.test.ts proving it can fail on its
// own — this file exists because a prior single regex guard had blind spots
// a reviewer found trivially (T-01 attempt 1), and this second generation
// closed further bypasses a reviewer found against it (T-01 attempt 2:
// stage-alias smuggling, inherited-stage npm survival, multi-USER
// last-wins, package-manager invocation normalization, yarn under /opt).
//
// Real image inspection (building the image and running `find`/`id` inside
// it — see scripts/inspect-image.mjs) remains the authoritative gate; this
// scanner is the best static pre-check without a reachable Docker daemon.

export interface Violation {
  readonly rule: string;
  readonly detail: string;
}

export interface DockerStage {
  readonly index: number;
  readonly name: string | undefined;
  readonly baseImage: string;
  /** Raw instruction text of this stage, comment-only lines stripped, line continuations joined. */
  readonly text: string;
}

/**
 * Joins Dockerfile line continuations (`\` at end of line) into single
 * logical lines, then drops comment-only lines. Preserves line order
 * otherwise so FROM detection stays simple.
 */
function logicalLines(dockerfileText: string): string[] {
  const rawLines = dockerfileText.split(/\r?\n/);
  const joined: string[] = [];
  let buffer = "";
  for (const rawLine of rawLines) {
    const line = buffer ? buffer + rawLine : rawLine;
    if (/\\\s*$/.test(line)) {
      buffer = line.replace(/\\\s*$/, "");
      continue;
    }
    buffer = "";
    joined.push(line);
  }
  if (buffer) {
    joined.push(buffer);
  }
  return joined.filter((line) => !/^\s*#/.test(line));
}

// Tolerates `FROM --platform=<...> <image>` — without this, the platform
// flag was captured as the "image" and the real image name (and any `AS
// <name>`) silently fell off the parse (T-01 attempt 2 review, issue 1).
const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i;

export function splitStages(dockerfileText: string): DockerStage[] {
  const lines = logicalLines(dockerfileText);
  const stages: DockerStage[] = [];
  let current: { name: string | undefined; baseImage: string; lines: string[] } | undefined;

  for (const line of lines) {
    const fromMatch = FROM_RE.exec(line);
    if (fromMatch) {
      if (current) {
        stages.push({
          index: stages.length,
          name: current.name,
          baseImage: current.baseImage,
          text: current.lines.join("\n"),
        });
      }
      current = {
        name: fromMatch[2]?.toLowerCase(),
        baseImage: fromMatch[1] ?? "",
        lines: [line],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    stages.push({
      index: stages.length,
      name: current.name,
      baseImage: current.baseImage,
      text: current.lines.join("\n"),
    });
  }
  return stages;
}

export function finalStage(dockerfileText: string): DockerStage {
  const stages = splitStages(dockerfileText);
  const last = stages[stages.length - 1];
  if (!last) {
    throw new Error("Dockerfile has no FROM instruction");
  }
  return last;
}

function stageKey(stage: DockerStage): string {
  return stage.name ?? `#${stage.index}`;
}

interface ChainResolution {
  /** [stage, ...ancestors] following local `FROM <stage-name>` aliases. */
  readonly chain: DockerStage[];
  /** The last resolvable base image reference; may still contain a `$` if unresolved. */
  readonly rootImage: string;
}

/**
 * Follows `FROM <local-stage-name>` aliasing transitively to the ultimate
 * external base image. A final stage that is itself `FROM builder AS
 * runtime` inherits builder's ENTIRE filesystem (not just copied paths), so
 * anything builder did — including never removing npm — ships in the final
 * image too (T-01 attempt 2 review, issue 2). Stops (without throwing) on a
 * `${...}` variable reference it cannot statically resolve; callers must
 * treat that as fail-closed, not as "no forbidden base found".
 */
function resolveChain(start: DockerStage, stageByName: ReadonlyMap<string, DockerStage>): ChainResolution {
  const chain: DockerStage[] = [start];
  const visited = new Set<string>([stageKey(start)]);
  let current = start;
  for (;;) {
    const base = current.baseImage.trim();
    if (/\$/.test(base)) {
      return { chain, rootImage: base };
    }
    const parent = stageByName.get(base.toLowerCase());
    if (!parent) {
      return { chain, rootImage: base };
    }
    const key = stageKey(parent);
    if (visited.has(key)) {
      // Cyclical FROM graph: not a valid Dockerfile: stop and fail closed.
      return { chain, rootImage: `${parent.baseImage}$` };
    }
    visited.add(key);
    chain.push(parent);
    current = parent;
  }
}

// Image references (FROM .../COPY --from=...) that must never appear,
// matched against the image name itself (not the whole line, so
// "FROM node:22-slim" never collides with an unrelated word elsewhere).
const FORBIDDEN_IMAGE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "docker CLI/daemon image", pattern: /docker/i },
  { label: "maven build image", pattern: /maven/i },
  { label: "gradle build image", pattern: /gradle/i },
  { label: "openjdk/temurin JDK image", pattern: /(openjdk|temurin|\bjdk\b)/i },
  { label: "python build image", pattern: /python/i },
];

function scanImageReferences(
  stage: DockerStage,
  stages: readonly DockerStage[],
  stageByName: ReadonlyMap<string, DockerStage>,
): Violation[] {
  const violations: Violation[] = [];

  const checkImageRef = (ref: string, source: string) => {
    if (/\$/.test(ref)) {
      violations.push({
        rule: "unresolved-base-image",
        detail: `${source} references an unresolved variable ("${ref}"); cannot statically verify it is not a forbidden toolchain image — failing closed`,
      });
      return;
    }
    const bare = ref.split("@")[0] ?? ref; // drop @sha256:... digest before matching name
    const name = bare.split(":")[0] ?? bare;
    for (const { label, pattern } of FORBIDDEN_IMAGE_PATTERNS) {
      if (pattern.test(name)) {
        violations.push({ rule: `forbidden-image:${label}`, detail: `${source} references forbidden image "${ref}"` });
      }
    }
  };

  // The stage's own FROM, resolved transitively through local stage aliases
  // (a final stage that is `FROM builder AS runtime` is checked against
  // builder's own root image, not the meaningless local name "builder").
  const ownResolution = resolveChain(stage, stageByName);
  const ownSource =
    ownResolution.chain.length > 1 ? `FROM (resolved from "${stage.baseImage}")` : "FROM";
  checkImageRef(ownResolution.rootImage, ownSource);

  // COPY --from=<ref> — if <ref> names a local stage (by name or numeric
  // index), resolve THAT stage transitively to its own root image before
  // checking it, instead of exempting every local-looking reference
  // outright (T-01 attempt 2 review, issue 1: `COPY --from=tools` where
  // `tools` is `FROM docker:27-cli` went undetected).
  const copyFromRe = /COPY\s+(?:[^\n]*?\s)?--from=(\S+)/gi;
  let match: RegExpExecArray | null;
  while ((match = copyFromRe.exec(stage.text)) !== null) {
    const ref = match[1] ?? "";
    if (/\$/.test(ref)) {
      violations.push({
        rule: "unresolved-base-image",
        detail: `COPY --from references an unresolved variable ("${ref}"); cannot statically verify its origin — failing closed`,
      });
      continue;
    }
    const byName = stageByName.get(ref.toLowerCase());
    const byIndex = /^\d+$/.test(ref) ? stages[Number(ref)] : undefined;
    const target = byName ?? byIndex;
    if (target) {
      const targetResolution = resolveChain(target, stageByName);
      checkImageRef(targetResolution.rootImage, `COPY --from=${ref} (resolves to "${targetResolution.rootImage}")`);
    } else {
      checkImageRef(ref, "COPY --from");
    }
  }

  return violations;
}

// Package names that must never be installed in the final stage, matched
// against apt-get/apk/pip install argument lists.
const FORBIDDEN_PACKAGE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "docker package", pattern: /\bdocker(\.io|-ce(-cli)?|-cli)?\b/i },
  { label: "maven package", pattern: /\b(maven|mvn)\b/i },
  { label: "gradle package", pattern: /\bgradle\b/i },
  // The Executor holds no git client (definitions are bundled, DD-19): git must not ship in the runtime image (AC2).
  { label: "git package", pattern: /\bgit\b/i },
  {
    label: "JDK package",
    pattern: /\b(default-jdk|default-jre|temurin[\w.-]*|openjdk[\w.-]*|java-\d+-openjdk|java-\d+-jdk|\bjdk\b)\b/i,
  },
  {
    label: "python build toolchain package",
    pattern: /\b(python3?-dev|python3?-pip|build-essential|setuptools)\b/i,
  },
];

function scanPackageInstalls(stage: DockerStage): Violation[] {
  const violations: Violation[] = [];
  for (const { label, pattern } of FORBIDDEN_PACKAGE_PATTERNS) {
    if (pattern.test(stage.text)) {
      violations.push({ rule: `forbidden-package:${label}`, detail: `final stage installs ${label}` });
    }
  }
  return violations;
}

function scanRemoteInstallerScripts(stage: DockerStage): Violation[] {
  const violations: Violation[] = [];
  if (/get\.docker\.com/i.test(stage.text)) {
    violations.push({ rule: "remote-docker-installer", detail: "final stage fetches get.docker.com" });
  }
  if (/pip3?\s+install/i.test(stage.text)) {
    violations.push({ rule: "pip-install", detail: "final stage runs pip install" });
  }
  if (/(curl|wget)\s+[^\n|]*\|\s*(sh|bash)\b/i.test(stage.text)) {
    violations.push({
      rule: "piped-remote-script",
      detail: "final stage pipes a downloaded script straight into a shell",
    });
  }
  if (/docker\.sock/i.test(stage.text)) {
    violations.push({ rule: "docker-socket-reference", detail: "final stage references docker.sock" });
  }
  return violations;
}

const NODE_PACKAGE_MANAGER_BINARIES = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack"]);

function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

/**
 * Strips leading `KEY=value` env assignments and a leading `env` command
 * (repeatable: `env FOO=bar BAZ=qux npm ci`) so the real invoked command is
 * exposed — `NODE_ENV=production npm ci` must be recognized as invoking
 * `npm`, not as invoking the literal token `NODE_ENV=production` (T-01
 * attempt 2 review, issue 4).
 */
function stripEnvPrefix(segment: string): string {
  let rest = segment;
  for (;;) {
    const assign = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
    if (assign) {
      rest = rest.slice(assign[0].length).trimStart();
      continue;
    }
    const envCmd = /^env\s+/.exec(rest);
    if (envCmd) {
      rest = rest.slice(envCmd[0].length).trimStart();
      continue;
    }
    break;
  }
  return rest;
}

/**
 * Returns the basename of the binary each invocation in a RUN instruction
 * actually executes — handling shell form (`&&`/`;`/`|`-separated, with env
 * prefixes and absolute paths like `/usr/local/bin/npm`) and exec form
 * (`RUN ["npm", "ci"]`), which a prior version did not parse at all.
 */
function extractInvokedBinaries(runBody: string): string[] {
  const trimmed = runBody.trim();
  if (/^\[.*\]$/.test(trimmed)) {
    try {
      const argv: unknown = JSON.parse(trimmed);
      if (Array.isArray(argv) && typeof argv[0] === "string") {
        return [basename(argv[0])];
      }
    } catch {
      // Malformed exec-form JSON: nothing we can safely attribute.
    }
    return [];
  }

  const binaries: string[] = [];
  for (const rawSegment of trimmed.split(/&&|;|\|/)) {
    const segment = stripEnvPrefix(rawSegment.trim());
    if (!segment) continue;
    const firstToken = segment.split(/\s+/)[0] ?? "";
    if (firstToken) binaries.push(basename(firstToken));
  }
  return binaries;
}

const RUN_LINE_RE = /^\s*RUN\s+(.*)$/i;

function scanPackageManagerInvocations(stage: DockerStage): Violation[] {
  const violations: Violation[] = [];
  for (const line of stage.text.split("\n")) {
    const match = RUN_LINE_RE.exec(line);
    if (!match) continue;
    for (const binary of extractInvokedBinaries(match[1] ?? "")) {
      const lower = binary.toLowerCase();
      if (NODE_PACKAGE_MANAGER_BINARIES.has(lower)) {
        violations.push({
          rule: `node-package-manager-invocation:${lower}`,
          detail: `final stage invokes "${binary}" (line: "${line.trim()}")`,
        });
      }
    }
  }
  return violations;
}

/**
 * Collects every path argument passed to an `rm` invocation across a
 * stage's RUN instructions (env/path-prefix normalized the same way as
 * invocation scanning), so removal can be checked against exact canonical
 * paths rather than a loose "does the word npm appear near rm" match that a
 * `rm -rf /root/.npm /tmp/corepack-cache` cache cleanup could satisfy
 * without removing the actual binaries (T-01 attempt 2 review, issue 4).
 */
function extractRemovedPaths(text: string): Set<string> {
  const removed = new Set<string>();
  for (const line of text.split("\n")) {
    const match = RUN_LINE_RE.exec(line);
    if (!match) continue;
    const body = (match[1] ?? "").trim();
    if (/^\[.*\]$/.test(body)) continue; // exec-form `rm` is not a supported removal idiom here
    for (const rawSegment of body.split(/&&|;|\|/)) {
      const segment = stripEnvPrefix(rawSegment.trim());
      if (!segment) continue;
      const tokens = segment.split(/\s+/);
      const command = basename(tokens[0] ?? "");
      if (command !== "rm") continue;
      for (const token of tokens.slice(1)) {
        if (token.startsWith("-")) continue; // flag, not a path
        const normalized = token.replace(/\/+$/, "");
        if (normalized) removed.add(normalized);
      }
    }
  }
  return removed;
}

interface RemovalTarget {
  readonly rule: string;
  readonly detail: string;
  readonly isSatisfied: (removedPaths: ReadonlySet<string>) => boolean;
}

// What a stock `node` base image ships that the shipped runtime stage must
// not retain. Each target checks for the EXACT canonical path(s) `rm`'d,
// not a substring match, and yarn (installed by the upstream Node image
// under /opt/yarn-<version>, only *symlinked* into /usr/local/bin) requires
// its own rule: removing only the symlinks leaves the toolchain on disk
// (T-01 attempt 2 review, issue 5).
const REMOVAL_TARGETS: readonly RemovalTarget[] = [
  {
    rule: "npm-not-removed",
    detail:
      'final stage\'s base image ships npm but does not remove it (expected "rm" of /usr/local/bin/npm and /usr/local/lib/node_modules/npm)',
    isSatisfied: (paths) => paths.has("/usr/local/bin/npm") && paths.has("/usr/local/lib/node_modules/npm"),
  },
  {
    rule: "npx-not-removed",
    detail: 'final stage\'s base image ships npx but does not remove /usr/local/bin/npx',
    isSatisfied: (paths) => paths.has("/usr/local/bin/npx"),
  },
  {
    rule: "corepack-not-removed",
    detail:
      'final stage\'s base image ships corepack but does not remove it (expected "rm" of /usr/local/bin/corepack and /usr/local/lib/node_modules/corepack)',
    isSatisfied: (paths) => paths.has("/usr/local/bin/corepack") && paths.has("/usr/local/lib/node_modules/corepack"),
  },
  {
    rule: "yarn-not-removed",
    detail:
      'final stage\'s base image ships yarn installed under /opt/yarn-<version> with /usr/local/bin symlinks — removing only the symlinks leaves the toolchain on disk; expected an "rm" targeting /opt/yarn-*',
    isSatisfied: (paths) => [...paths].some((p) => /^\/opt\/yarn(-|$)/.test(p)),
  },
];

/**
 * When the final stage's RESOLVED root base image (following local `FROM
 * <stage>` aliases) is a stock Node image, the whole inheritance chain —
 * not just the final stage's own instructions — must collectively remove
 * npm/npx/corepack/yarn, because `FROM builder AS runtime` ships builder's
 * entire filesystem, not just what `runtime` itself declares.
 */
function scanNpmRemovalRequired(rootImage: string, combinedChainText: string): Violation[] {
  const isNodeBase = /^node(\b|[:@])/i.test(rootImage.trim());
  if (!isNodeBase) {
    return [];
  }
  const removedPaths = extractRemovedPaths(combinedChainText);
  const violations: Violation[] = [];
  for (const target of REMOVAL_TARGETS) {
    if (!target.isSatisfied(removedPaths)) {
      violations.push({ rule: target.rule, detail: target.detail });
    }
  }
  return violations;
}

// Global, not just the first match: Docker honors the LAST `USER` in a
// stage, so `USER executor` followed later by `USER root` runs as root —
// a non-global regex only ever saw the first instruction (T-01 attempt 2
// review, issue 3).
const USER_RE = /^\s*USER\s+(\S+)/gim;

function scanRootUser(stage: DockerStage): Violation[] {
  const matches = [...stage.text.matchAll(USER_RE)];
  const last = matches[matches.length - 1];
  if (!last) {
    return [{ rule: "no-user-instruction", detail: "final stage never switches away from the default root user" }];
  }
  const value = (last[1] ?? "").split(":")[0] ?? "";
  if (value === "0" || value.toLowerCase() === "root") {
    return [{ rule: "root-user", detail: `final stage runs as root (USER ${last[1]})` }];
  }
  return [];
}

export function scanFinalStage(dockerfileText: string): Violation[] {
  const stages = splitStages(dockerfileText);
  const stage = stages[stages.length - 1];
  if (!stage) {
    return [{ rule: "no-stages", detail: "Dockerfile has no FROM instruction" }];
  }

  const stageByName = new Map<string, DockerStage>();
  for (const s of stages) {
    if (s.name) stageByName.set(s.name.toLowerCase(), s);
  }

  const resolution = resolveChain(stage, stageByName);
  const combinedChainText = resolution.chain.map((s) => s.text).join("\n");

  return [
    ...scanImageReferences(stage, stages, stageByName),
    ...scanPackageInstalls(stage),
    ...scanRemoteInstallerScripts(stage),
    ...scanPackageManagerInvocations(stage),
    ...scanNpmRemovalRequired(resolution.rootImage, combinedChainText),
    ...scanRootUser(stage),
  ];
}
