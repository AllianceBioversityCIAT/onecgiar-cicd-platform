// @akili-spec changes/cicd-executor-poc design §4.2, §6.2, §6.3, §7 (definition-service row), DD-19, DD-23, DD-25, DD-27, §7.7 (amended 2026-10-05)
// Obtains and validates deployment definitions/registry solely via DefinitionSource (FR-01, FR-02, DD-19).
//
// Two modes (design §7 'definition-service' row: "the same validation runs
// in CI before the image is built" + "at startup"):
//   - validateForCi:      structure only. No SecretProvider, no network, no
//                          secret resolution. Runs in CI before the image is built.
//   - validateForStartup: everything validateForCi does, PLUS resolves every
//                          identifier reference via SecretProvider (including
//                          allowedSenderRef and the platform principal refs,
//                          DD-25), existence-checks credential references, and
//                          checks rules only visible after resolution. The
//                          Executor refuses to start on any failure here (DD-23).
//
// The core (this module, handlers) never touches the filesystem: every byte
// of content comes from the injected DefinitionSource port.
import { parse as parseYaml } from "yaml";
import type { DefinitionSource } from "../../ports/definition-source.js";
import type { SecretProvider } from "../../ports/secret-provider.js";
import { createAjv, ajvErrorsToIssues } from "./schema-validation.js";
import {
  checkArtifactsUnique,
  checkDeploymentIdMatchesRequested,
  checkMigrationAttestation,
  checkTargetRefExists,
  type ValidationIssue,
} from "./semantic-rules.js";
import {
  checkDuplicatePortsAndNames,
  checkOneDeploymentPerLockKey,
  checkResolvedExternalDeployersNonEmpty,
  extractLogicalRegistryShape,
  extractResolvedRegistryShape,
} from "./registry-rules.js";
import {
  collectRegistryAllowlistedRefs,
  collectRegistryExistenceOnlyRefs,
  collectDeploymentAllowlistedRefs,
  collectDeploymentExistenceOnlyRefs,
  collectPrincipalRefs,
  isLogicalRef,
  resolveAllReferences,
  checkAllReferencesExist,
  parseResolvedExternalDeployers,
  type PlatformPrincipalRefs,
} from "./reference-resolution.js";

export type { ValidationIssue } from "./semantic-rules.js";
export { UnresolvedReferenceError } from "./reference-resolution.js";
export type { PlatformPrincipalRefs } from "./reference-resolution.js";

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

export interface ValidatedDeployment {
  readonly deploymentId: string;
  readonly definitionRef: string;
  readonly definition: Record<string, unknown>;
}

export interface ValidatedRegistry {
  readonly definitionRef: string;
  readonly entries: Record<string, Record<string, unknown>>;
}

export interface CiValidationResult {
  readonly deployments: readonly ValidatedDeployment[];
  readonly registry: ValidatedRegistry;
}

/** The bound source of a deployment (DD-27), resolved at startup. */
export interface ResolvedSource {
  readonly repository: string;
  readonly workflow: string;
  readonly environment: string;
}

/** Resolved role IDs of the platform principals (DD-25). */
export interface ResolvedPrincipals {
  /** The CI role shared by the authorized repositories (AC-02 V1). */
  readonly ci: string;
  readonly executor: string;
  readonly scheduler: string;
  readonly operator: string;
}

export interface StartupValidationResult extends CiValidationResult {
  /** externalDeployersRef resolved to its opaque list, per targetId (empty array when policy is not-required). */
  readonly resolvedExternalDeployers: Readonly<Record<string, readonly string[]>>;
  /** allowedSenderRef resolved to the CI role ID, per deploymentId (DD-25). */
  readonly resolvedAllowedSenders: Readonly<Record<string, string>>;
  /** source.*Ref resolved, per deploymentId (DD-27). */
  readonly resolvedSources: Readonly<Record<string, ResolvedSource>>;
  readonly resolvedPrincipals: ResolvedPrincipals;
}

export interface CiValidationDeps {
  readonly definitionSource: DefinitionSource;
}

