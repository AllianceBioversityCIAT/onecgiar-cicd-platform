// @akili-spec changes/cicd-executor-poc design DD-19, §6.6
// AWS-free but fs-touching adapter: scans pipeline-definitions/**/*.yaml and
// extracts the subset the webhook mapping needs for definitions carrying a
// `github-push` trigger. Mirrors executor/src/adapters/bundled-definition-source
// (DD-19: PoC bundles definitions into the image) but is reimplemented here
// rather than imported, because that port only resolves one already-known
// pipelineId (`getPipelineDefinition(pipelineId)`) and has no "list every
// definition" capability — see core/ports.ts's PipelineDefinitionReader doc.
// This is the ONLY file in this package that touches fs/yaml; the core
// (src/core/handle-webhook.ts) never does.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GithubPushPipelineDefinition, PipelineDefinitionReader } from "../core/ports.js";

export class PipelineDefinitionReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineDefinitionReaderError";
  }
}

/** Walks up from `startDir` for the first ancestor containing `pipeline-definitions/` (same convention as DD-19's bundled adapter). */
export function findPipelineDefinitionsRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, "pipeline-definitions"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new PipelineDefinitionReaderError(
    `could not locate the platform repo root (a directory containing "pipeline-definitions/") walking up from ${startDir}`,
  );
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

interface RawTrigger {
  readonly type?: unknown;
}

interface RawRepository {
  readonly url?: unknown;
  readonly branch?: unknown;
}

interface RawPipelineDefinition {
  readonly pipelineId?: unknown;
  readonly environment?: unknown;
  readonly repository?: RawRepository;
  readonly triggers?: readonly RawTrigger[];
}

function toGithubPushDefinition(parsed: unknown): GithubPushPipelineDefinition | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const def = parsed as RawPipelineDefinition;
  if (typeof def.pipelineId !== "string") return undefined;
  if (def.environment !== "dev") return undefined;
  if (!Array.isArray(def.triggers) || !def.triggers.some((t) => t && t.type === "github-push")) return undefined;
  const repository = def.repository;
  if (!repository || typeof repository.url !== "string" || typeof repository.branch !== "string") return undefined;
  return {
    pipelineId: def.pipelineId,
    repositoryUrl: repository.url,
    branch: repository.branch,
    environment: "dev",
  };
}

export interface YamlPipelineDefinitionReaderOptions {
  /** Override the computed pipeline-definitions root (tests only). */
  readonly pipelineDefinitionsRoot?: string;
}

/**
 * NOTE (publication policy, DD-23): the committed YAML's `repository.url`
 * is a logical ref like `<PRMS_REPORTING_REPO_URL>`, not a real GitHub URL.
 * This reader returns whatever string is in `repository.url`/`branch`
 * verbatim — it does not resolve logical refs. Resolving a ref to the
 * actual value a live webhook payload will carry is a deployment-time
 * concern (Gate B, T-30), implemented as a decorator wrapping
 * `PipelineDefinitionReader` (same port, ref-resolving read), not as a
 * change to this adapter or to the core's matching logic, which is unaware
 * of (and does not need to know about) ref resolution either way.
 */
export class YamlPipelineDefinitionReader implements PipelineDefinitionReader {
  private readonly dir: string;

  constructor(options: YamlPipelineDefinitionReaderOptions = {}) {
    const root = options.pipelineDefinitionsRoot ?? findPipelineDefinitionsRoot(process.cwd());
    this.dir = path.join(root, "pipeline-definitions");
  }

  async listGithubPushDefinitions(): Promise<readonly GithubPushPipelineDefinition[]> {
    const files = await listYamlFilesRecursively(this.dir);
    const out: GithubPushPipelineDefinition[] = [];
    for (const filePath of files) {
      let parsed: unknown;
      try {
        parsed = parseYaml(await readFile(filePath, "utf8"));
      } catch {
        continue;
      }
      const def = toGithubPushDefinition(parsed);
      if (def) out.push(def);
    }
    return out;
  }
}
