// @akili-spec changes/cicd-executor-poc design §4.2, §7 (definition-service row), DD-19, DD-23, §7.7 (amended 2026-10-05)
// Obtains and validates definitions/registry solely via DefinitionSource (FR-01, FR-02, DD-19).
//
// Two modes (design §7 'definition-service' row: "the same validation runs
// in CI before the image is built" + "at startup"):
//   - validateForCi:      structure only. No SecretProvider, no network, no
//                          secret resolution. Runs in CI before the image is built.
//   - validateForStartup: everything validateForCi does, PLUS resolves every
//                          logical reference via SecretProvider and checks
//                          rules only visible after resolution. The Executor
//                          refuses to start on any failure here (DD-23).
//
// The core (this module, planner, handlers) never touches the filesystem:
// every byte of content comes from the injected DefinitionSource port.
import { parse as parseYaml } from "yaml";
import type { DefinitionSource } from "../../ports/definition-source.js";
import type { SecretProvider } from "../../ports/secret-provider.js";
import { createAjv, ajvErrorsToIssues } from "./schema-validation.js";
import {
  checkReservedStepTypes,
  checkNeedsExistence,
  checkNeedsCycle,
  type ValidationIssue,
} from "./semantic-rules.js";
import {
  checkDuplicatePortsAndNames,
  checkResolvedExternalDeployersNonEmpty,
  extractLogicalRegistryShape,
  extractResolvedRegistryShape,
} from "./registry-rules.js";
import {
  collectRegistryAllowlistedRefs,
  collectRegistryExistenceOnlyRefs,
  collectPipelineAllowlistedRefs,
  collectPipelineExistenceOnlyRefs,
  resolveAllReferences,
  checkAllReferencesExist,
  parseResolvedExternalDeployers,
} from "./reference-resolution.js";

export type { ValidationIssue } from "./semantic-rules.js";
export { UnresolvedReferenceError } from "./reference-resolution.js";

export class DefinitionValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(
      `definition validation failed (${issues.length} issue(s)): ` +
        issues.map((i) => `[${i.rule}] ${i.field}: ${i.message}`).join("; "),
    );
    this.name = "DefinitionValidationError";
    this.issues = issues;
  }
}

export interface ValidatedPipeline {
  readonly pipelineId: string;
  readonly definitionRef: string;
  readonly definition: Record<string, unknown>;
}

export interface ValidatedRegistry {
  readonly definitionRef: string;
  readonly entries: Record<string, Record<string, unknown>>;
}

export interface CiValidationResult {
  readonly pipelines: readonly ValidatedPipeline[];
  readonly registry: ValidatedRegistry;
}

export interface StartupValidationResult extends CiValidationResult {
  /** externalDeployersRef resolved to its opaque list, per targetId (empty array when policy is not-required). */
  readonly resolvedExternalDeployers: Readonly<Record<string, readonly string[]>>;
}

export interface CiValidationDeps {
  readonly definitionSource: DefinitionSource;
}

export interface StartupValidationDeps extends CiValidationDeps {
  readonly secretProvider: SecretProvider;
}

type Ajv2020Instance = ReturnType<typeof createAjv>;

async function validatePipelineStructure(
  definitionSource: DefinitionSource,
  ajv: Ajv2020Instance,
  pipelineId: string,
): Promise<{ pipeline: ValidatedPipeline; issues: ValidationIssue[] }> {
  const [{ content, definitionRef }, { content: schemaContent }] = await Promise.all([
    definitionSource.getPipelineDefinition(pipelineId),
    definitionSource.getSchema("pipeline.schema.json"),
  ]);
  const parsed = parseYaml(content) as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  // Reserved-type pre-check on the RAW document, before schema validation,
  // so the message is specific (FR-01 scenario 'reserved type').
  issues.push(...checkReservedStepTypes(parsed));

  const schema = JSON.parse(schemaContent) as object;
  const validate = ajv.compile(schema);
  if (!validate(parsed)) {
    issues.push(...ajvErrorsToIssues(validate, `pipeline(${pipelineId})`));
  }

  // Semantic rules JSON Schema cannot express (graph shape).
  issues.push(...checkNeedsExistence(parsed));
  issues.push(...checkNeedsCycle(parsed));

  return { pipeline: { pipelineId, definitionRef, definition: parsed }, issues };
}

async function validateRegistryStructure(
  definitionSource: DefinitionSource,
  ajv: Ajv2020Instance,
): Promise<{ registry: ValidatedRegistry; issues: ValidationIssue[] }> {
  const [{ content, definitionRef }, { content: schemaContent }] = await Promise.all([
    definitionSource.getTargetRegistry(),
    definitionSource.getSchema("targets.schema.json"),
  ]);
  const parsed = parseYaml(content) as Record<string, Record<string, unknown>>;
  const issues: ValidationIssue[] = [];

  const schema = JSON.parse(schemaContent) as object;
  const validate = ajv.compile(schema);
  if (!validate(parsed)) {
    issues.push(...ajvErrorsToIssues(validate, "targetRegistry"));
  }

  // Duplicate ports/container names per host, over LOGICAL values (CI mode).
  issues.push(...checkDuplicatePortsAndNames(extractLogicalRegistryShape(parsed)));

  return { registry: { definitionRef, entries: parsed }, issues };
}

