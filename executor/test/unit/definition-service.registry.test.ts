// @akili-spec changes/cicd-executor-poc requirements FR-02; design §7.7 (amended 2026-10-05), DD-21, DD-23
//
// definition-service.validateForCi: Target Registry semantic rules — here,
// specifically the ones JSON Schema cannot express: duplicate ports/
// container names on the same LOGICAL host (over the still-unresolved
// connectionRef/portRef values). Schema-level rules (host key presence, the
// window-policy oneOf shapes, migration attestation, the new migration
// script-name pattern) are covered by test/contract/targets-schema.contract.test.ts
// and are not duplicated here.
//
// Disqualifier guarded against: a registry with a SINGLE target can never
// reveal a duplicate-port/name collision — every fixture below declares
// >=2 targets sharing a host.
import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, beforeAll } from "vitest";
import {
  pipelineSchemaPath,
  targetsSchemaPath,
  prmsReportingDevYamlPath,
  targetsDevYamlPath,
} from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";
import { validateForCi, DefinitionValidationError } from "../../src/application/definition-service/index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("definition-service.validateForCi — Target Registry semantic rules (FR-02)", () => {
  let pipelineSchemaContent: string;
  let targetsSchemaContent: string;
  let pipelineDefinitionContent: string;
  let baseEntry: Record<string, unknown>;

  beforeAll(() => {
    pipelineSchemaContent = readFileSync(pipelineSchemaPath, "utf8");
    targetsSchemaContent = readFileSync(targetsSchemaPath, "utf8");
    pipelineDefinitionContent = readFileSync(prmsReportingDevYamlPath, "utf8");
    const registry = parseYaml(readFileSync(targetsDevYamlPath, "utf8")) as Record<string, Record<string, unknown>>;
    baseEntry = registry["prms-reporting-dev"]!;
  });

  function sourceWithRegistry(registry: Record<string, unknown>): InMemoryDefinitionSource {
    return new InMemoryDefinitionSource({
      pipelines: { "prms-reporting-dev": pipelineDefinitionContent },
      targetRegistry: stringifyYaml(registry),
      schemas: {
        "pipeline.schema.json": pipelineSchemaContent,
        "targets.schema.json": targetsSchemaContent,
      },
      definitionRef: "test-fixture-ref",
    });
  }

  it("accepts two targets on the same host declaring distinct container names and ports", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    // Keep entryA's containers as-is; give entryB its own names/ports/lockKey
    // so the only shared thing is the host (connectionRef).
    (entryB.containers as Array<Record<string, unknown>>)[0]!.name = "<OTHER_SERVER_CONTAINER>";
    (entryB.containers as Array<Record<string, unknown>>)[0]!.portRef = "<OTHER_SERVER_PORT_REF>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.name = "<OTHER_CLIENT_CONTAINER>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.portRef = "<OTHER_CLIENT_PORT_REF>";
    entryB.lockKey = "deployment#<PRMS_REPORTING_DEV_TARGET>#other-unit";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    const result = await validateForCi({ definitionSource: sourceWithRegistry(registry) }, ["prms-reporting-dev"]);
    expect(Object.keys(result.registry.entries)).toEqual(["prms-reporting-dev", "other-target"]);
  });

  it("rejects two targets on the same host (same connectionRef) declaring the same container name", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    // entryB keeps the SAME container name as entryA but gets fresh ports and a distinct lockKey.
    (entryB.containers as Array<Record<string, unknown>>)[0]!.portRef = "<OTHER_SERVER_PORT_REF>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.portRef = "<OTHER_CLIENT_PORT_REF>";
    entryB.lockKey = "deployment#<PRMS_REPORTING_DEV_TARGET>#other-unit";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    await expect(
      validateForCi({ definitionSource: sourceWithRegistry(registry) }, ["prms-reporting-dev"]),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError &&
        error.issues.some((i) => i.rule === "duplicate-container-name" && i.field.includes("other-target")),
    );
  });

  it("rejects two targets on the same host (same connectionRef) declaring the same portRef", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    // entryB keeps the SAME portRefs as entryA but gets fresh container names and a distinct lockKey.
    (entryB.containers as Array<Record<string, unknown>>)[0]!.name = "<OTHER_SERVER_CONTAINER>";
    (entryB.containers as Array<Record<string, unknown>>)[1]!.name = "<OTHER_CLIENT_CONTAINER>";
    entryB.lockKey = "deployment#<PRMS_REPORTING_DEV_TARGET>#other-unit";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    await expect(
      validateForCi({ definitionSource: sourceWithRegistry(registry) }, ["prms-reporting-dev"]),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError &&
        error.issues.some((i) => i.rule === "duplicate-port" && i.field.includes("other-target")),
    );
  });

  it("does not flag a duplicate port/name when the two targets are on DIFFERENT hosts", async () => {
    const entryA = clone(baseEntry);
    const entryB = clone(baseEntry);
    entryB.connectionRef = "<OTHER_HOST_CONNECTION_REF>"; // different host — same names/ports is fine.
    entryB.lockKey = "deployment#<OTHER_TARGET>#other-unit";

    const registry = { "prms-reporting-dev": entryA, "other-target": entryB };
    const result = await validateForCi({ definitionSource: sourceWithRegistry(registry) }, ["prms-reporting-dev"]);
    expect(Object.keys(result.registry.entries)).toHaveLength(2);
  });

  // T-03 attempt 2 (advisory): these rules already have dedicated contract
  // coverage against the raw schema (test/contract/targets-schema.contract.test.ts).
  // These three cases prove the SAME rejections surface through the full
  // definition-service.validateForCi path (Ajv wiring + ajvErrorsToIssues),
  // not just via a bare Ajv.compile call.
  describe("end-to-end through validateForCi: host key, window policy, migration attestation (§7.7, DD-11)", () => {
    it("rejects a registry entry missing hostKeyRef", async () => {
      const entry = clone(baseEntry);
      delete entry.hostKeyRef;
      const registry = { "prms-reporting-dev": entry };

      await expect(
        validateForCi({ definitionSource: sourceWithRegistry(registry) }, ["prms-reporting-dev"]),
      ).rejects.toBeInstanceOf(DefinitionValidationError);
    });

    it("rejects a registry entry that omits deployWindowPolicy entirely", async () => {
      const entry = clone(baseEntry);
      delete entry.deployWindowPolicy;
      const registry = { "prms-reporting-dev": entry };

      await expect(
        validateForCi({ definitionSource: sourceWithRegistry(registry) }, ["prms-reporting-dev"]),
      ).rejects.toBeInstanceOf(DefinitionValidationError);
    });

    it("rejects migrations enabled without migration attestation (migrationCompatibility/attestedBy)", async () => {
      const entry = clone(baseEntry);
      delete (entry.migration as Record<string, unknown>).attestedBy;
      const registry = { "prms-reporting-dev": entry };

      await expect(
        validateForCi({ definitionSource: sourceWithRegistry(registry) }, ["prms-reporting-dev"]),
      ).rejects.toBeInstanceOf(DefinitionValidationError);
    });
  });
});
