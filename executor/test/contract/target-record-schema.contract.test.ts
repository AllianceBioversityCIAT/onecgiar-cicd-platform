// @akili-spec changes/cicd-executor-poc requirements FR-02, FR-21; design 5.3, 6.3, DD-23, DD-25; tasks R-1
//
// Contract tests for schemas/target-record.schema.json (repo root): one item of
// the runtime Target Registry `cicd-registry-<stage>` (AC-02 V1). Proves:
//  1. A minimal valid record (design §6.3) validates, with and without `port`.
//  2. A negative corpus, one fixture per R-1 rule, each fails validation.
// The fixture uses placeholder-shaped values only (publication policy, DD-23).
import { describe, expect, it, beforeAll } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { targetRecordSchemaPath } from "./support/schema-paths.js";

type TargetRecord = Record<string, unknown>;

function validRecord(): TargetRecord {
  return {
    targetId: "example-app-dev",
    project: "example",
    environment: "dev",
    host: "target.example.internal",
    port: 22,
    user: "deploy",
    hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample example-host"],
    credentialRef: "cicd-poc/dev/example-app-dev/ssh",
    deployScript: "/opt/cicd/example-app/deploy.sh",
    deployWindowPolicy: "required",
    sourceRepositoryId: "123456789",
    schemaVersion: 1,
    version: 1,
    updatedAt: "2026-10-07T12:00:00Z",
    updatedBy: "platform-admin",
  };
}

describe("schemas/target-record.schema.json (FR-02, design §6.3, R-1)", () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    validate = createAjv().compile(readJsonSchema(targetRecordSchemaPath));
  });

  function expectValid(record: TargetRecord): void {
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  }

  function expectInvalid(record: TargetRecord): void {
    expect(validate(record)).toBe(false);
  }

  it("accepts a minimal valid record", () => {
    expectValid(validRecord());
  });

  it("accepts a record without port (SSH port defaults to 22)", () => {
    const record = validRecord();
    delete record.port;
    expectValid(record);
  });

  it("accepts deployWindowPolicy not-required", () => {
    expectValid({ ...validRecord(), deployWindowPolicy: "not-required" });
  });

  it("accepts an IPv4 host and several pinned host-key lines", () => {
    expectValid({
      ...validRecord(),
      host: "192.0.2.10",
      hostKey: [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample",
        "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYExample=",
      ],
    });
  });

  describe("negative corpus — one case per rule", () => {
    it.each(["hostKey", "deployScript", "deployWindowPolicy", "sourceRepositoryId"])(
      "rejects a record missing %s",
      (field) => {
        const record = validRecord();
        delete record[field];
        expectInvalid(record);
      },
    );

    it.each([
      "targetId",
      "project",
      "environment",
      "host",
      "user",
      "credentialRef",
      "schemaVersion",
      "version",
      "updatedAt",
      "updatedBy",
    ])("rejects a record missing %s", (field) => {
      const record = validRecord();
      delete record[field];
      expectInvalid(record);
    });

    it.each(["repo-123", "12a", "", "-1", "1".repeat(21)])(
      "rejects a non-numeric or out-of-range sourceRepositoryId %j",
      (value) => {
        expectInvalid({ ...validRecord(), sourceRepositoryId: value });
      },
    );

    it("rejects a numeric (non-string) sourceRepositoryId", () => {
      expectInvalid({ ...validRecord(), sourceRepositoryId: 123456789 });
    });

    it.each([
      ["relative path", "opt/cicd/deploy.sh"],
      ["relative dot path", "./deploy.sh"],
      ["parent segment", "/opt/cicd/../../bin/sh"],
      ["trailing parent segment", "/opt/cicd/.."],
      ["semicolon", "/opt/cicd/deploy.sh;id"],
      ["whitespace / argument", "/opt/cicd/deploy.sh --force"],
      ["command substitution", "/opt/cicd/$(id).sh"],
      ["backtick", "/opt/cicd/`id`.sh"],
      ["pipe", "/opt/cicd/deploy.sh|sh"],
      ["ampersand", "/opt/cicd/deploy.sh&"],
      ["redirection", "/opt/cicd/deploy.sh>out"],
      ["glob", "/opt/cicd/*.sh"],
      ["newline", "/opt/cicd/deploy.sh\nid"],
      ["quote", "/opt/cicd/'deploy'.sh"],
      ["root only", "/"],
      ["dot segment", "/opt/./deploy.sh"],
      ["trailing slash (a directory)", "/opt/cicd/"],
    ])("rejects a deployScript with %s", (_label, value) => {
      expectInvalid({ ...validRecord(), deployScript: value });
    });

    it.each([
      ["password", "secret-value"],
      ["privateKey", "private-key-material"],
      ["credential", "secret-value"],
      ["command", "rm -rf /"],
      ["deploymentId", "example-app-dev"],
      ["allowedDeploymentIds", ["example-app-dev"]],
      ["lockKey", "example-app-dev"],
      ["containers", [{ name: "app", port: "8080:8080" }]],
      ["pk", "TARGET#example-app-dev"],
    ])("rejects an extra field %s (additionalProperties: false)", (field, value) => {
      expectInvalid({ ...validRecord(), [field]: value });
    });

    it.each(["Example", "-example", "e", "example_app", "a".repeat(64)])("rejects targetId %j", (value) => {
      expectInvalid({ ...validRecord(), targetId: value });
    });

    it.each(["prod", "staging", ""])("rejects environment %j (DEV only in the PoC)", (value) => {
      expectInvalid({ ...validRecord(), environment: value });
    });

    it.each([0, 65536, 22.5, "22"])("rejects port %j", (value) => {
      expectInvalid({ ...validRecord(), port: value });
    });

    it.each(["host name", "host;id", "user@host", "", "-host", "999.999.999.999"])("rejects host %j", (value) => {
      expectInvalid({ ...validRecord(), host: value });
    });

    it.each(["Deploy", "deploy user", "root;id", "", "a".repeat(33)])("rejects user %j", (value) => {
      expectInvalid({ ...validRecord(), user: value });
    });

    it.each([
      ["an empty list", []],
      ["a string instead of a list", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
      ["an unknown key type", ["rsa AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"]],
      ["a bare blob without type", ["AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"]],
      ["a short blob", ["ssh-ed25519 AAAA"]],
      ["an embedded newline", ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample\nssh-rsa AAAA"]],
      ["private key material", ["private-key-material"]],
    ])("rejects hostKey with %s", (_label, value) => {
      expectInvalid({ ...validRecord(), hostKey: value });
    });

    it.each([
      ["an ARN", "arn:aws:secretsmanager:<AWS_REGION>:<AWS_ACCOUNT_ID>:secret:example"],
      ["whitespace", "cicd-poc/dev/example app"],
      ["an empty value", ""],
    ])("rejects credentialRef with %s (a reference name only, never a value)", (_label, value) => {
      expectInvalid({ ...validRecord(), credentialRef: value });
    });

    it.each(["always", "", "none"])("rejects deployWindowPolicy %j (no default, closed set)", (value) => {
      expectInvalid({ ...validRecord(), deployWindowPolicy: value });
    });

    it.each([0, 2, "1"])("rejects schemaVersion %j", (value) => {
      expectInvalid({ ...validRecord(), schemaVersion: value });
    });

    it.each([0, -1, 1.5, "1"])("rejects version %j", (value) => {
      expectInvalid({ ...validRecord(), version: value });
    });

    it("rejects a non date-time updatedAt", () => {
      expectInvalid({ ...validRecord(), updatedAt: "yesterday" });
    });

    it("rejects an empty updatedBy", () => {
      expectInvalid({ ...validRecord(), updatedBy: "" });
    });
  });
});