export interface StartupValidationDeps extends CiValidationDeps {
  readonly secretProvider: SecretProvider;
  /**
   * Platform-config principal references (DD-25). The design does not say where
   * platform config lives, so the caller (composition root) supplies them.
   */
  readonly principalRefs: PlatformPrincipalRefs;
}

async function loadValidators(definitionSource: DefinitionSource) {
  const ajv = createAjv();
  const [{ content: deploymentSchema }, { content: targetsSchema }] = await Promise.all([
    definitionSource.getSchema("deployment.schema.json"),
    definitionSource.getSchema("targets.schema.json"),
  ]);
  // Compiled once per call: compiling the same $id twice on one Ajv instance throws.
  return {
    validateDeployment: ajv.compile(JSON.parse(deploymentSchema) as object),
    validateRegistry: ajv.compile(JSON.parse(targetsSchema) as object),
  };
}

type Validators = Awaited<ReturnType<typeof loadValidators>>;

async function validateDeploymentStructure(
  definitionSource: DefinitionSource,
  validators: Validators,
  deploymentId: string,
): Promise<{ deployment: ValidatedDeployment; issues: ValidationIssue[] }> {
  const { content, definitionRef } = await definitionSource.getDeploymentDefinition(deploymentId);
  const parsed = parseYaml(content) as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  if (!validators.validateDeployment(parsed)) {
    issues.push(...ajvErrorsToIssues(validators.validateDeployment, `deployment(${deploymentId})`));
  }
  const doc = parsed && typeof parsed === "object" ? parsed : {};
  issues.push(...checkDeploymentIdMatchesRequested(doc, deploymentId));
  issues.push(...checkArtifactsUnique(doc));

  return { deployment: { deploymentId, definitionRef, definition: doc }, issues };
}

async function validateRegistryStructure(
  definitionSource: DefinitionSource,
  validators: Validators,
): Promise<{ registry: ValidatedRegistry; issues: ValidationIssue[] }> {
  const { content, definitionRef } = await definitionSource.getTargetRegistry();
  const parsed = parseYaml(content) as Record<string, Record<string, unknown>>;
  const issues: ValidationIssue[] = [];

  if (!validators.validateRegistry(parsed)) {
    issues.push(...ajvErrorsToIssues(validators.validateRegistry, "targetRegistry"));
  }

  // Duplicate ports/container names per host, over LOGICAL values (CI mode).
  issues.push(...checkDuplicatePortsAndNames(extractLogicalRegistryShape(parsed)));

  return { registry: { definitionRef, entries: parsed }, issues };
}

/**
 * Validates structure only: schema + the semantic and cross-document rules
 * Ajv cannot express (target exists, migration attestation, one deploymentId
 * per lockKey). No SecretProvider, no resolution, no I/O beyond
 * DefinitionSource. Runs in CI before the image is built (design §7).
 */
export async function validateForCi(
  deps: CiValidationDeps,
  deploymentIds: readonly string[],
): Promise<CiValidationResult> {
  const validators = await loadValidators(deps.definitionSource);
  const issues: ValidationIssue[] = [];
  const deployments: ValidatedDeployment[] = [];

  for (const deploymentId of deploymentIds) {
    const result = await validateDeploymentStructure(deps.definitionSource, validators, deploymentId);
    deployments.push(result.deployment);
    issues.push(...result.issues);
  }

  const { registry, issues: registryIssues } = await validateRegistryStructure(deps.definitionSource, validators);
  issues.push(...registryIssues);

  for (const { definition } of deployments) {
    issues.push(...checkTargetRefExists(definition, registry.entries));
    issues.push(...checkMigrationAttestation(definition, registry.entries));
  }
  issues.push(
    ...checkOneDeploymentPerLockKey(
      deployments.map((d) => ({ deploymentId: d.deploymentId, targetRef: String(d.definition.targetRef) })),
      registry.entries,
    ),
  );

  if (issues.length > 0) {
    throw new DefinitionValidationError(issues);
  }
  return { deployments, registry };
}

function resolvedOf(resolved: ReadonlyMap<string, string>, ref: unknown): string {
  return typeof ref === "string" ? (resolved.get(ref) ?? "") : "";
}

