// @akili-spec changes/cicd-executor-poc design §6.2, DD-19, DD-23
// Startup diagnosis (owner decision 2026-10-06): when `validateForStartup` rejects the definition set, name the
// FILE behind each issue so the operator can fix it. Structure-only re-validation per deployment (`validateForCi`:
// no secrets, no network); issues only carry rule, field and message, never definition content.
import { DefinitionValidationError, validateForCi, type ValidationIssue } from "../application/definition-service/index.js";
import { DefinitionLoadError, TARGET_REGISTRY_RELATIVE_PATH } from "../adapters/bundled-definition-source/index.js";
import type { DefinitionSource } from "../ports/definition-source.js";

/** Label for issues that no single file owns (cross-deployment rules, platform configuration). */
export const CROSS_DEFINITION_LABEL = "deployment-definitions (cross-deployment or platform configuration)";

async function issuesOf(source: DefinitionSource, ids: readonly string[]): Promise<readonly ValidationIssue[]> {
  try {
    await validateForCi({ definitionSource: source }, ids);
    return [];
  } catch (error) {
    return error instanceof DefinitionValidationError ? error.issues : [];
  }
}

const keyOf = (i: ValidationIssue): string => `${i.rule}\u0000${i.field}\u0000${i.message}`;

/**
 * Returns a `DefinitionValidationError` whose issue fields are prefixed with the relative path of the file that
 * owns them (the registry file for registry issues, the deployment's own file for per-deployment issues).
 */
export async function attributeToFiles(
  source: DefinitionSource,
  files: ReadonlyMap<string, string>,
  error: DefinitionValidationError,
): Promise<DefinitionValidationError> {
  const out: ValidationIssue[] = [];
  const label = (file: string, i: ValidationIssue): ValidationIssue => ({ ...i, field: `${file}: ${i.field}` });
  const inError = new Set(error.issues.map(keyOf));
  const registry = (await issuesOf(source, [])).filter((i) => inError.has(keyOf(i)));
  const registryKeys = new Set(registry.map(keyOf));
  out.push(...registry.map((i) => label(TARGET_REGISTRY_RELATIVE_PATH, i)));
  // Per-file results stay separate: two files may legitimately share an identical issue (same bad targetRef), and
  // both must be named. A per-deployment run also repeats the registry issues; only those are subtracted.
  const matched = new Set(registryKeys);
  for (const [id, file] of files) {
    for (const i of await issuesOf(source, [id])) {
      if (!inError.has(keyOf(i)) || registryKeys.has(keyOf(i))) continue;
      matched.add(keyOf(i));
      out.push(label(file, i));
    }
  }
  // What no single file owns (cross-deployment rules, platform configuration) is only what nothing above matched.
  out.push(...error.issues.filter((i) => !matched.has(keyOf(i))).map((i) => label(CROSS_DEFINITION_LABEL, i)));
  return new DefinitionValidationError(out);
}

/**
 * Stderr lines for a refused startup: one line per affected definition file with its reason (safe: no content).
 * Any other error keeps the single-line form.
 */
export function describeStartupFailure(error: unknown): string[] {
  if (error instanceof DefinitionLoadError) {
    return [`executor refused to start: ${error.problems.length} definition file(s) cannot be loaded`, ...error.problems.map((p) => `  ${p.file}: ${p.reason}`)];
  }
  if (error instanceof DefinitionValidationError) {
    return [`executor refused to start: ${error.issues.length} definition validation issue(s)`, ...error.issues.map((i) => `  ${i.field}: ${i.message} [${i.rule}]`)];
  }
  return [`executor refused to start: ${error instanceof Error ? error.message : String(error)}`];
}
