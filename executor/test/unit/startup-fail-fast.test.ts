// @akili-spec changes/cicd-executor-poc design §6.2, DD-19, DD-23; owner decision 2026-10-06 (fail fast)
// Startup never proceeds with a partially valid definition set: every definition file is discovered, parsed and
// validated before any consumer, poller, heartbeat or queue call exists. Tested at bootstrap level (the real
// BundledDefinitionSource over a temporary definitions root) plus the pure function main uses to print the refusal.
// main/index.ts itself is a top-level-await entry point without a harness; its only added behavior is
// `describeStartupFailure(error)` on stderr and exit code 1, covered through that function.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DefinitionLoadError } from "../../src/adapters/bundled-definition-source/index.js";
import { DefinitionValidationError } from "../../src/application/definition-service/index.js";
import { bootstrap } from "../../src/main/bootstrap.js";
import { describeStartupFailure } from "../../src/main/definition-diagnosis.js";
import { repoRoot } from "../contract/support/schema-paths.js";
import { fakeSecrets, validEnv } from "../support/composition-fixtures.js";

function definitionsRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cicd-startup-"));
  for (const dir of ["deployment-definitions", "schemas", "deploy-scripts"]) cpSync(path.join(repoRoot, dir), path.join(root, dir), { recursive: true });
  return root;
}

function attempt(root: string) {
  const touched: string[] = [];
  const result = bootstrap({
    env: validEnv({ CICD_DEFINITIONS_ROOT: root }),
    secrets: fakeSecrets(),
    documentClient: {} as never,
    publisher: { publish: async () => (touched.push("publish"), { messageId: "x" }) },
    createConsumer: () => (touched.push("createConsumer"), { start: async () => void touched.push("start"), stop: async () => {} }),
  });
  return { result, touched };
}

describe("startup fails fast on an invalid definition set (owner decision 2026-10-06)", () => {
  it("starts with the untouched bundled definitions (control)", async () => {
    const { result, touched } = attempt(definitionsRoot());
    const executor = await result;
    expect(executor.deploymentIds).toContain("prms-reporting-dev");
    expect(touched).toContain("createConsumer"); // consumers are only built after validation
  });

  it("an unparsable file next to valid ones is rejected, naming the file, and no consumer or queue call exists", async () => {
    const root = definitionsRoot();
    writeFileSync(path.join(root, "deployment-definitions", "prms", "broken.yaml"), "key: [unclosed\n  sentinel-content-xyz: {\n");
    const { result, touched } = attempt(root);
    const error = (await result.catch((e: unknown) => e)) as DefinitionLoadError;
    expect(error).toBeInstanceOf(DefinitionLoadError);
    expect(error.message).toContain(path.join("deployment-definitions", "prms", "broken.yaml"));
    expect(error.message).not.toContain("sentinel-content-xyz");
    expect(touched).toEqual([]);
  });

  it("a parsable but semantically invalid definition is rejected naming the file and the reason, before anything starts", async () => {
    const root = definitionsRoot();
    const file = path.join(root, "deployment-definitions", "prms", "reporting-dev.yaml");
    const invalid = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete invalid["targetRef"];
    writeFileSync(file, stringifyYaml(invalid));
    const { result, touched } = attempt(root);
    const error = (await result.catch((e: unknown) => e)) as DefinitionValidationError;
    expect(error).toBeInstanceOf(DefinitionValidationError);
    expect(error.message).toContain(path.join("deployment-definitions", "prms", "reporting-dev.yaml"));
    expect(error.message).toContain("targetRef");
    expect(touched).toEqual([]);
  });

  it("two deployments with the same unknown targetRef: BOTH files are named", async () => {
    const root = definitionsRoot();
    const first = path.join(root, "deployment-definitions", "prms", "reporting-dev.yaml");
    const second = path.join(root, "deployment-definitions", "prms", "second.yaml");
    const text = readFileSync(first, "utf8");
    writeFileSync(first, text.replace(/^targetRef:.*$/m, "targetRef: unknown-target"));
    writeFileSync(second, text.replace(/^targetRef:.*$/m, "targetRef: unknown-target").replace(/^deploymentId:.*$/m, "deploymentId: second-dev"));
    const { result, touched } = attempt(root);
    const error = (await result.catch((e: unknown) => e)) as DefinitionValidationError;
    expect(error).toBeInstanceOf(DefinitionValidationError);
    expect(error.message).toContain(path.join("deployment-definitions", "prms", "reporting-dev.yaml"));
    expect(error.message).toContain(path.join("deployment-definitions", "prms", "second.yaml"));
    expect(touched).toEqual([]);
  });

  it("describeStartupFailure lists a validation error across multiple files, one line each", () => {
    const lines = describeStartupFailure(
      new DefinitionValidationError([
        { rule: "schema", field: "deployment-definitions/a.yaml: targetRef", message: "unknown" },
        { rule: "schema", field: "deployment-definitions/b.yaml: targetRef", message: "unknown" },
      ]),
    );
    expect(lines).toEqual([
      "executor refused to start: 2 definition validation issue(s)",
      "  deployment-definitions/a.yaml: targetRef: unknown [schema]",
      "  deployment-definitions/b.yaml: targetRef: unknown [schema]",
    ]);
  });

  it("main prints one safe line per affected file (describeStartupFailure) and a refusal is exit code 1 by construction", () => {
    const lines = describeStartupFailure(new DefinitionLoadError([{ file: "deployment-definitions/a.yaml", reason: "YAML parse error (BAD_INDENT) at line 2, column 3" }]));
    expect(lines).toEqual(["executor refused to start: 1 definition file(s) cannot be loaded", "  deployment-definitions/a.yaml: YAML parse error (BAD_INDENT) at line 2, column 3"]);
    expect(describeStartupFailure(new Error("boom"))).toEqual(["executor refused to start: boom"]);
  });
});
