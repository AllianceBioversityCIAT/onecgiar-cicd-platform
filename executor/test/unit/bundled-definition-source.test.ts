// @akili-spec changes/cicd-executor-poc design DD-19; requirements FR-01
// Unit tests for the BundledDefinitionSource adapter: reads the real,
// versioned pipeline-definitions/, schemas/ and (absent, in this repo state)
// deploy-scripts/ directories, resolves definitionRef from
// CICD_DEFINITION_REF (refusing to start in production when it is missing —
// T-03 attempt 2, design DD-19 / FR-01), and resolves the repo root from
// CICD_DEFINITIONS_ROOT when set, falling back to the dev-only walk-up
// otherwise.
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BundledDefinitionSource,
  DefinitionSourceError,
  DEV_FALLBACK_DEFINITION_REF,
  findRepoRoot,
} from "../../src/adapters/bundled-definition-source/index.js";
import { repoRoot } from "../contract/support/schema-paths.js";

describe("BundledDefinitionSource", () => {
  it("reads the real, versioned PRMS Reporting DEV pipeline definition by pipelineId", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const { content } = await source.getPipelineDefinition("prms-reporting-dev");
    expect(content).toContain("pipelineId: prms-reporting-dev");
  });

  it("throws a clear error for an unknown pipelineId", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    await expect(source.getPipelineDefinition("does-not-exist")).rejects.toThrow(DefinitionSourceError);
  });

  it("reads the real, versioned target registry", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const { content } = await source.getTargetRegistry();
    expect(content).toContain("prms-reporting-dev:");
  });

  it("reads a schema by name", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const { content } = await source.getSchema("pipeline.schema.json");
    expect(JSON.parse(content).title).toBe("Pipeline Definition");
  });

  it("throws a clear error for an unknown schema name", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    await expect(source.getSchema("does-not-exist.schema.json")).rejects.toThrow(DefinitionSourceError);
  });

  it("throws a clear error for a deploy script, since deploy-container.sh itself does not exist yet (deploy-scripts/ only has a README placeholder — arrives in T-14, DD-10)", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    await expect(source.getDeployScript("deploy-container.sh")).rejects.toThrow(DefinitionSourceError);
  });

  it("every call returns the same definitionRef", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const [pipeline, registry] = await Promise.all([
      source.getPipelineDefinition("prms-reporting-dev"),
      source.getTargetRegistry(),
    ]);
    expect(pipeline.definitionRef).toBe(registry.definitionRef);
  });

  describe("definitionRef resolution", () => {
    it("uses CICD_DEFINITION_REF when set", async () => {
      const source = new BundledDefinitionSource({ repoRoot, env: { CICD_DEFINITION_REF: "abc1234" } });
      const { definitionRef } = await source.getTargetRegistry();
      expect(definitionRef).toBe("abc1234");
    });

    it("falls back to a clearly-labelled dev sentinel when nothing is injected and requireInjectedRef is not set", async () => {
      const source = new BundledDefinitionSource({ repoRoot, env: {} });
      const { definitionRef } = await source.getTargetRegistry();
      expect(definitionRef).toBe(DEV_FALLBACK_DEFINITION_REF);
      expect(definitionRef).toMatch(/dev/i);
    });

    // T-03 attempt 2 (Issue 3): the real Dockerfile runtime stage sets
    // NODE_ENV=production. Omitting --build-arg DEFINITION_REF must NOT
    // silently start with the dev sentinel in that case — FR-01 requires a
    // real definitionRef per execution.
    it("refuses to start when NODE_ENV=production and no CICD_DEFINITION_REF was injected", () => {
      expect(() => new BundledDefinitionSource({ repoRoot, env: { NODE_ENV: "production" } })).toThrow(
        DefinitionSourceError,
      );
      expect(() => new BundledDefinitionSource({ repoRoot, env: { NODE_ENV: "production" } })).toThrow(
        /CICD_DEFINITION_REF/,
      );
    });

    it("still starts in production when CICD_DEFINITION_REF IS injected", async () => {
      const source = new BundledDefinitionSource({
        repoRoot,
        env: { NODE_ENV: "production", CICD_DEFINITION_REF: "deadbeef" },
      });
      const { definitionRef } = await source.getTargetRegistry();
      expect(definitionRef).toBe("deadbeef");
    });

    it("the requireInjectedRef override forces the same refusal outside production (tests only)", () => {
      expect(() => new BundledDefinitionSource({ repoRoot, env: {}, requireInjectedRef: true })).toThrow(
        DefinitionSourceError,
      );
    });
  });

  it("findRepoRoot throws a clear error when no ancestor has both pipeline-definitions/ and schemas/", () => {
    expect(() => findRepoRoot(os.tmpdir())).toThrow(/could not locate the platform repo root/);
  });

  describe("repo root resolution via CICD_DEFINITIONS_ROOT", () => {
    it("uses CICD_DEFINITIONS_ROOT directly, bypassing the walk-up, when set", async () => {
      const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "cicd-definitions-root-"));
      mkdirSync(path.join(fakeRoot, "pipeline-definitions", "targets"), { recursive: true });
      mkdirSync(path.join(fakeRoot, "schemas"));
      writeFileSync(path.join(fakeRoot, "pipeline-definitions", "targets", "dev.yaml"), "fake-target-registry: {}\n");

      const source = new BundledDefinitionSource({ env: { CICD_DEFINITIONS_ROOT: fakeRoot } });
      const { content } = await source.getTargetRegistry();
      expect(content).toContain("fake-target-registry");
    });

    it("falls back to the dev-only walk-up when CICD_DEFINITIONS_ROOT is absent", async () => {
      const source = new BundledDefinitionSource({ env: {} });
      const { content } = await source.getTargetRegistry();
      expect(content).toContain("prms-reporting-dev:");
    });
  });
});
