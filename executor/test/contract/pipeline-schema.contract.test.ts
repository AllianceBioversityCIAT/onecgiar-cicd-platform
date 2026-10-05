// @akili-spec changes/cicd-executor-poc requirements FR-01; design DD-19, DD-23, proposal 10.4
//
// Contract tests for schemas/pipeline.schema.json (repo root). Proves:
//  1. The real, versioned pipeline-definitions/prms/reporting-dev.yaml parses
//     and validates (positive case).
//  2. A negative corpus, one fixture per FR-01 rule, each fails validation.
//
// Each negative fixture is a deep-cloned mutation of the SAME valid base
// document used for the positive case, changing exactly one thing — so a
// failure can only come from the rule under test, never from an unrelated
// difference (anti "inert fixture").
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, beforeAll } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { pipelineSchemaPath, prmsReportingDevYamlPath } from "./support/schema-paths.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("schemas/pipeline.schema.json (FR-01)", () => {
  let validate: ValidateFunction;
  let validDefinition: Record<string, unknown>;

  beforeAll(() => {
    const ajv = createAjv();
    const schema = readJsonSchema(pipelineSchemaPath);
    validate = ajv.compile(schema);
    validDefinition = parseYaml(readFileSync(prmsReportingDevYamlPath, "utf8"));
  });

  it("accepts the real, versioned PRMS Reporting DEV definition", () => {
    const ok = validate(validDefinition);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  describe("negative corpus — one case per FR-01 rule", () => {
    it("rejects an unknown step type", () => {
      const fixture = clone(validDefinition);
      (fixture.steps as Array<Record<string, unknown>>)[0]!.type = "bogus-type";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a reserved-but-not-enabled step type (s3-sync)", () => {
      const fixture = clone(validDefinition);
      (fixture.steps as Array<Record<string, unknown>>)[0]!.type = "s3-sync";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an embedded script/expression construct (unknown field on a step)", () => {
      const fixture = clone(validDefinition);
      const step = (fixture.steps as Array<Record<string, unknown>>)[0]!;
      (step.with as Record<string, unknown>).script =
        "for f in *.js; do rm \"$f\"; done";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects environment=prod", () => {
      const fixture = clone(validDefinition);
      fixture.environment = "prod";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a codebuild step without an explicit project", () => {
      const fixture = clone(validDefinition);
      const steps = fixture.steps as Array<Record<string, unknown>>;
      const codebuildStep = steps.find((s) => s.type === "codebuild")!;
      delete (codebuildStep.with as Record<string, unknown>).project;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects interpolation outside the whitelist (${env.*})", () => {
      const fixture = clone(validDefinition);
      const steps = fixture.steps as Array<Record<string, unknown>>;
      const sshStep = steps.find((s) => s.type === "ssh")!;
      (sshStep.with as Record<string, unknown>).args = [
        "--execution-id=${execution.id}",
        "--secret=${env.AWS_SECRET_ACCESS_KEY}",
      ];
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a GitHub-Actions-style expression construct (${{ ... }})", () => {
      const fixture = clone(validDefinition);
      const steps = fixture.steps as Array<Record<string, unknown>>;
      const sshStep = steps.find((s) => s.type === "ssh")!;
      (sshStep.with as Record<string, unknown>).args = ["${{ 1 + 1 }}"];
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a shell command-substitution construct ($(...)) embedded in an ssh arg", () => {
      const fixture = clone(validDefinition);
      const steps = fixture.steps as Array<Record<string, unknown>>;
      const sshStep = steps.find((s) => s.type === "ssh")!;
      (sshStep.with as Record<string, unknown>).args = ["--x=$(rm -rf /)"];
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a backtick command-substitution construct embedded in an ssh arg", () => {
      const fixture = clone(validDefinition);
      const steps = fixture.steps as Array<Record<string, unknown>>;
      const sshStep = steps.find((s) => s.type === "ssh")!;
      (sshStep.with as Record<string, unknown>).args = ["--x=`id`"];
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a shell metacharacter (;) in an ssh arg, since args are passed literally", () => {
      const fixture = clone(validDefinition);
      const steps = fixture.steps as Array<Record<string, unknown>>;
      const sshStep = steps.find((s) => s.type === "ssh")!;
      (sshStep.with as Record<string, unknown>).args = ["--unit=prms-reporting-dev-unit; rm -rf /"];
      expect(validate(fixture)).toBe(false);
    });
  });
});
