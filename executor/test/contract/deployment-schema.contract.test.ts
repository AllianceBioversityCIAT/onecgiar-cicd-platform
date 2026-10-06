/* eslint-disable @typescript-eslint/no-explicit-any -- negative fixtures mutate arbitrary nested JSON */
// @akili-spec changes/cicd-executor-poc requirements FR-01; design 6.2, DD-19, DD-23
//
// Contract tests for schemas/deployment.schema.json. The real, versioned
// deployment-definitions/prms/reporting-dev.yaml must validate; negative
// fixtures assert the offending field, including NESTED objects. Cross-document
// rules (unit set equality with the request, reference resolution, migration
// attestation) are NOT schema-expressible and are left to semantic validation.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { deploymentSchemaPath, prmsReportingDevDeploymentYamlPath } from "./support/schema-paths.js";
import { clone, violations } from "./support/violations.js";

describe("schemas/deployment.schema.json (FR-01)", () => {
  let validate: ValidateFunction;
  let base: Record<string, any>;

  beforeAll(() => {
    validate = createAjv().compile(readJsonSchema(deploymentSchemaPath));
    base = parseYaml(readFileSync(prmsReportingDevDeploymentYamlPath, "utf8"));
  });

  it("validates the PRMS Reporting DEV definition", () => {
    expect(validate(base), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a definition without migration and with a health command", () => {
    const d = clone(base);
    delete d.migration;
    d.health = { "<SERVER_CONTAINER>": { command: "check-health" } };
    expect(validate(d), JSON.stringify(validate.errors)).toBe(true);
  });

  const negatives: Array<[string, (d: Record<string, any>) => void, string]> = [
    ["an extra top-level field", (d) => { d.extra = 1; }, " additionalProperties extra"],
    ["a host field at top level", (d) => { d.host = "<HOST>"; }, " additionalProperties host"],
    ["a steps list", (d) => { d.steps = []; }, " additionalProperties steps"],
    ["a needs field", (d) => { d.needs = []; }, " additionalProperties needs"],
    ["a when field", (d) => { d.when = "always"; }, " additionalProperties when"],
    ["an extra field in source", (d) => { d.source.extra = "x"; }, "/source additionalProperties extra"],
    ["an extra field in an artifacts[] item", (d) => { d.artifacts[0].extra = "x"; }, "/artifacts/0 additionalProperties extra"],
    ["an artifacts[] item missing its unit", (d) => { delete d.artifacts[0].unit; }, "/artifacts/0 required unit"],
    ["an extra field in migration", (d) => { d.migration.extra = "x"; }, "/migration additionalProperties extra"],
    ["an invalid migration mode", (d) => { d.migration.mode = "inline"; }, "/migration/mode enum"],
    ["an extra field in notifications", (d) => { d.notifications.extra = "x"; }, "/notifications additionalProperties extra"],
    ["an extra field in notifications.slack", (d) => { d.notifications.slack.extra = "x"; }, "/notifications/slack additionalProperties extra"],
    ["a wrong schemaVersion", (d) => { d.schemaVersion = 2; }, "/schemaVersion const"],
    ["an environment other than dev", (d) => { d.environment = "prod"; }, "/environment const"],
    ["a script outside the bundled enum", (d) => { d.deployScript = "custom.sh"; }, "/deployScript enum"],
    ["a timeout above 60 minutes", (d) => { d.timeoutMinutes = 61; }, "/timeoutMinutes maximum"],
    ["a missing targetRef", (d) => { delete d.targetRef; }, " required targetRef"],
    ["a missing allowedSenderRef", (d) => { delete d.allowedSenderRef; }, " required allowedSenderRef"],
    ["a raw (non-logical) allowedSenderRef", (d) => { d.allowedSenderRef = "arn:aws:iam::123456789012:role/x"; }, "/allowedSenderRef pattern"],
    ["a raw (non-logical) source.repositoryRef", (d) => { d.source.repositoryRef = "example-org/repo"; }, "/source/repositoryRef pattern"],
    ["an interpolation in a migration command", (d) => { d.migration.runCommand = "run ${X}"; }, "/migration/runCommand pattern"],
    [
      "a health entry with both command and url",
      (d) => { d.health["<SERVER_CONTAINER>"] = { command: "c", url: "<U>" }; },
      "/health/<SERVER_CONTAINER> oneOf",
    ],
    [
      "an extra field in a health entry",
      (d) => { d.health["<SERVER_CONTAINER>"] = { url: "<U>", extra: 1 }; },
      "/health/<SERVER_CONTAINER> additionalProperties extra",
    ],
    ["an invalid deploymentId", (d) => { d.deploymentId = "Bad_Id"; }, "/deploymentId pattern"],
    ["no artifacts", (d) => { d.artifacts = []; }, "/artifacts minItems"],
  ];

  it.each(negatives)("rejects %s", (_name, mutate, expected) => {
    const d = clone(base);
    mutate(d);
    expect(validate(d)).toBe(false);
    expect(violations(validate)).toContain(expected);
  });
});
