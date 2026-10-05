// @akili-spec changes/cicd-executor-poc design DD-19
//
// Substitution test (DD-19 'Definitions behind DefinitionSource'):
// definition-service.validateForCi takes a DefinitionSource and must behave
// identically no matter which implementation backs it — the planner/handlers
// -facing surface depends ONLY on the port. Here the SAME call is made once
// against BundledDefinitionSource (the real, fs-backed PoC adapter) and once
// against an in-memory fake that touches no filesystem at all; the
// definitionRef each one returns comes straight from whatever the injected
// source said, proving definition-service has no hidden fs dependency of its
// own (see this task's Falsifier: making definition-service read
// pipeline-definitions/ directly turns this test red).
import { readFileSync } from "node:fs";
import { describe, expect, it, beforeAll } from "vitest";
import {
  pipelineSchemaPath,
  targetsSchemaPath,
  prmsReportingDevYamlPath,
  targetsDevYamlPath,
} from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";
import { BundledDefinitionSource } from "../../src/adapters/bundled-definition-source/index.js";
import { validateForCi } from "../../src/application/definition-service/index.js";

describe("definition-service depends only on the DefinitionSource port (DD-19 substitution)", () => {
  let pipelineSchemaContent: string;
  let targetsSchemaContent: string;
  let pipelineDefinitionContent: string;
  let targetRegistryContent: string;

  beforeAll(() => {
    pipelineSchemaContent = readFileSync(pipelineSchemaPath, "utf8");
    targetsSchemaContent = readFileSync(targetsSchemaPath, "utf8");
    pipelineDefinitionContent = readFileSync(prmsReportingDevYamlPath, "utf8");
    targetRegistryContent = readFileSync(targetsDevYamlPath, "utf8");
  });

  it("validates the same pipeline identically whether backed by the bundled (fs) adapter or an in-memory fake", async () => {
    const bundled = new BundledDefinitionSource();
    const bundledResult = await validateForCi({ definitionSource: bundled }, ["prms-reporting-dev"]);

    const FAKE_DEFINITION_REF = "in-memory-fake-ref-does-not-exist-on-disk";
    const fake = new InMemoryDefinitionSource({
      pipelines: { "prms-reporting-dev": pipelineDefinitionContent },
      targetRegistry: targetRegistryContent,
      schemas: {
        "pipeline.schema.json": pipelineSchemaContent,
        "targets.schema.json": targetsSchemaContent,
      },
      definitionRef: FAKE_DEFINITION_REF,
    });
    const fakeResult = await validateForCi({ definitionSource: fake }, ["prms-reporting-dev"]);

    // Same pipelineId, same validation outcome — the only thing that
    // legitimately differs is definitionRef, and it differs EXACTLY the way
    // the injected port said it would. If definition-service read
    // pipeline-definitions/ off disk itself, the fake's definitionRef could
    // never surface here because the content would always come from fs
    // regardless of which DefinitionSource was passed in.
    expect(fakeResult.pipelines[0]!.definitionRef).toBe(FAKE_DEFINITION_REF);
    expect(bundledResult.pipelines[0]!.pipelineId).toBe(fakeResult.pipelines[0]!.pipelineId);
    expect(bundledResult.pipelines[0]!.definition).toEqual(fakeResult.pipelines[0]!.definition);
    expect(bundledResult.registry.entries).toEqual(fakeResult.registry.entries);
  });
});
