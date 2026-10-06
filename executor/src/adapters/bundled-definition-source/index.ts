// @akili-spec changes/cicd-executor-poc design §4.2, §7, DD-19
// DefinitionSource implementation reading files bundled into the image
// (PoC simplification, DD-19): `deployment-definitions/`, `schemas/` and
// `deploy-scripts/` at the platform repo root. Nothing outside this file
// knows these are files on disk — the core only sees the DefinitionSource
// port (ports/definition-source.ts).
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { DefinitionContent, DefinitionSource } from "../../ports/definition-source.js";

/**
 * Clearly-labelled dev fallback (DD-19: "definitionRef = the platform repo's
 * commit, injected at build time"). A real production build MUST
 * inject the commit via CICD_DEFINITION_REF (the Dockerfile's
 * `--build-arg DEFINITION_REF`); this value only appears in non-production
 * runs (local dev / tests), and its name makes that unambiguous in any
 * execution record it gets written into. In production (NODE_ENV=production)
 * a missing CICD_DEFINITION_REF is a hard startup error instead — see
 * `resolveDefinitionRef` — never this silent sentinel (FR-01: definitionRef
 * must be recorded per execution).
 */
export const DEV_FALLBACK_DEFINITION_REF = "UNVERIFIED-dev-local-no-commit-injected";

export class DefinitionSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionSourceError";
  }
}

/** Relative path (from the definitions root) of the target registry: the only definition file allowed to carry no `deploymentId`. */
export const TARGET_REGISTRY_RELATIVE_PATH = path.join("deployment-definitions", "targets", "dev.yaml");

/** One unusable definition file: its path relative to the definitions root and a reason that never echoes file content. */
export interface DefinitionProblem {
  readonly file: string;
  readonly reason: string;
}

export interface DefinitionScan {
  readonly deployments: readonly { readonly deploymentId: string; readonly file: string }[];
  readonly problems: readonly DefinitionProblem[];
}

/** Thrown when the definition set is not fully loadable: carries EVERY problem at once (fail fast, owner decision 2026-10-06). */
export class DefinitionLoadError extends DefinitionSourceError {
  constructor(readonly problems: readonly DefinitionProblem[]) {
    super(`refusing to start: ${problems.length} definition file(s) cannot be loaded: ${problems.map((p) => `${p.file}: ${p.reason}`).join("; ")}`);
    this.name = "DefinitionLoadError";
  }
}

export interface BundledDefinitionSourceOptions {
  /** Override the computed repo root (tests only). Takes priority over CICD_DEFINITIONS_ROOT and the walk-up. */
  readonly repoRoot?: string;
  /** Override environment lookup (tests only); defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override whether a missing CICD_DEFINITION_REF is a startup error (tests only); defaults to `env.NODE_ENV === "production"`. */
  readonly requireInjectedRef?: boolean;
}

/**
 * Walks up from `startDir` looking for the platform repo root: the first
 * ancestor that contains both `deployment-definitions/` and `schemas/`. This
 * makes no assumption about exact nesting depth, so it works unchanged
 * whether running from `executor/src` in dev or from wherever the built
 * image lays these directories out.
 *
 * This is a DEV FALLBACK only. The real image sets `CICD_DEFINITIONS_ROOT`
 * explicitly (Dockerfile runtime stage) to where `deployment-definitions/`,
 * `schemas/` and `deploy-scripts/` are actually copied (DD-19) — see the
 * constructor below, which only falls back to this walk-up when that env
 * var is absent.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, "deployment-definitions")) && existsSync(path.join(dir, "schemas"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new DefinitionSourceError(
    `could not locate the platform repo root (a directory containing both "deployment-definitions/" and "schemas/") walking up from ${startDir}`,
  );
}

/**
 * design DD-19 ("definitionRef = commit ... injected at build time") + FR-01
 * (definitionRef recorded per execution): in production, a missing injected
 * ref is a startup error — it is never acceptable to silently run with the
 * dev sentinel as if it were a real commit. `requireInjectedRef` defaults to
 * `env.NODE_ENV === "production"` (the Dockerfile sets exactly that), so
 * tests and local dev keep the dev fallback unless they opt in explicitly.
 */
