/* eslint-disable @typescript-eslint/no-explicit-any -- negative fixtures mutate arbitrary nested JSON */
// @akili-spec changes/cicd-executor-poc requirements FR-03; design 6.1; tasks R-4 (AC-02 V1)
//
// Contract tests for schemas/deploy-request.schema.json. Negative fixtures
// assert the offending field, including NESTED objects (artifacts, ci), so
// removing `additionalProperties: false` from a nested object turns a test red.
// Cross-field rules (requestId == ci.runId + "-" + ci.runAttempt, unit-set
// source authorization against the target record) are NOT schema-expressible and are covered by
// application-level validation, not here.
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { deployRequestSchemaPath } from "./support/schema-paths.js";
import { clone, violations } from "./support/violations.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const validRequest = {
  specVersion: 1,
  eventType: "DEPLOY_REQUESTED",
  requestId: "9876543210-1",
  targetId: "example-app-dev",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  artifacts: { server: DIGEST_A, client: DIGEST_B } as Record<string, string>,
  ci: {
    repository: "example-org/example-repo",
    workflowRef: "example-org/platform/.github/workflows/deploy.yml@refs/heads/main",
    runId: "9876543210",
    runAttempt: 1,
    runNumber: 42,
  },
};

describe("schemas/deploy-request.schema.json (FR-03)", () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    validate = createAjv().compile(readJsonSchema(deployRequestSchemaPath));
  });

  it("accepts a valid request", () => {
    expect(validate(validRequest), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a request with a single artifact unit", () => {
    const r = clone(validRequest);
    r.artifacts = { server: DIGEST_A };
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
  });

  const negatives: Array<[string, (r: Record<string, any>) => void, string]> = [
    ["a tag instead of a digest", (r) => { r.artifacts.server = "latest"; }, "/artifacts/server pattern"],
    ["a tag-qualified reference instead of a digest", (r) => { r.artifacts.server = "registry/app:1.2.3"; }, "/artifacts/server pattern"],
    ["an uppercase digest", (r) => { r.artifacts.server = `sha256:${"A".repeat(64)}`; }, "/artifacts/server pattern"],
    ["a short digest", (r) => { r.artifacts.server = `sha256:${"a".repeat(63)}`; }, "/artifacts/server pattern"],
    ["an extra top-level field", (r) => { r.extra = "x"; }, " additionalProperties extra"],
    ["an invalid unit key in artifacts", (r) => { r.artifacts["Bad_Unit"] = DIGEST_A; }, "/artifacts propertyNames Bad_Unit"],
    ["an extra nested field in ci", (r) => { r.ci.extra = "x"; }, "/ci additionalProperties extra"],
    ["a host field", (r) => { r.host = "<HOST>"; }, " additionalProperties host"],
    ["a nested host field in ci", (r) => { r.ci.host = "<HOST>"; }, "/ci additionalProperties host"],
    ["an image repository field", (r) => { r.imageRepository = "<REPO>"; }, " additionalProperties imageRepository"],
    ["an uppercase commitSha", (r) => { r.commitSha = "A".repeat(40); }, "/commitSha pattern"],
    ["a short commitSha", (r) => { r.commitSha = "abc123"; }, "/commitSha pattern"],
    ["a requestId of the wrong shape (no attempt)", (r) => { r.requestId = "9876543210"; }, "/requestId pattern"],
    ["a requestId with non-digits", (r) => { r.requestId = "req-184"; }, "/requestId pattern"],
    ["empty artifacts", (r) => { r.artifacts = {}; }, "/artifacts minProperties"],
    [
      "more than 8 artifacts",
      (r) => { r.artifacts = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`unit-${i}`, DIGEST_A])); },
      "/artifacts maxProperties",
    ],
    ["a wrong eventType", (r) => { r.eventType = "PIPELINE_REQUESTED"; }, "/eventType const"],
    ["a wrong specVersion", (r) => { r.specVersion = 2; }, "/specVersion const"],
    ["a missing targetId", (r) => { delete r.targetId; }, " required targetId"],
    ["a deploymentId (removed by AC-02 V1)", (r) => { r.deploymentId = "example-app-dev"; }, " additionalProperties deploymentId"],
    ["a deploy script path", (r) => { r.deployScript = "/opt/cicd/deploy.sh"; }, " additionalProperties deployScript"],
    ["a script field", (r) => { r.script = "deploy.sh"; }, " additionalProperties script"],
    ["a command field", (r) => { r.command = "id"; }, " additionalProperties command"],
    ["a user field", (r) => { r.user = "deploy"; }, " additionalProperties user"],
    ["a credential reference", (r) => { r.credentialRef = "cicd-poc/dev/x"; }, " additionalProperties credentialRef"],
    ["an uppercase targetId", (r) => { r.targetId = "Example-App"; }, "/targetId pattern"],
    ["a targetId with a shell metacharacter", (r) => { r.targetId = "app;id"; }, "/targetId pattern"],
    ["a one-character targetId", (r) => { r.targetId = "a"; }, "/targetId pattern"],
    ["a missing ci block", (r) => { delete r.ci; }, " required ci"],
    ["a missing ci.runNumber", (r) => { delete r.ci.runNumber; }, "/ci required runNumber"],
    ["a runAttempt of 0", (r) => { r.ci.runAttempt = 0; }, "/ci/runAttempt minimum"],
    ["a runId with letters", (r) => { r.ci.runId = "abc"; }, "/ci/runId pattern"],
    ["a malformed ci.repository", (r) => { r.ci.repository = "no-slash"; }, "/ci/repository pattern"],
    ["a workflowRef longer than 256", (r) => { r.ci.workflowRef = "w".repeat(257); }, "/ci/workflowRef maxLength"],
  ];

  it.each(negatives)("rejects %s", (_name, mutate, expected) => {
    const r = clone(validRequest) as Record<string, any>;
    mutate(r);
    expect(validate(r)).toBe(false);
    expect(violations(validate)).toContain(expected);
  });
});
