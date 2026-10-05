// @akili-spec changes/cicd-executor-poc requirements FR-01; design §7 (definition-service row), DD-19
//
// definition-service.validateForCi: Pipeline Definition semantic rules that
// schemas/pipeline.schema.json (T-02) either cannot express (needs cycles,
// nonexistent needs) or expresses only generically (reserved step types —
// here it must get the specific "reserved type, not enabled" message,
// FR-01 scenario 'reserved type'). Each negative case is a deep-cloned
// mutation of the SAME valid base document, changing exactly one thing.
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

describe("definition-service.validateForCi — Pipeline Definition semantic rules (FR-01)", () => {
  let pipelineSchemaContent: string;
  let targetsSchemaContent: string;
  let validDefinition: Record<string, unknown>;
  let targetRegistryContent: string;

  beforeAll(() => {
    pipelineSchemaContent = readFileSync(pipelineSchemaPath, "utf8");
    targetsSchemaContent = readFileSync(targetsSchemaPath, "utf8");
    validDefinition = parseYaml(readFileSync(prmsReportingDevYamlPath, "utf8"));
    targetRegistryContent = readFileSync(targetsDevYamlPath, "utf8");
  });

  function sourceWith(definition: Record<string, unknown>): InMemoryDefinitionSource {
    return new InMemoryDefinitionSource({
      pipelines: { "prms-reporting-dev": stringifyYaml(definition) },
      targetRegistry: targetRegistryContent,
      schemas: {
        "pipeline.schema.json": pipelineSchemaContent,
        "targets.schema.json": targetsSchemaContent,
      },
      definitionRef: "test-fixture-ref",
    });
  }

  it("accepts the real, versioned PRMS Reporting DEV definition and records its definitionRef", async () => {
    const result = await validateForCi({ definitionSource: sourceWith(validDefinition) }, ["prms-reporting-dev"]);
    expect(result.pipelines).toHaveLength(1);
    expect(result.pipelines[0]!.pipelineId).toBe("prms-reporting-dev");
    expect(result.pipelines[0]!.definitionRef).toBe("test-fixture-ref");
  });

  it("rejects a reserved step type with the specific message 'reserved type, not enabled'", async () => {
    const fixture = clone(validDefinition);
    (fixture.steps as Array<Record<string, unknown>>)[0] = {
      id: "server-quality",
      type: "s3-sync",
      with: {},
    };
    await expect(validateForCi({ definitionSource: sourceWith(fixture) }, ["prms-reporting-dev"])).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError &&
        error.issues.some((i) => i.rule === "reserved-step-type" && i.message === 'reserved type, not enabled: "s3-sync"'),
    );
  });

  it("rejects a `needs` entry pointing at a nonexistent step id", async () => {
    const fixture = clone(validDefinition);
    const steps = fixture.steps as Array<Record<string, unknown>>;
    const deployStep = steps.find((s) => s.id === "deploy")!;
    deployStep.needs = ["server-image", "client-image", "does-not-exist"];
    await expect(validateForCi({ definitionSource: sourceWith(fixture) }, ["prms-reporting-dev"])).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DefinitionValidationError &&
        error.issues.some((i) => i.rule === "needs-nonexistent" && i.message.includes("does-not-exist")),
    );
  });

  it("rejects a cycle in `needs`", async () => {
    const fixture = clone(validDefinition);
    const steps = fixture.steps as Array<Record<string, unknown>>;
    const serverQuality = steps.find((s) => s.id === "server-quality")!;
    const serverImage = steps.find((s) => s.id === "server-image")!;
    // server-image already needs server-quality; close the loop the other way.
    serverQuality.needs = ["server-image"];
    void serverImage; // needs: [server-quality] already present in the fixture.
    await expect(validateForCi({ definitionSource: sourceWith(fixture) }, ["prms-reporting-dev"])).rejects.toSatisfy(
      (error: unknown) => error instanceof DefinitionValidationError && error.issues.some((i) => i.rule === "needs-cycle"),
    );
  });

  it("rejects environment != dev end-to-end through the service (schema-level FR-01 scenario 'environment out of scope')", async () => {
    const fixture = clone(validDefinition);
    fixture.environment = "prod";
    await expect(validateForCi({ definitionSource: sourceWith(fixture) }, ["prms-reporting-dev"])).rejects.toSatisfy(
      (error: unknown) => error instanceof DefinitionValidationError && error.issues.some((i) => i.rule === "schema"),
    );
  });

  it("rejects interpolation outside the whitelist end-to-end through the service", async () => {
    const fixture = clone(validDefinition);
    const steps = fixture.steps as Array<Record<string, unknown>>;
    const sshStep = steps.find((s) => s.type === "ssh")!;
    (sshStep.with as Record<string, unknown>).args = ["--secret=${env.AWS_SECRET_ACCESS_KEY}"];
    await expect(validateForCi({ definitionSource: sourceWith(fixture) }, ["prms-reporting-dev"])).rejects.toSatisfy(
      (error: unknown) => error instanceof DefinitionValidationError && error.issues.some((i) => i.rule === "schema"),
    );
  });

  it("does NOT create the execution / return pipelines on a rejected definition (FR-01: it must NOT create the execution)", async () => {
    const fixture = clone(validDefinition);
    fixture.environment = "prod";
    await expect(validateForCi({ definitionSource: sourceWith(fixture) }, ["prms-reporting-dev"])).rejects.toBeInstanceOf(
      DefinitionValidationError,
    );
  });
});