// architecture-change-04 (E1): optional transport. Absent or ssh keeps the AC-02 V1 rules unchanged; sqs-agent
// requires agentId + scriptId and forbids every SSH field.
describe("schemas/target-record.schema.json: transport (architecture-change-04)", () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    validate = createAjv().compile(readJsonSchema(targetRecordSchemaPath));
  });

  function agentRecord(overrides: TargetRecord = {}): TargetRecord {
    const record = validRecord();
    for (const field of ["host", "port", "user", "hostKey", "credentialRef", "deployScript"]) delete record[field];
    return { ...record, transport: "sqs-agent", agentId: "example-server-dev", scriptId: "deploy-example-app-dev", ...overrides };
  }

  it("a record without transport is exactly as valid as before (ssh by default)", () => {
    expect(validate(validRecord())).toBe(true);
  });

  it("accepts transport ssh with the SSH fields", () => {
    expect(validate({ ...validRecord(), transport: "ssh" })).toBe(true);
  });

  it("accepts an sqs-agent record with agentId and scriptId and no SSH field", () => {
    expect(validate(agentRecord()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts scriptArguments none on an sqs-agent record (AC-03 G-D1 applies to both transports)", () => {
    expect(validate(agentRecord({ scriptArguments: "none" }))).toBe(true);
  });

  it.each(["host", "port", "user", "hostKey", "credentialRef", "deployScript"])("rejects an sqs-agent record that carries %s", (field) => {
    const ssh = validRecord();
    expect(validate(agentRecord({ [field]: ssh[field] }))).toBe(false);
  });

  it.each(["agentId", "scriptId"])("rejects an sqs-agent record without %s", (field) => {
    const record = agentRecord();
    delete record[field];
    expect(validate(record)).toBe(false);
  });

  it.each(["host", "user", "hostKey", "credentialRef", "deployScript"])("still rejects an ssh record without %s", (field) => {
    const record: TargetRecord = { ...validRecord(), transport: "ssh" };
    delete record[field];
    expect(validate(record)).toBe(false);
  });

  it.each([["agentId", "example-server-dev"], ["scriptId", "deploy-x"]])("rejects an ssh record that carries %s", (field, value) => {
    expect(validate({ ...validRecord(), [field]: value })).toBe(false);
  });

  it("rejects an unknown transport and a script path as scriptId", () => {
    expect(validate({ ...validRecord(), transport: "http" })).toBe(false);
    expect(validate(agentRecord({ scriptId: "/opt/cicd/deploy.sh" }))).toBe(false);
  });
});