function resolveDefinitionRef(env: NodeJS.ProcessEnv, requireInjectedRef: boolean): string {
  const fromEnv = env.CICD_DEFINITION_REF;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  if (requireInjectedRef) {
    throw new DefinitionSourceError(
      "refusing to start: no CICD_DEFINITION_REF was injected and requireInjectedRef is set " +
        '(NODE_ENV=production by default). Build the image with `--build-arg DEFINITION_REF=$(git rev-parse HEAD)` ' +
        "(design DD-19) — the Executor must never run in production with an unverified definitionRef (FR-01).",
    );
  }

  return DEV_FALLBACK_DEFINITION_REF;
}

/**
 * Strict walk of `deployment-definitions/` (trusted configuration, owner decision 2026-10-06): every entry must be a
 * regular directory or a regular file named `*.yaml` / `*.yml` (lowercase). Anything else is reported as a problem
 * instead of being skipped, so no definition can be silently ignored. Paths in problems are relative to `rootDir`.
 */
async function walkDefinitions(dir: string, rootDir: string, files: string[], problems: DefinitionProblem[]): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const file = path.relative(rootDir, full);
    if (entry.isSymbolicLink()) problems.push({ file, reason: "unsupported entry type (symbolic link)" });
    else if (entry.isDirectory()) await walkDefinitions(full, rootDir, files, problems);
    else if (!entry.isFile()) problems.push({ file, reason: "unsupported entry type" });
    else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) files.push(full);
    else if (/\.ya?ml$/i.test(entry.name)) problems.push({ file, reason: "definition files must use the lowercase .yaml or .yml extension" });
    else problems.push({ file, reason: "unexpected file in deployment-definitions/ (only .yaml/.yml definition files are allowed)" });
  }
}

async function listYamlFilesRecursively(dir: string): Promise<string[]> {
  const files: string[] = [];
  await walkDefinitions(dir, path.dirname(dir), files, []);
  return files;
}

/**
 * Finds the file declaring `deploymentId` by scanning `deployment-definitions/`
 * and reading each YAML file's own `deploymentId` field — NOT by assuming any
 * per-project directory convention (NFR-01: no per-project logic in the
 * Executor). Non-matching files are skipped HERE only because
 * `listDeploymentIds` (run at startup) already rejects any unparsable or
 * id-less definition file, so no invalid file reaches this lookup.
 */
async function findDeploymentDefinitionPath(deploymentDefinitionsDir: string, deploymentId: string): Promise<string> {
  const files = await listYamlFilesRecursively(deploymentDefinitionsDir);
  const matches: string[] = [];
  for (const filePath of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(await readFile(filePath, "utf8"));
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).deploymentId === deploymentId
    ) {
      matches.push(filePath);
    }
  }
  if (matches.length > 1) {
    // Single-source invariant (DD-27): a deploymentId is bound to exactly one definition.
    throw new DefinitionSourceError(
      `more than one definition declares deploymentId "${deploymentId}" under ${deploymentDefinitionsDir} (DD-27: one definition per deploymentId)`,
    );
  }
  if (matches.length === 1) return matches[0]!;
  throw new DefinitionSourceError(
    `no deployment definition found for deploymentId "${deploymentId}" under ${deploymentDefinitionsDir}`,
  );
}

export class BundledDefinitionSource implements DefinitionSource {
  private readonly repoRoot: string;
  private readonly definitionRef: string;

  constructor(options: BundledDefinitionSourceOptions = {}) {
    const env = options.env ?? process.env;
    const rootFromEnv = env.CICD_DEFINITIONS_ROOT?.trim();
    const here = path.dirname(fileURLToPath(import.meta.url));
    this.repoRoot = options.repoRoot ?? (rootFromEnv && rootFromEnv.length > 0 ? rootFromEnv : findRepoRoot(here));
    const requireInjectedRef = options.requireInjectedRef ?? env.NODE_ENV === "production";
    this.definitionRef = resolveDefinitionRef(env, requireInjectedRef);
  }

