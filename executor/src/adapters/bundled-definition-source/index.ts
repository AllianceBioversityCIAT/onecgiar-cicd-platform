// @akili-spec changes/cicd-executor-poc design §4.2, §7, DD-19
// DefinitionSource implementation reading files bundled into the image
// (PoC simplification, DD-19): `pipeline-definitions/`, `schemas/` and
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
 * ancestor that contains both `pipeline-definitions/` and `schemas/`. This
 * makes no assumption about exact nesting depth, so it works unchanged
 * whether running from `executor/src` in dev or from wherever the built
 * image lays these directories out.
 *
 * This is a DEV FALLBACK only. The real image sets `CICD_DEFINITIONS_ROOT`
 * explicitly (Dockerfile runtime stage) to where `pipeline-definitions/`,
 * `schemas/` and `deploy-scripts/` are actually copied (DD-19) — see the
 * constructor below, which only falls back to this walk-up when that env
 * var is absent.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, "pipeline-definitions")) && existsSync(path.join(dir, "schemas"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new DefinitionSourceError(
    `could not locate the platform repo root (a directory containing both "pipeline-definitions/" and "schemas/") walking up from ${startDir}`,
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

async function listYamlFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listYamlFilesRecursively(full)));
    } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Finds the file declaring `pipelineId` by scanning `pipeline-definitions/`
 * and reading each YAML file's own `pipelineId` field — NOT by assuming any
 * per-project directory convention (NFR-01: no per-project logic in the
 * Executor). A file that fails to parse, or has no matching `pipelineId`,
 * is silently skipped (e.g. `pipeline-definitions/targets/dev.yaml`, which
 * has no `pipelineId` field at all).
 */
async function findPipelineDefinitionPath(pipelineDefinitionsDir: string, pipelineId: string): Promise<string> {
  const files = await listYamlFilesRecursively(pipelineDefinitionsDir);
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
      (parsed as Record<string, unknown>).pipelineId === pipelineId
    ) {
      return filePath;
    }
  }
  throw new DefinitionSourceError(
    `no pipeline definition found for pipelineId "${pipelineId}" under ${pipelineDefinitionsDir}`,
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

  async getPipelineDefinition(pipelineId: string): Promise<DefinitionContent> {
    const dir = path.join(this.repoRoot, "pipeline-definitions");
    const filePath = await findPipelineDefinitionPath(dir, pipelineId);
    return { content: await readFile(filePath, "utf8"), definitionRef: this.definitionRef };
  }

  async getTargetRegistry(): Promise<DefinitionContent> {
    // NFR-09: the PoC is DEV-only — a single registry file, no per-environment selection logic.
    const filePath = path.join(this.repoRoot, "pipeline-definitions", "targets", "dev.yaml");
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
