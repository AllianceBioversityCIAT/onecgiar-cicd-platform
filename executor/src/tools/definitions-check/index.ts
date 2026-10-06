// @akili-spec changes/cicd-executor-poc design §6.2, §7 (definition-service row), DD-19, NFR-01
// Offline definitions check for the owner: runs the structure-only CI validation
// (`validateForCi`) over every deployment found under a LOCAL definitions root
// before the Executor is started. No SecretProvider, no network, no AWS, and no
// reference is ever resolved (only logical references are present or printed).
// This module is a developer tool: nothing in the Executor's runtime path
// imports it.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { DefinitionValidationError, validateForCi, type ValidationIssue } from "../../application/definition-service/index.js";
import { BundledDefinitionSource, findRepoRoot } from "../../adapters/bundled-definition-source/index.js";
import type { DefinitionContent, DefinitionSource } from "../../ports/definition-source.js";

export interface DefinitionsCheckDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Repository root providing `schemas/` and `deploy-scripts/` when the checked root has none (tests may override). */
  readonly fallbackRoot?: string;
}

const USAGE = "usage: definitions:check --root <dir>   (<dir> contains deployment-definitions/; schemas/ defaults to the repository's own copy when absent)";
const REGISTRY_FILE = path.join("deployment-definitions", "targets", "dev.yaml");

function parseRoot(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--root");
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") || value.trim() === "" ? undefined : value;
}

async function yamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await yamlFiles(full)));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface ScanResult {
  readonly files: Map<string, string>;
  readonly problems: string[];
}

/**
 * Scans EVERY yaml file under `deployment-definitions/` (the adapter's enumeration silently skips unparsable files, which would be a false green).
 * Also maps each deploymentId to its file for display. Problems never echo file content: only the relative path, the parser's code and position.
 */
async function scanDefinitionFiles(root: string): Promise<ScanResult> {
  const files = new Map<string, string>();
  const problems: string[] = [];
  for (const file of (await yamlFiles(path.join(root, "deployment-definitions"))).sort()) {
    const rel = path.relative(root, file);
    let parsed: unknown;
    try {
      parsed = parseYaml(await readFile(file, "utf8"));
    } catch (error) {
      const e = error as { code?: unknown; linePos?: readonly { line: number; col: number }[] };
      const pos = e.linePos?.[0];
      problems.push(`${rel}: YAML parse error${typeof e.code === "string" ? ` (${e.code})` : ""}${pos ? ` at line ${pos.line}, column ${pos.col}` : ""}`);
      continue;
    }
    const id = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["deploymentId"] : undefined;
    if (typeof id === "string") files.set(id, rel);
    else if (rel !== REGISTRY_FILE) problems.push(`${rel}: parsed, but declares no deploymentId and is not the target registry (${REGISTRY_FILE})`);
  }
  return { files, problems };
}

function bundled(repoRoot: string): BundledDefinitionSource {
  return new BundledDefinitionSource({ repoRoot, env: {}, requireInjectedRef: false });
}

/** Definitions come from `root`; schemas come from `root` when it carries them, else from the fallback root. (validateForCi never reads deploy scripts.) */
function composeSource(root: string, fallbackRoot: string): DefinitionSource {
  const own = bundled(root);
  const schemas = existsSync(path.join(root, "schemas")) ? own : bundled(fallbackRoot);
  return {
    getDeploymentDefinition: (id: string): Promise<DefinitionContent> => own.getDeploymentDefinition(id),
    getTargetRegistry: (): Promise<DefinitionContent> => own.getTargetRegistry(),
    getSchema: (name: string): Promise<DefinitionContent> => schemas.getSchema(name),
    getDeployScript: (name: string): Promise<DefinitionContent> => own.getDeployScript(name),
  };
}

async function issuesOf(source: DefinitionSource, ids: readonly string[]): Promise<ValidationIssue[]> {
  try {
    await validateForCi({ definitionSource: source }, ids);
    return [];
  } catch (error) {
    if (error instanceof DefinitionValidationError) return [...error.issues];
    return [{ rule: "load", field: ids.length === 0 ? "targetRegistry" : `deployment(${ids.join(",")})`, message: error instanceof Error ? error.message : String(error) }];
  }
}

const keyOf = (i: ValidationIssue): string => `${i.rule}\u0000${i.rule === "load" ? "" : i.field}\u0000${i.message}`;
const lineOf = (file: string, i: ValidationIssue): string => `  ${file}: ${i.field}: ${i.message} [${i.rule}]`;

/** Exit codes: 0 all deployments pass, 1 at least one issue, 2 usage error. */
export async function runDefinitionsCheck(argv: readonly string[], deps: DefinitionsCheckDeps): Promise<number> {
  const rootArg = parseRoot(argv);
  if (rootArg === undefined) {
    deps.err(`error: --root <dir> is required\n${USAGE}`);
    return 2;
  }
  const root = path.resolve(rootArg);
  if (!existsSync(path.join(root, "deployment-definitions"))) {
    deps.err(`error: ${root} does not exist or has no deployment-definitions/ directory\n${USAGE}`);
    return 2;
  }

  const fallbackRoot = deps.fallbackRoot ?? findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const source = composeSource(root, fallbackRoot);
  const ids = await bundled(root).listDeploymentIds();
  const { files, problems } = await scanDefinitionFiles(root);
  if (!existsSync(path.join(root, "schemas"))) {
    deps.out(`NOTE: ${root} has no schemas/; the repository's schemas were used for this check. An Executor started with CICD_DEFINITIONS_ROOT=<root> reads schemas from <root>/schemas and refuses to start without them, so the root must also contain schemas/ (and deploy-scripts/).`);
  }

  const seen = new Set<string>();
  const registryIssues = await issuesOf(source, []);
  registryIssues.forEach((i) => seen.add(keyOf(i)));
  const lines: string[] = registryIssues.map((i) => lineOf(REGISTRY_FILE, i));
  let failed = registryIssues.length > 0 || problems.length > 0;
  for (const problem of problems) {
    deps.out(`FAIL ${problem.slice(0, problem.indexOf(": "))}`);
    lines.push(`  ${problem}`);
  }

  for (const id of ids) {
    const own = (await issuesOf(source, [id])).filter((i) => !seen.has(keyOf(i)));
    own.forEach((i) => seen.add(keyOf(i)));
    failed ||= own.length > 0;
    deps.out(`${own.length === 0 && registryIssues.length === 0 ? "OK" : "FAIL"} ${id}`);
    for (const i of own) lines.push(lineOf(files.get(id) ?? "deployment-definitions", i));
  }
  if (ids.length === 0) {
    deps.err(`error: no deployment definitions found under ${path.join(root, "deployment-definitions")}`);
    failed = true;
  }
  // Cross-deployment rules (e.g. one deployment per lockKey) only show up when all deployments are validated together.
  const crossIssues = ids.length > 1 ? (await issuesOf(source, ids)).filter((i) => !seen.has(keyOf(i))) : [];
  failed ||= crossIssues.length > 0;
  for (const i of crossIssues) lines.push(lineOf("deployment-definitions (cross-deployment)", i));

  lines.forEach((l) => deps.out(l));
  deps.out(failed ? "definitions:check FAILED" : `definitions:check passed (${ids.length} deployment(s))`);
  return failed ? 1 : 0;
}