/**
 * Everything validateForCi does, PLUS: resolves every IDENTIFIER reference via
 * SecretProvider (any unresolved reference aborts — UnresolvedReferenceError,
 * design DD-23): `allowedSenderRef`, `source.*Ref`, artifact identifiers and
 * the platform principal refs (DD-25, approved 2026-10-06). Re-checks
 * duplicate ports/names over the RESOLVED values and validates that a
 * `required` target's resolved externalDeployers list is non-empty (design
 * §7.7). An invalid registry or an unresolved reference prevents the Executor
 * from starting. `containers[].envSecretRef` and `runtimeSecretRefs` values
 * are deliberately NEVER resolved here — they are the application's own
 * runtime secrets (NFR-01, design §6.2/§6.4 OD-Q5).
 *
 * Owner ruling (execution.md 2026-10-05, "existence without reading"):
 * CREDENTIAL references (`notifications.slack.tokenRef`, the Target
 * Registry's `credentialRef`) are EXISTENCE-checked only — never passed to
 * `getSecret` — since definition-service is PROHIBITED from reading secret
 * values (design §7 definition-service row). A missing credential reference
 * aborts startup like any other unresolved reference, naming only the ref.
 */
export async function validateForStartup(
  deps: StartupValidationDeps,
  deploymentIds: readonly string[],
): Promise<StartupValidationResult> {
  const ciResult = await validateForCi(deps, deploymentIds);

  const principalIssues: ValidationIssue[] = [];
  for (const [field, ref] of Object.entries(deps.principalRefs)) {
    if (!isLogicalRef(ref)) {
      principalIssues.push({
        rule: "principal-ref-invalid",
        field: `platformConfig/${field}`,
        message: "must be a logical <PLACEHOLDER> reference (DD-23, DD-25)",
      });
    }
  }
  if (principalIssues.length > 0) throw new DefinitionValidationError(principalIssues);

  // Identifier refs only (NFR-01): what the Executor itself needs to resolve
  // BY VALUE, never containers[].envSecretRef / runtimeSecretRefs values and
  // never a credential reference (existence-checked only, below).
  const allRefs = new Set<string>();
  for (const d of ciResult.deployments) collectDeploymentAllowlistedRefs(d.definition, allRefs);
  collectRegistryAllowlistedRefs(ciResult.registry.entries, allRefs);
  collectPrincipalRefs(deps.principalRefs, allRefs);

  // CREDENTIAL refs: existence-only, never getSecret (owner ruling, execution.md 2026-10-05).
  const existenceOnlyRefs = new Set<string>();
  for (const d of ciResult.deployments) collectDeploymentExistenceOnlyRefs(d.definition, existenceOnlyRefs);
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

  // Each deployment is bound to one sender and one source (DD-25, DD-27).
  const resolvedAllowedSenders: Record<string, string> = {};
  const resolvedSources: Record<string, ResolvedSource> = {};
  for (const { deploymentId, definition } of ciResult.deployments) {
    resolvedAllowedSenders[deploymentId] = resolvedOf(resolved, definition.allowedSenderRef);
    const source = (definition.source ?? {}) as Record<string, unknown>;
    resolvedSources[deploymentId] = {
      repository: resolvedOf(resolved, source.repositoryRef),
      workflow: resolvedOf(resolved, source.workflowRef),
      environment: resolvedOf(resolved, source.environmentRef),
    };
  }

  if (issues.length > 0) {
    throw new DefinitionValidationError(issues);
  }

  return {
    ...ciResult,
    resolvedExternalDeployers,
    resolvedAllowedSenders,
    resolvedSources,
    resolvedPrincipals: {
      ci: resolvedOf(resolved, deps.principalRefs.ciPrincipalRef),
      executor: resolvedOf(resolved, deps.principalRefs.executorPrincipalRef),
      scheduler: resolvedOf(resolved, deps.principalRefs.schedulerPrincipalRef),
      operator: resolvedOf(resolved, deps.principalRefs.operatorPrincipalRef),
    },
  };
}