/**
 * Validates structure only: schema + the semantic rules Ajv cannot express.
 * No SecretProvider, no resolution, no I/O beyond DefinitionSource. Runs in
 * CI before the image is built (design §7 'definition-service' row).
 */
export async function validateForCi(
  deps: CiValidationDeps,
  pipelineIds: readonly string[],
): Promise<CiValidationResult> {
  const ajv = createAjv();
  const issues: ValidationIssue[] = [];
  const pipelines: ValidatedPipeline[] = [];

  for (const pipelineId of pipelineIds) {
    const result = await validatePipelineStructure(deps.definitionSource, ajv, pipelineId);
    pipelines.push(result.pipeline);
    issues.push(...result.issues);
  }

  const { registry, issues: registryIssues } = await validateRegistryStructure(deps.definitionSource, ajv);
  issues.push(...registryIssues);

  if (issues.length > 0) {
    throw new DefinitionValidationError(issues);
  }
  return { pipelines, registry };
}

/**
 * Everything validateForCi does, PLUS: resolves every ALLOWLISTED logical
 * reference via SecretProvider (any unresolved reference aborts —
 * UnresolvedReferenceError, design DD-23), re-checks duplicate ports/names
 * over the RESOLVED values, and validates that a `required` target's
 * resolved externalDeployers list is non-empty (design §7.7 amended
 * 2026-10-05). An invalid registry or an unresolved reference prevents the
 * Executor from starting. `containers[].envSecretRef` is deliberately NEVER
 * resolved here — it is the application's own runtime secret (NFR-01,
 * design §6.4 OD-Q5); see reference-resolution.ts.
 *
 * Owner ruling (execution.md 2026-10-05, "existence without reading"):
 * CREDENTIAL references (`repository.credentialRef`, `notifications.slack.tokenRef`,
 * the Target Registry's `credentialRef`) are EXISTENCE-checked only — never
 * passed to `getSecret` — since definition-service is PROHIBITED from
 * reading secret values (design §7 definition-service row). A missing
 * credential reference aborts startup exactly like any other unresolved
 * reference, naming only the ref.
 */
export async function validateForStartup(
  deps: StartupValidationDeps,
  pipelineIds: readonly string[],
): Promise<StartupValidationResult> {
  const ciResult = await validateForCi(deps, pipelineIds);

  // Allowlisted refs only (NFR-01): what the Executor itself needs to
  // resolve BY VALUE to do its job, never containers[].envSecretRef — the
  // application's own runtime secret (design §6.4 OD-Q5) — and never a
  // credential reference (those are existence-checked only, below).
  const allRefs = new Set<string>();
  for (const pipeline of ciResult.pipelines) collectPipelineAllowlistedRefs(pipeline.definition, allRefs);
  collectRegistryAllowlistedRefs(ciResult.registry.entries, allRefs);

  // CREDENTIAL refs: existence-only, never getSecret (owner ruling, execution.md 2026-10-05).
  const existenceOnlyRefs = new Set<string>();
  for (const pipeline of ciResult.pipelines) collectPipelineExistenceOnlyRefs(pipeline.definition, existenceOnlyRefs);
  collectRegistryExistenceOnlyRefs(ciResult.registry.entries, existenceOnlyRefs);
  await checkAllReferencesExist(existenceOnlyRefs, deps.secretProvider);

  const resolved = await resolveAllReferences(allRefs, deps.secretProvider);

  const issues: ValidationIssue[] = [];

  // Duplicate ports/container names per host, over RESOLVED values —
  // catches two different logical refs that happen to resolve to the same
  // real host/port, which the CI-mode (logical) check cannot see.
  issues.push(...checkDuplicatePortsAndNames(extractResolvedRegistryShape(ciResult.registry.entries, resolved)));

  const resolvedExternalDeployers: Record<string, string[]> = {};
  for (const [targetId, entry] of Object.entries(ciResult.registry.entries)) {
    const policy = entry.deployWindowPolicy === "required" ? "required" : "not-required";
    if (policy === "required" && typeof entry.externalDeployersRef === "string") {
      const resolvedValue = resolved.get(entry.externalDeployersRef);
      const list = resolvedValue !== undefined ? parseResolvedExternalDeployers(entry.externalDeployersRef, resolvedValue) : [];
      resolvedExternalDeployers[targetId] = list;
      issues.push(...checkResolvedExternalDeployersNonEmpty(targetId, "required", list));
    } else {
      resolvedExternalDeployers[targetId] = [];
    }
  }

  if (issues.length > 0) {
    throw new DefinitionValidationError(issues);
  }

  return { ...ciResult, resolvedExternalDeployers };
}
