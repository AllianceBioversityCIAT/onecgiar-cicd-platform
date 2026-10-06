// @akili-spec changes/cicd-executor-poc requirements FR-01; design §6.2, §7 (definition-service row)
// Semantic validation rules for flat Deployment Definitions that JSON Schema
// cannot express. Schema-level rules (closed shape, no expressions or
// interpolation, value patterns, enum of bundled scripts) already live in
// schemas/deployment.schema.json (N-02) and are NOT reimplemented here. There
// is no step graph in Model B: no `needs`, cycles, reserved step types or
// interpolation rules (design §6.2, AC-01).

export interface ValidationIssue {
  readonly rule: string;
  readonly field: string;
  readonly message: string;
}

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
}

/** The document's own `deploymentId` must equal the id it was loaded under. */
export function checkDeploymentIdMatchesRequested(doc: Raw, requestedId: string): ValidationIssue[] {
  if (doc.deploymentId === requestedId) return [];
  return [
    {
      rule: "deployment-id-mismatch",
      field: `deployment(${requestedId})/deploymentId`,
      message: `the loaded document declares a different deploymentId than the one requested ("${requestedId}")`,
    },
  ];
}

/** Within one definition, each artifact `unit` and each artifact `container` may appear once. */
export function checkArtifactsUnique(doc: Raw): ValidationIssue[] {
  const artifacts = Array.isArray(doc.artifacts) ? doc.artifacts : [];
  const issues: ValidationIssue[] = [];
  for (const key of ["unit", "container"] as const) {
    const seen = new Set<string>();
    artifacts.forEach((raw, index) => {
      const value = asRecord(raw)?.[key];
      if (typeof value !== "string") return;
      if (seen.has(value)) {
        issues.push({
          rule: `artifact-${key}-duplicate`,
          field: `artifacts[${index}].${key}`,
          message: `artifact ${key} appears more than once in this definition`,
        });
      }
      seen.add(value);
    });
  }
  return issues;
}

/** `targetRef` must name an entry of the Target Registry (FR-01, design §6.2). */
export function checkTargetRefExists(
  doc: Raw,
  registryEntries: Readonly<Record<string, Raw>>,
): ValidationIssue[] {
  const targetRef = doc.targetRef;
  if (typeof targetRef !== "string" || Object.prototype.hasOwnProperty.call(registryEntries, targetRef)) return [];
  return [
    {
      rule: "target-ref-unknown",
      field: "targetRef",
      message: `targetRef "${targetRef}" is not an entry of the Target Registry`,
    },
  ];
}

/**
 * Design §6.2: `migration` "requires the target's `migrationCompatibility`
 * attestation". A definition that declares `migration` is valid only when its
 * target entry carries a `migration` block attested `backward-compatible`
 * with a non-empty `attestedBy` (design §6.3, DD-11). The platform never
 * presents the property as guaranteed — it only requires the attestation.
 */
export function checkMigrationAttestation(
  doc: Raw,
  registryEntries: Readonly<Record<string, Raw>>,
): ValidationIssue[] {
  if (doc.migration === undefined) return [];
  const targetRef = doc.targetRef;
  if (typeof targetRef !== "string") return [];
  const entry = registryEntries[targetRef];
  if (!entry) return []; // reported by checkTargetRefExists
  const migration = asRecord(entry.migration);
  const attested =
    migration !== undefined &&
    migration.migrationCompatibility === "backward-compatible" &&
    typeof migration.attestedBy === "string" &&
    migration.attestedBy.length > 0;
  if (attested) return [];
  return [
    {
      rule: "migration-attestation-missing",
      field: "migration",
      message: `the definition declares a migration but target "${targetRef}" has no migrationCompatibility attestation (design §6.2, §6.3)`,
    },
  ];
}
