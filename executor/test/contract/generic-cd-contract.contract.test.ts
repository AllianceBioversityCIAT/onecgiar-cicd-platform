// @akili-spec changes/cicd-executor-poc architecture-change-03 G-D1, G-D2, G-D3, G-D6; design §6.1, §6.3, §6.5; tasks G-1, G-2
// Technology-neutral CD contract (AC-03): the target record chooses how the
// script is invoked (`scriptArguments`: standard by default, or none), the
// request may carry no artifacts, and the script may report the deployed commit.
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { deployRequestSchemaPath, targetRecordSchemaPath } from "./support/schema-paths.js";
import { parseCicdResultLine } from "../../src/adapters/ssh-deployer/index.js";

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: "example-app-dev",
    project: "example",
    environment: "dev",
    host: "target.example.internal",
    user: "deploy",
    hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
    credentialRef: "cicd-poc/dev/example-app-dev/ssh",
    deployScript: "/opt/cicd/scripts/deploy-example-dev.sh",
    deployWindowPolicy: "required",
    sourceRepositoryId: "123456789",
    schemaVersion: 1,
    version: 1,
    updatedAt: "2026-10-08T12:00:00Z",
    updatedBy: "platform-admin",
    ...over,
  };
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: 1,
    eventType: "DEPLOY_REQUESTED",
    requestId: "100-1",
    targetId: "example-app-dev",
    commitSha: "a".repeat(40),
    artifacts: { app: `sha256:${"b".repeat(64)}` },
    ci: { repository: "example-org/example-app", workflowRef: "example", runId: "100", runAttempt: 1, runNumber: 5 },
    ...over,
  };
}

let validateRecord: ValidateFunction;
let validateRequest: ValidateFunction;
beforeAll(() => {
  validateRecord = createAjv().compile(readJsonSchema(targetRecordSchemaPath));
  validateRequest = createAjv().compile(readJsonSchema(deployRequestSchemaPath));
});

describe("target record scriptArguments (AC-03 G-D1)", () => {
  it("is optional: an existing record without it stays valid (default standard)", () => {
    expect(validateRecord(record())).toBe(true);
  });

  it.each(["standard", "none"])("accepts %s", (mode) => {
    expect(validateRecord(record({ scriptArguments: mode }))).toBe(true);
  });

  it.each(["", "custom", "--version", "standard; rm -rf /", ["none"], null, 1])("refuses %j (no templates, no free text)", (mode) => {
    expect(validateRecord(record({ scriptArguments: mode }))).toBe(false);
  });

  it("still refuses any technology-specific or command field", () => {
    for (const extra of [{ dockerImage: "x" }, { command: "systemctl restart x" }, { scriptArgs: ["--x"] }]) {
      expect(validateRecord(record(extra))).toBe(false);
    }
  });
});

describe("deploy request artifacts are optional immutable references (AC-03 G-D3)", () => {
  it("accepts a request without artifacts (the version is the commit)", () => {
    const body = request();
    delete body["artifacts"];
    expect(validateRequest(body)).toBe(true);
  });

  it("refuses an empty artifacts object, a tag, a location and any extra field that could shape the invocation", () => {
    expect(validateRequest(request({ artifacts: {} }))).toBe(false);
    expect(validateRequest(request({ artifacts: { app: "v1.2.3" } }))).toBe(false);
    expect(validateRequest(request({ artifacts: { app: `registry.example.invalid/app@sha256:${"b".repeat(64)}` } }))).toBe(false);
    for (const extra of [{ scriptArguments: "none" }, { args: ["--x"] }, { command: "id" }, { deployScript: "/tmp/x.sh" }]) {
      expect(validateRequest(request(extra))).toBe(false);
    }
  });
});

describe("CICD_RESULT deployedCommit (AC-03 G-D6)", () => {
  it("parses an optional 40-hex deployedCommit", () => {
    expect(parseCicdResultLine(`CICD_RESULT {"status":"SUCCESS","deployedCommit":"${"c".repeat(40)}"}`)).toEqual({ status: "SUCCESS", deployedCommit: "c".repeat(40) });
  });

  it.each(["abc", "C".repeat(40), 7])("treats a malformed deployedCommit %j as an invalid result (never trusted partially)", (value) => {
    expect(parseCicdResultLine(`CICD_RESULT ${JSON.stringify({ status: "SUCCESS", deployedCommit: value })}`)).toBeUndefined();
  });

  it("a non-Docker result with only status is valid", () => {
    expect(parseCicdResultLine('CICD_RESULT {"status":"SUCCESS"}')).toEqual({ status: "SUCCESS" });
  });
});