  async getDeploymentDefinition(deploymentId: string): Promise<DefinitionContent> {
    const dir = path.join(this.repoRoot, "deployment-definitions");
    const filePath = await findDeploymentDefinitionPath(dir, deploymentId);
    return { content: await readFile(filePath, "utf8"), definitionRef: this.definitionRef };
  }

  /**
   * Parses EVERY yaml file under `deployment-definitions/` and reports all problems at once (it does not throw for content problems).
   * Used by `listDeploymentIds` (which fails fast) and by the offline `definitions:check` preflight.
   */
  async scanDefinitions(): Promise<DefinitionScan> {
    const found: string[] = [];
    const problems: DefinitionProblem[] = [];
    await walkDefinitions(path.join(this.repoRoot, "deployment-definitions"), this.repoRoot, found, problems);
    const files = found.sort();
    const deployments: { deploymentId: string; file: string }[] = [];
    const seen = new Map<string, string>();
    for (const filePath of files) {
      const file = path.relative(this.repoRoot, filePath);
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        problems.push({ file, reason: `cannot read file${typeof code === "string" ? ` (${code})` : ""}` });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseYaml(text);
      } catch (error) {
        // Only the parser's code and position: the message of a YAML error quotes file content.
        const e = error as { code?: unknown; linePos?: readonly { line: number; col: number }[] };
        const pos = e.linePos?.[0];
        problems.push({ file, reason: `YAML parse error${typeof e.code === "string" ? ` (${e.code})` : ""}${pos ? ` at line ${pos.line}, column ${pos.col}` : ""}` });
        continue;
      }
      const id = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).deploymentId : undefined;
      if (typeof id === "string") {
        const first = seen.get(id);
        if (first !== undefined) {
          problems.push({ file, reason: `duplicate deploymentId "${id}", already declared in ${first} (DD-27: one definition per deploymentId)` });
          continue;
        }
        seen.set(id, file);
        deployments.push({ deploymentId: id, file });
      } else if (file !== TARGET_REGISTRY_RELATIVE_PATH) {
        problems.push({ file, reason: `parsed, but declares no string deploymentId and is not the target registry (${TARGET_REGISTRY_RELATIVE_PATH})` });
      }
    }
    return { deployments, problems };
  }

  /**
   * Every `deploymentId` declared under `deployment-definitions/`. Fails fast (owner decision 2026-10-06): a file that cannot be
   * parsed, a non-registry file without a `deploymentId` or a duplicate id throws a `DefinitionLoadError` listing ALL problems.
   * Startup validates ALL of the ids (design §6.2); this enumeration is a property of this adapter, not of the `DefinitionSource` port.
   */
  async listDeploymentIds(): Promise<string[]> {
    const { deployments, problems } = await this.scanDefinitions();
    if (problems.length > 0) throw new DefinitionLoadError(problems);
    return deployments.map((d) => d.deploymentId).sort();
  }

  async getTargetRegistry(): Promise<DefinitionContent> {
    // NFR-09: the PoC is DEV-only — a single registry file, no per-environment selection logic.
    const filePath = path.join(this.repoRoot, TARGET_REGISTRY_RELATIVE_PATH);
    if (!existsSync(filePath)) {
      throw new DefinitionSourceError(`target registry not found at ${filePath}`);
    }
    return { content: await readFile(filePath, "utf8"), definitionRef: this.definitionRef };
  }

  async getSchema(schemaName: string): Promise<DefinitionContent> {
    const filePath = path.join(this.repoRoot, "schemas", schemaName);
    if (!existsSync(filePath)) {
      throw new DefinitionSourceError(`schema not found: "${schemaName}" (looked in ${filePath})`);
    }
    return { content: await readFile(filePath, "utf8"), definitionRef: this.definitionRef };
  }

  async getDeployScript(scriptName: string): Promise<DefinitionContent> {
    const filePath = path.join(this.repoRoot, "deploy-scripts", scriptName);
    if (!existsSync(filePath)) {
      throw new DefinitionSourceError(`deploy script not found: "${scriptName}" (looked in ${filePath})`);
    }
    return { content: await readFile(filePath, "utf8"), definitionRef: this.definitionRef };
  }
}
