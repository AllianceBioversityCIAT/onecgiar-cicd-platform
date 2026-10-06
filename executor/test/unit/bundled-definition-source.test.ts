// @akili-spec changes/cicd-executor-poc design DD-19; requirements FR-01
// Unit tests for the BundledDefinitionSource adapter: reads the real,
// versioned deployment-definitions/, schemas/ and deploy-scripts/ (T-14)
// directories, resolves definitionRef from
// CICD_DEFINITION_REF (refusing to start in production when it is missing —
// T-03 attempt 2, design DD-19 / FR-01), and resolves the repo root from
// CICD_DEFINITIONS_ROOT when set, falling back to the dev-only walk-up
// otherwise.
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BundledDefinitionSource,
  DefinitionLoadError,
  DefinitionSourceError,
  DEV_FALLBACK_DEFINITION_REF,
  findRepoRoot,
} from "../../src/adapters/bundled-definition-source/index.js";
import { repoRoot } from "../contract/support/schema-paths.js";

describe("BundledDefinitionSource", () => {
  it("reads the real, versioned PRMS Reporting DEV deployment definition by deploymentId", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const { content } = await source.getDeploymentDefinition("prms-reporting-dev");
    expect(content).toContain("deploymentId: prms-reporting-dev");
  });

  it("throws a clear error for an unknown deploymentId", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    await expect(source.getDeploymentDefinition("does-not-exist")).rejects.toThrow(DefinitionSourceError);
  });

  it("reads the real, versioned target registry", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const { content } = await source.getTargetRegistry();
    expect(content).toContain("prms-reporting-dev:");
  });

  it("reads a schema by name", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const { content } = await source.getSchema("deployment.schema.json");
    expect(JSON.parse(content).title).toBe("Deployment Definition");
  });

  it("throws a clear error for an unknown schema name", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    await expect(source.getSchema("does-not-exist.schema.json")).rejects.toThrow(DefinitionSourceError);
  });

  it("reads the real, versioned generic deploy script (T-14, DD-10)", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const { content } = await source.getDeployScript("deploy-container.sh");
    expect(content).toContain("#!/usr/bin/env bash");
    expect(content).toContain("CICD_RESULT");
  });

  it("throws a clear error for an unknown deploy script name", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    await expect(source.getDeployScript("does-not-exist.sh")).rejects.toThrow(DefinitionSourceError);
  });

  it("every call returns the same definitionRef", async () => {
    const source = new BundledDefinitionSource({ repoRoot });
    const [deployment, registry] = await Promise.all([
      source.getDeploymentDefinition("prms-reporting-dev"),
      source.getTargetRegistry(),
    ]);
    expect(deployment.definitionRef).toBe(registry.definitionRef);
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

  it("findRepoRoot throws a clear error when no ancestor has both deployment-definitions/ and schemas/", () => {
    expect(() => findRepoRoot(os.tmpdir())).toThrow(/could not locate the platform repo root/);
  });

  it("rejects two definition files declaring the same deploymentId (single-source invariant, DD-27)", async () => {
    const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "cicd-duplicate-deployment-"));
    mkdirSync(path.join(fakeRoot, "deployment-definitions", "a"), { recursive: true });
    mkdirSync(path.join(fakeRoot, "deployment-definitions", "b"), { recursive: true });
    mkdirSync(path.join(fakeRoot, "schemas"));
    writeFileSync(path.join(fakeRoot, "deployment-definitions", "a", "x.yaml"), "deploymentId: dup-deployment\n");
    writeFileSync(path.join(fakeRoot, "deployment-definitions", "b", "y.yaml"), "deploymentId: dup-deployment\n");
    const source = new BundledDefinitionSource({ repoRoot: fakeRoot, env: {} });
    await expect(source.getDeploymentDefinition("dup-deployment")).rejects.toThrow(/more than one definition/);
  });

  describe("repo root resolution via CICD_DEFINITIONS_ROOT", () => {
    it("uses CICD_DEFINITIONS_ROOT directly, bypassing the walk-up, when set", async () => {
      const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "cicd-definitions-root-"));
      mkdirSync(path.join(fakeRoot, "deployment-definitions", "targets"), { recursive: true });
      mkdirSync(path.join(fakeRoot, "schemas"));
      writeFileSync(path.join(fakeRoot, "deployment-definitions", "targets", "dev.yaml"), "fake-target-registry: {}\n");

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

describe("BundledDefinitionSource.listDeploymentIds fails fast on any unusable definition file (owner decision 2026-10-06)", () => {
  const VALID = "deploymentId: valid-deployment\n";
  function rootWith(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "cicd-failfast-"));
    mkdirSync(path.join(root, "schemas"));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, "deployment-definitions", rel)), { recursive: true });
      writeFileSync(path.join(root, "deployment-definitions", rel), content);
    }
    return root;
  }
  const sourceOf = (root: string): BundledDefinitionSource => new BundledDefinitionSource({ repoRoot: root, env: {} });

  it("lists the ids (sorted) when every file is valid and the registry carries no deploymentId", async () => {
    const root = rootWith({ "b.yaml": "deploymentId: zeta\n", "a/x.yml": "deploymentId: alpha\n", "targets/dev.yaml": "targets: {}\n" });
    expect(await sourceOf(root).listDeploymentIds()).toEqual(["alpha", "zeta"]);
  });

  it("rejects an unparsable file next to a valid one, naming the file and position and never echoing its content", async () => {
    const root = rootWith({ "ok.yaml": VALID, "prms/broken.yaml": "key: [unclosed\n  sentinel-content-xyz: {\n" });
    const error = (await sourceOf(root).listDeploymentIds().catch((e: unknown) => e)) as DefinitionLoadError;
    expect(error).toBeInstanceOf(DefinitionLoadError);
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]!.file).toBe(path.join("deployment-definitions", "prms", "broken.yaml"));
    expect(error.problems[0]!.reason).toMatch(/YAML parse error \(\w+\) at line \d+, column \d+/);
    expect(error.message).not.toContain("sentinel-content-xyz");
  });

  it("rejects an unparsable target registry", async () => {
    const root = rootWith({ "ok.yaml": VALID, "targets/dev.yaml": "a: [\n" });
    await expect(sourceOf(root).listDeploymentIds()).rejects.toThrow(/targets[\\/]dev\.yaml: YAML parse error/);
  });

  it("rejects a non-registry file without a string deploymentId", async () => {
    const root = rootWith({ "ok.yaml": VALID, "stray.yaml": "foo: bar\n", "numeric.yaml": "deploymentId: 7\n" });
    const error = (await sourceOf(root).listDeploymentIds().catch((e: unknown) => e)) as DefinitionLoadError;
    expect(error.problems.map((p) => p.file)).toEqual([
      path.join("deployment-definitions", "numeric.yaml"),
      path.join("deployment-definitions", "stray.yaml"),
    ]);
    expect(error.problems[0]!.reason).toContain("no string deploymentId");
  });

  it("rejects a duplicate deploymentId across files", async () => {
    const root = rootWith({ "a.yaml": VALID, "b.yaml": VALID });
    const error = (await sourceOf(root).listDeploymentIds().catch((e: unknown) => e)) as DefinitionLoadError;
    expect(error.problems).toEqual([{ file: path.join("deployment-definitions", "b.yaml"), reason: expect.stringContaining('duplicate deploymentId "valid-deployment"') }]);
  });

  describe("strict entry types under deployment-definitions/", () => {
    const reasonsOf = async (root: string) => ((await sourceOf(root).listDeploymentIds().catch((e: unknown) => e)) as DefinitionLoadError).problems;

    it("rejects a wrong-case extension", async () => {
      const root = rootWith({ "ok.yaml": VALID, "Upper.YAML": VALID, "Mixed.Yml": VALID });
      const problems = await reasonsOf(root);
      expect(problems.map((p) => p.file).sort()).toEqual([path.join("deployment-definitions", "Mixed.Yml"), path.join("deployment-definitions", "Upper.YAML")].sort());
      expect(problems.every((p) => p.reason === "definition files must use the lowercase .yaml or .yml extension")).toBe(true);
    });

    it("rejects any other file (README.md, x.yaml.bak, x.json)", async () => {
      const root = rootWith({ "ok.yaml": VALID, "README.md": "# hi\n", "x.yaml.bak": VALID, "x.json": "{}" });
      const problems = await reasonsOf(root);
      expect(problems).toHaveLength(3);
      expect(problems.every((p) => p.reason.startsWith("unexpected file in deployment-definitions/"))).toBe(true);
    });

    it("rejects a symbolic link to a file and to a directory", async () => {
      const root = rootWith({ "ok.yaml": VALID, "real/inner.yaml": "deploymentId: inner\n" });
      const base = path.join(root, "deployment-definitions");
      try {
        symlinkSync(path.join(base, "ok.yaml"), path.join(base, "link.yaml"), "file");
        symlinkSync(path.join(base, "real"), path.join(base, "linkdir"), "junction");
      } catch (error) {
        // Only when the OS cannot create a symlink (e.g. Windows without the privilege).
        console.warn(`symlink test skipped: ${(error as { code?: string }).code}`);
        return;
      }
      const problems = await reasonsOf(root);
      expect(problems.map((p) => p.file).sort()).toEqual([path.join("deployment-definitions", "link.yaml"), path.join("deployment-definitions", "linkdir")].sort());
      expect(problems.every((p) => p.reason === "unsupported entry type (symbolic link)")).toBe(true);
    });
  });

  it("reports ALL problems at once", async () => {
    const root = rootWith({ "ok.yaml": VALID, "bad1.yaml": "a: [\n", "bad2.yaml": "foo: bar\n", "dup.yaml": VALID });
    const error = (await sourceOf(root).listDeploymentIds().catch((e: unknown) => e)) as DefinitionLoadError;
    expect(error.problems).toHaveLength(3);
  });
});
