// @akili-spec changes/cicd-executor-poc requirements FR-01, FR-02, NFR-08; design §6.2, §6.3, DD-27
//
// definition-service.validateForCi: flat Deployment Definition validation end
// to end through the service. Schema-level rules are proven exhaustively in
// test/contract/deployment-schema.contract.test.ts; here the point is that
// the service rejects each invalid definition NAMING THE FIELD, plus the
// cross-document rules JSON Schema cannot express: targetRef exists, migration
// requires the target attestation, artifact uniqueness, and the single-source
// invariant (one deploymentId per lockKey, one definition per deploymentId).
// Each negative case is a deep-cloned mutation of the SAME valid base document.
/* eslint-disable @typescript-eslint/no-explicit-any -- negative fixtures mutate arbitrary nested YAML */
import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, beforeAll } from "vitest";
import {
  deploymentSchemaPath,
  targetsSchemaPath,
  prmsReportingDevDeploymentYamlPath,
  targetsDevYamlPath,
} from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";
import { validateForCi, DefinitionValidationError } from "../../src/application/definition-service/index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("definition-service.validateForCi — Deployment Definition rules (FR-01, FR-02)", () => {
  let deploymentSchemaContent: string;
  let targetsSchemaContent: string;
  let base: Record<string, any>;
  let registry: Record<string, Record<string, any>>;

  beforeAll(() => {
    deploymentSchemaContent = readFileSync(deploymentSchemaPath, "utf8");
    targetsSchemaContent = readFileSync(targetsSchemaPath, "utf8");
    base = parseYaml(readFileSync(prmsReportingDevDeploymentYamlPath, "utf8"));
    registry = parseYaml(readFileSync(targetsDevYamlPath, "utf8"));
  });

  function sourceWith(
    definitions: Record<string, Record<string, unknown>>,
    registryOverride: Record<string, unknown> = registry,
  ): InMemoryDefinitionSource {
    return new InMemoryDefinitionSource({
      deployments: Object.fromEntries(Object.entries(definitions).map(([id, d]) => [id, stringifyYaml(d)])),
      targetRegistry: stringifyYaml(registryOverride),
      schemas: {
        "deployment.schema.json": deploymentSchemaContent,
        "targets.schema.json": targetsSchemaContent,
      },
      definitionRef: "test-fixture-ref",
    });
  }

  async function issuesFor(
    definition: Record<string, unknown>,
    registryOverride?: Record<string, unknown>,
  ): Promise<readonly { rule: string; field: string; message: string }[]> {
    try {
      await validateForCi(
        { definitionSource: sourceWith({ "prms-reporting-dev": definition }, registryOverride) },
        ["prms-reporting-dev"],
      );
    } catch (error) {
      if (error instanceof DefinitionValidationError) return error.issues;
      throw error;
    }
    return [];
  }

  it("accepts the real, versioned PRMS Reporting DEV definition and records its definitionRef", async () => {
    const result = await validateForCi({ definitionSource: sourceWith({ "prms-reporting-dev": base }) }, [
      "prms-reporting-dev",
    ]);
    expect(result.deployments).toHaveLength(1);
    expect(result.deployments[0]!.deploymentId).toBe("prms-reporting-dev");
    expect(result.deployments[0]!.definitionRef).toBe("test-fixture-ref");
  });

  describe("invalid definitions are rejected naming the field (FR-01)", () => {
    const p = "deployment(prms-reporting-dev)";
    const cases: Array<[string, (d: Record<string, any>) => void, string]> = [
      ["environment other than dev", (d) => { d.environment = "prod"; }, `${p}/environment`],
      ["an extra top-level field", (d) => { d.extra = 1; }, `${p}/extra`],
      ["a steps list (no step graph in Model B)", (d) => { d.steps = []; }, `${p}/steps`],
      ["a missing allowedSenderRef", (d) => { delete d.allowedSenderRef; }, `${p}/allowedSenderRef`],
      ["a raw (non-logical) allowedSenderRef", (d) => { d.allowedSenderRef = "raw-role"; }, `${p}/allowedSenderRef`],
      ["a raw imageRepositoryRef", (d) => { d.artifacts[0].imageRepositoryRef = "registry.example.invalid/app"; }, `${p}/artifacts/0/imageRepositoryRef`],
      ["a raw container name", (d) => { d.artifacts[0].container = "Raw_Container"; }, `${p}/artifacts/0/container`],
      ["a raw runtimeSecretRefs value", (d) => { d.runtimeSecretRefs["<SERVER_CONTAINER>"] = "raw/secret/name"; }, `${p}/runtimeSecretRefs/<SERVER_CONTAINER>`],
      ["an invalid runtimeSecretRefs key", (d) => { d.runtimeSecretRefs["Bad Key"] = "<SOME_SECRET_REF>"; }, `${p}/runtimeSecretRefs`],
      ["a raw health url", (d) => { d.health["<SERVER_CONTAINER>"] = { url: "http://example.invalid/health" }; }, `${p}/health/<SERVER_CONTAINER>`],
      ["interpolation in a migration command", (d) => { d.migration.runCommand = "run ${X}"; }, `${p}/migration/runCommand`],
      ["a timeout above 60 minutes", (d) => { d.timeoutMinutes = 61; }, `${p}/timeoutMinutes`],
    ];

    it.each(cases)("rejects %s", async (_name, mutate, field) => {
      const d = clone(base);
      mutate(d);
      const issues = await issuesFor(d);
      expect(issues.some((i) => i.rule === "schema" && i.field.startsWith(field)), JSON.stringify(issues)).toBe(true);
    });
  });

  it("rejects a document whose deploymentId differs from the id it was loaded under", async () => {
    const d = clone(base);
    d.deploymentId = "some-other-deployment";
    const issues = await issuesFor(d);
    expect(issues.some((i) => i.rule === "deployment-id-mismatch" && i.field === "deployment(prms-reporting-dev)/deploymentId")).toBe(true);
  });

  it("rejects a targetRef that is not a Target Registry entry", async () => {
    const d = clone(base);
    d.targetRef = "unknown-target";
    const issues = await issuesFor(d);
    expect(issues.some((i) => i.rule === "target-ref-unknown" && i.field === "targetRef")).toBe(true);
  });

  it("rejects a duplicate artifact unit and a duplicate artifact container", async () => {
    const d = clone(base);
    d.artifacts[1].unit = d.artifacts[0].unit;
    d.artifacts[1].container = d.artifacts[0].container;
    const issues = await issuesFor(d);
    expect(issues.some((i) => i.rule === "artifact-unit-duplicate" && i.field === "artifacts[1].unit")).toBe(true);
    expect(issues.some((i) => i.rule === "artifact-container-duplicate" && i.field === "artifacts[1].container")).toBe(true);
  });

  describe("migration requires the target migrationCompatibility attestation (design §6.2, §6.3)", () => {
    it("accepts a migration when the target declares migrationCompatibility and attestedBy", async () => {
      expect(await issuesFor(clone(base))).toEqual([]);
    });

    it("rejects a migration when the target has no migration attestation", async () => {
      const reg = clone(registry);
      delete reg["prms-reporting-dev"]!.migration;
      const issues = await issuesFor(clone(base), reg);
      expect(issues.some((i) => i.rule === "migration-attestation-missing" && i.field === "migration")).toBe(true);
    });

    it("accepts a definition without migration on a target without attestation", async () => {
      const reg = clone(registry);
      delete reg["prms-reporting-dev"]!.migration;
      const d = clone(base);
      delete d.migration;
      expect(await issuesFor(d, reg)).toEqual([]);
    });
  });

  describe("single-source invariant: one deploymentId per lockKey, one definition per deploymentId (design §6.3, DD-27)", () => {
    function secondDefinition(targetRef: string): Record<string, any> {
      const d = clone(base);
      d.deploymentId = "other-deployment";
      d.targetRef = targetRef;
      d.source = {
        repositoryRef: "<OTHER_REPO_REF>",
        workflowRef: "<OTHER_WORKFLOW_REF>",
        environmentRef: "<OTHER_ENVIRONMENT_REF>",
      };
      d.allowedSenderRef = "<OTHER_CI_ROLE_REF>";
      delete d.migration;
      return d;
    }

    function registryWithSecondTarget(secondLockKey: string): Record<string, any> {
      const reg = clone(registry);
      const second = clone(reg["prms-reporting-dev"]!);
      delete second.migration;
      second.lockKey = secondLockKey;
      second.containers = [
        { name: "<OTHER_CONTAINER>", imageRepositoryRef: "<OTHER_IMAGE_REPOSITORY_REF>", portRef: "<OTHER_PORT_REF>" },
      ];
      second.connectionRef = "<OTHER_CONNECTION_REF>";
      reg["other-target"] = second;
      return reg;
    }

    it("accepts two definitions on two different lockKeys", async () => {
      const reg = registryWithSecondTarget("deployment#<OTHER_TARGET>#other-unit");
      const result = await validateForCi(
        { definitionSource: sourceWith({ "prms-reporting-dev": base, "other-deployment": secondDefinition("other-target") }, reg) },
        ["prms-reporting-dev", "other-deployment"],
      );
      expect(result.deployments.map((d) => d.deploymentId)).toEqual(["prms-reporting-dev", "other-deployment"]);
    });

    it("rejects two definitions that share one lockKey through different targets", async () => {
      const reg = registryWithSecondTarget(registry["prms-reporting-dev"]!.lockKey);
      await expect(
        validateForCi(
          { definitionSource: sourceWith({ "prms-reporting-dev": base, "other-deployment": secondDefinition("other-target") }, reg) },
          ["prms-reporting-dev", "other-deployment"],
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DefinitionValidationError &&
          error.issues.some(
            (i) =>
              i.rule === "lock-key-multiple-deployments" &&
              i.message.includes("other-deployment") &&
              i.message.includes("prms-reporting-dev"),
          ),
      );
    });

    it("rejects two definitions that share one target (hence one lockKey)", async () => {
      await expect(
        validateForCi(
          { definitionSource: sourceWith({ "prms-reporting-dev": base, "other-deployment": secondDefinition("prms-reporting-dev") }) },
          ["prms-reporting-dev", "other-deployment"],
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DefinitionValidationError && error.issues.some((i) => i.rule === "lock-key-multiple-deployments"),
      );
    });

    it("rejects the same deploymentId declared twice (one source per deploymentId)", async () => {
      await expect(
        validateForCi({ definitionSource: sourceWith({ "prms-reporting-dev": base }) }, ["prms-reporting-dev", "prms-reporting-dev"]),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DefinitionValidationError &&
          error.issues.some((i) => i.rule === "deployment-duplicate" && i.field === "deployment(prms-reporting-dev)/deploymentId"),
      );
    });
  });
});
