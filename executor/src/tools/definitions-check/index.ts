// @akili-spec changes/cicd-executor-poc design §6.2, §7 (definition-service row), DD-19, NFR-01
// Offline definitions check for the owner: runs the structure-only CI validation
// (`validateForCi`) over every deployment found under a LOCAL definitions root
// before the Executor is started. No SecretProvider, no network, no AWS, and no
// reference is ever resolved (only logical references are present or printed).
// This module is a developer tool: nothing in the Executor's runtime path
// imports it.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefinitionValidationError, validateForCi, type ValidationIssue } from "../../application/definition-service/index.js";
import { BundledDefinitionSource, TARGET_REGISTRY_RELATIVE_PATH, findRepoRoot } from "../../adapters/bundled-definition-source/index.js";
import type { DefinitionContent, DefinitionSource } from "../../ports/definition-source.js";

export interface DefinitionsCheckDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Repository root providing `schemas/` and `deploy-scripts/` when the checked root has none (tests may override). */
  readonly fallbackRoot?: string;
}

const USAGE = "usage: definitions:check --root <dir>   (<dir> contains deployment-definitions/; schemas/ defaults to the repository's own copy when absent)";
const REGISTRY_FILE = TARGET_REGISTRY_RELATIVE_PATH;

function parseRoot(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--root");
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") || value.trim() === "" ? undefined : value;
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
  // The adapter scans EVERY yaml file: the same scan the Executor's startup fails fast on. This preflight reports all of it.
  const scan = await bundled(root).scanDefinitions();
  const ids = scan.deployments.map((d) => d.deploymentId).sort();
  const files = new Map(scan.deployments.map((d) => [d.deploymentId, d.file]));
  const problems = scan.problems.map((p) => `${p.file}: ${p.reason}`);
  if (!existsSync(path.join(root, "schemas"))) {
    deps.out(`NOTE: ${root} has no schemas/; the repository's schemas were used for this check. An Executor started with CICD_DEFINITIONS_ROOT=<root> reads schemas from <root>/schemas and refuses to start without them, so the root must also contain schemas/ (and deploy-scripts/).`);
  }

  // `seen` holds issues already attributed to a file. A per-deployment run repeats the registry issues (subtracted), but an
  // identical issue in two deployments (same unknown targetRef) must be reported for BOTH files, so it is not deduplicated across them.
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
    const registryKeys = new Set(registryIssues.map(keyOf));
    const own = (await issuesOf(source, [id])).filter((i) => !registryKeys.has(keyOf(i)));
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
