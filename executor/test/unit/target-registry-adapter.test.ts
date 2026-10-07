// @akili-spec changes/cicd-executor-poc design §5.3, §6.3, §11.2; requirements FR-02; tasks R-3
//
// Unit tests for the DynamoDB Target Registry adapter (AC-02 V1). A fake document
// client stands in for DynamoDB: it records the commands it receives and returns
// canned items, so these tests pin the exact GetItem request, the found / missing /
// invalid outcomes, error propagation, and the read-only shape (code-level guard in
// addition to IAM, R-3).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbTargetRegistry } from "../../src/adapters/dynamodb-target-registry/index.js";
import type { TargetRegistry } from "../../src/ports/target-registry.js";
import { readJsonSchema } from "../contract/support/ajv-factory.js";
import { targetRecordSchemaPath } from "../contract/support/schema-paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterSourcePath = path.resolve(here, "..", "..", "src", "adapters", "dynamodb-target-registry", "index.ts");
const portSourcePath = path.resolve(here, "..", "..", "src", "ports", "target-registry.ts");

const TABLE = "cicd-registry-test";
const CREDENTIAL_REF = "cicd-poc/dev/example-app-dev/ssh";

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: "example-app-dev",
    project: "example",
    environment: "dev",
    host: "target.example.internal",
    port: 22,
    user: "deploy",
    hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
    credentialRef: CREDENTIAL_REF,
    deployScript: "/opt/cicd/example-app/deploy.sh",
    deployWindowPolicy: "required",
    sourceRepositoryId: "123456789",
    schemaVersion: 1,
    version: 3,
    updatedAt: "2026-10-07T12:00:00Z",
    updatedBy: "platform-admin",
    ...overrides,
  };
}

const item = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  pk: "TARGET#example-app-dev",
  sk: "META",
  ...record(overrides),
});

class FakeDocumentClient {
  public readonly commands: unknown[] = [];
  public constructor(private readonly respond: (command: unknown) => Promise<unknown>) {}
  public send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    return this.respond(command);
  }
}

function registryWith(respond: (command: unknown) => Promise<unknown>): { registry: TargetRegistry; fake: FakeDocumentClient } {
  const fake = new FakeDocumentClient(respond);
  const registry = new DynamoDbTargetRegistry({
    client: fake as unknown as DynamoDBDocumentClient,
    tableName: TABLE,
    schema: readJsonSchema(targetRecordSchemaPath),
  });
  return { registry, fake };
}

describe("DynamoDbTargetRegistry (R-3)", () => {
  it("issues exactly one consistent GetItem on TARGET#{targetId} / META", async () => {
    const { registry, fake } = registryWith(async () => ({ Item: item() }));
    await registry.getTarget("example-app-dev");
    expect(fake.commands).toHaveLength(1);
    const command = fake.commands[0];
    expect(command).toBeInstanceOf(GetCommand);
    expect((command as GetCommand).input).toEqual({
      TableName: TABLE,
      Key: { pk: "TARGET#example-app-dev", sk: "META" },
      ConsistentRead: true,
    });
  });

  it("returns a found, validated target without the key attributes", async () => {
    const { registry } = registryWith(async () => ({ Item: item() }));
    expect(await registry.getTarget("example-app-dev")).toEqual({ kind: "found", target: record() });
  });

  it("keeps hostKey as the list of OpenSSH lines (no SSH transformation here)", async () => {
    const lines = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample",
      "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYExample=",
    ];
    const { registry } = registryWith(async () => ({ Item: item({ hostKey: lines }) }));
    const result = await registry.getTarget("example-app-dev");
    expect(result.kind === "found" && result.target.hostKey).toEqual(lines);
  });

  it("returns missing when the item does not exist", async () => {
    const { registry } = registryWith(async () => ({}));
    expect(await registry.getTarget("example-app-dev")).toEqual({ kind: "missing" });
  });

  it.each([
    ["a required field is absent", (() => { const i = item(); delete i.hostKey; return i; })()],
    ["the script path is relative", item({ deployScript: "deploy.sh" })],
    ["an extra attribute is present", { ...item(), password: "secret-value" }],
    ["sourceRepositoryId is not numeric", item({ sourceRepositoryId: "repo-1" })],
  ])("returns invalid when %s", async (_label, stored) => {
    const { registry } = registryWith(async () => ({ Item: stored }));
    const result = await registry.getTarget("example-app-dev");
    expect(result.kind).toBe("invalid");
  });

  it("returns invalid when the stored targetId differs from the requested key", async () => {
    const { registry } = registryWith(async () => ({ Item: item({ targetId: "other-app-dev" }) }));
    const result = await registry.getTarget("example-app-dev");
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.problems.join(" ")).toContain("targetId");
  });

  it("returns invalid when the key attributes are not the expected ones", async () => {
    const { registry } = registryWith(async () => ({ Item: { ...item(), sk: "OTHER" } }));
    expect((await registry.getTarget("example-app-dev")).kind).toBe("invalid");
  });

  it("invalid problems name the rule and the path, never a stored value", async () => {
    const stored = item({ host: "bad host;id", credentialRef: "arn:aws:secretsmanager:example", extra: "secret-value" });
    const { registry } = registryWith(async () => ({ Item: stored }));
    const result = await registry.getTarget("example-app-dev");
    expect(result.kind).toBe("invalid");
    const text = JSON.stringify(result);
    for (const value of ["bad host;id", "arn:aws:secretsmanager:example", "secret-value", CREDENTIAL_REF]) {
      expect(text).not.toContain(value);
    }
  });

  it("propagates a DynamoDB error instead of reporting missing or invalid", async () => {
    const failure = Object.assign(new Error("Requested resource not found"), { name: "ResourceNotFoundException" });
    const { registry } = registryWith(async () => {
      throw failure;
    });
    await expect(registry.getTarget("example-app-dev")).rejects.toBe(failure);
  });

  it("returns a copy: mutating the result never changes a later lookup", async () => {
    const { registry } = registryWith(async () => ({ Item: item() }));
    const first = await registry.getTarget("example-app-dev");
    if (first.kind === "found") (first.target.hostKey as string[]).push("tampered");
    const second = await registry.getTarget("example-app-dev");
    expect(second.kind === "found" && second.target.hostKey).toHaveLength(1);
  });
});

describe("read-only guard (code level, in addition to IAM; R-3)", () => {
  it("the adapter source references no DynamoDB command other than GetCommand", () => {
    const source = readFileSync(adapterSourcePath, "utf8");
    // Any *Command identifier (Put, Update, Delete, Query, Scan, Batch*, Transact*, ...) other than GetCommand fails.
    expect(new Set(source.match(/\b\w+Command\b/g))).toEqual(new Set(["GetCommand"]));
  });

  it("the port declares a single read operation (methods and function-typed properties)", () => {
    const source = readFileSync(portSourcePath, "utf8");
    const body = /export interface TargetRegistry \{([^}]*)\}/.exec(source)?.[1] ?? "";
    const members = [...body.matchAll(/^\s+(?:readonly\s+)?(\w+)\s*[:(]/gm)].map((m) => m[1]);
    expect(members).toEqual(["getTarget"]);
  });

  it("the adapter instance exposes only getTarget", () => {
    const { registry } = registryWith(async () => ({}));
    const proto = Object.getPrototypeOf(registry) as object;
    const methods = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
    expect(methods).toEqual(["getTarget"]);
  });
});
