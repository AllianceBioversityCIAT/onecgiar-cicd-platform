// @akili-spec changes/cicd-executor-poc design §5.3, §6.3, §11.2; architecture-change-02 AC2-4, V1-R2, V1-R3; tasks R-7
// The owner-run Target Registry tool (R-7): validates a record against schemas/target-record.schema.json (R-1),
// enforces the credentialRef prefix, writes with a condition on `version`, prints the onboarding checklist and
// never runs with the Executor's profile or the Executor's isolated AWS files. Every test uses a fake client;
// the conditional writes against DynamoDB Local are in test/integration/target-registry-tool.int.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXECUTOR_PROFILE, runTargetRegistryTool, type RegistryClientFactory, type TargetRegistryToolDeps } from "../../src/tools/target-registry/index.js";
import { targetRecordSchemaPath } from "../contract/support/schema-paths.js";

const SCHEMA = JSON.parse(readFileSync(targetRecordSchemaPath, "utf8")) as object;
const NOW = "2026-10-07T12:00:00.000Z";
const PREFIX = "cicd-poc/dev/";

/** What the operator writes: the record without the fields the tool owns (schemaVersion, version, updatedAt, updatedBy). */
function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: "example-app-dev",
    project: "example",
    environment: "dev",
    host: "target.example.internal",
    user: "deploy",
    hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
    credentialRef: "cicd-poc/dev/example-app-dev/ssh",
    deployScript: "/opt/cicd/example-app/deploy.sh",
    deployWindowPolicy: "not-required",
    sourceRepositoryId: "123456789",
    ...overrides,
  };
}

interface Harness {
  readonly deps: TargetRegistryToolDeps;
  readonly out: string[];
  readonly err: string[];
  readonly sent: { name: string; input: Record<string, unknown> }[];
  readonly clients: { region: string; profile: string }[];
}

function harness(options: { file?: unknown; env?: NodeJS.ProcessEnv; reply?: (name: string) => unknown } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const clients: { region: string; profile: string }[] = [];
  const createClient: RegistryClientFactory = (config) => {
    clients.push(config);
    return {
      send: async (command) => {
        const name = command.constructor.name;
        sent.push({ name, input: command.input as Record<string, unknown> });
        const reply = options.reply?.(name);
        if (reply instanceof Error) throw reply;
        return reply ?? {};
      },
    };
  };
  const deps: TargetRegistryToolDeps = {
    env: options.env ?? {},
    clock: { now: () => new Date(NOW) },
    schema: SCHEMA,
    readFile: async () => (typeof options.file === "string" ? options.file : JSON.stringify(options.file ?? input())),
    createClient,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  };
  return { deps, out, err, sent, clients };
}

const PUT = ["put", "--file", "record.json", "--updated-by", "platform-admin", "--secret-id-prefix", PREFIX, "--registry-table", "cicd-registry-dev", "--region", "us-east-1", "--profile", "cicd-admin", "--checklist-confirmed"];

function conditionalFailure(): Error {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}

describe("target registry tool: record validation (R-1 schema)", () => {
  it.each([
    ["a missing hostKey", input({ hostKey: undefined })],
    ["a relative deployScript", input({ deployScript: "deploy.sh" })],
    ["a non-numeric sourceRepositoryId", input({ sourceRepositoryId: "example-org/example-app" })],
    ["an extra field (a credential value)", input({ privateKey: "sentinel-credential-value-xyz" })],
    ["a non-dev environment", input({ environment: "prod" })],
  ])("refuses %s, naming the rule but never the value, and makes no AWS call", async (_label, record) => {
    const h = harness({ file: JSON.parse(JSON.stringify(record)) });
    expect(await runTargetRegistryTool(PUT, h.deps)).toBe(1);
    expect(h.clients).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.err.join("\n")).toMatch(/invalid target record/);
    expect(h.err.join("\n")).not.toContain("sentinel-credential-value-xyz");
  });

  it.each(["schemaVersion", "version", "updatedAt", "updatedBy", "pk", "sk"])("refuses an input that sets %s (the tool owns it)", async (field) => {
    const h = harness({ file: input({ [field]: field === "version" || field === "schemaVersion" ? 1 : "x" }) });
    expect(await runTargetRegistryTool(PUT, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain(field);
    expect(h.sent).toEqual([]);
  });

  it("refuses a file that is not a JSON object", async () => {
    const h = harness({ file: "not json" });
    expect(await runTargetRegistryTool(PUT, h.deps)).toBe(1);
    expect(h.sent).toEqual([]);
  });
});

describe("target registry tool: credentialRef under the Executor's secret prefix (design §6.3)", () => {
  it.each(["other/example-app-dev/ssh", "cicd-poc/dev-other/ssh", "cicd-poc/dev/", "<EXAMPLE_SSH_REF>"])("refuses credentialRef %j", async (credentialRef) => {
    const h = harness({ file: input({ credentialRef }) });
    expect(await runTargetRegistryTool(PUT, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/credentialRef/);
    expect(h.sent).toEqual([]);
  });

  it("refuses an empty or missing --secret-id-prefix", async () => {
    const withEmpty = PUT.map((a) => (a === PREFIX ? "" : a));
    expect(await runTargetRegistryTool(withEmpty, harness().deps)).toBe(2);
    const without = PUT.filter((a, i) => a !== "--secret-id-prefix" && PUT[i - 1] !== "--secret-id-prefix");
    expect(await runTargetRegistryTool(without, harness().deps)).toBe(2);
  });
});

describe("target registry tool: never the Executor's identity (AC2-4)", () => {
  it("passes the administrative profile to the client, and only that profile", async () => {
    const h = harness();
    expect(await runTargetRegistryTool(PUT, h.deps)).toBe(0);
    expect(h.clients).toEqual([{ region: "us-east-1", profile: "cicd-admin" }]);
  });

  it(`refuses the Executor profile (${EXECUTOR_PROFILE}) given as --profile or as AWS_PROFILE`, async () => {
    const asFlag = harness();
    expect(await runTargetRegistryTool(PUT.map((a) => (a === "cicd-admin" ? EXECUTOR_PROFILE : a)), asFlag.deps)).toBe(2);
    expect(asFlag.err.join("\n")).toContain("Executor profile");
    const asEnv = harness({ env: { AWS_PROFILE: EXECUTOR_PROFILE } });
    expect(await runTargetRegistryTool(PUT, asEnv.deps)).toBe(2);
    expect([...asFlag.clients, ...asEnv.clients]).toEqual([]);
  });

  it("requires --profile for a write", async () => {
    const without = PUT.filter((a, i) => a !== "--profile" && PUT[i - 1] !== "--profile");
    const h = harness();
    expect(await runTargetRegistryTool(without, h.deps)).toBe(2);
    expect(h.clients).toEqual([]);
  });

  it.each([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  ])(
    "refuses to run with %s in the environment (it could supply credentials other than --profile or the Executor's files)",
    async (name) => {
      const h = harness({ env: { [name]: "set" } });
      expect(await runTargetRegistryTool(PUT, h.deps)).toBe(2);
      expect(h.err.join("\n")).toContain(name);
      expect(h.clients).toEqual([]);
    },
  );
});

describe("target registry tool: conditional writes on version", () => {
  it("creates a new target only if absent, with version 1 and the audit fields set by the tool", async () => {
    const h = harness();
    expect(await runTargetRegistryTool(PUT, h.deps)).toBe(0);
    expect(h.sent).toHaveLength(1);
    const put = h.sent[0]!;
    expect(put.name).toBe("PutCommand");
    expect(put.input.TableName).toBe("cicd-registry-dev");
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(put.input.Item).toEqual({ pk: "TARGET#example-app-dev", sk: "META", ...input(), schemaVersion: 1, version: 1, updatedAt: NOW, updatedBy: "platform-admin" });
  });

  it("updates only from the expected version and bumps it", async () => {
    const h = harness();
    expect(await runTargetRegistryTool([...PUT, "--expected-version", "3"], h.deps)).toBe(0);
    const put = h.sent[0]!;
    expect(put.input.ConditionExpression).toBe("#version = :expected");
    expect(put.input.ExpressionAttributeNames).toEqual({ "#version": "version" });
    expect(put.input.ExpressionAttributeValues).toEqual({ ":expected": 3 });
    expect((put.input.Item as Record<string, unknown>).version).toBe(4);
  });

  it.each([
    ["a create over an existing target", [] as string[], /already exists/],
    ["an update from a stale version", ["--expected-version", "3"], /version is not 3/],
  ])("%s is refused by the condition and reported (exit 1)", async (_label, extra, message) => {
    const h = harness({ reply: () => conditionalFailure() });
    expect(await runTargetRegistryTool([...PUT, ...extra], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(message);
  });

  it.each(["0", "-1", "1.5", "x"])("refuses --expected-version %j", async (value) => {
    expect(await runTargetRegistryTool([...PUT, "--expected-version", value], harness().deps)).toBe(2);
  });

  it("a write requires --checklist-confirmed; without it nothing is sent and the checklist is printed", async () => {
    const h = harness();
    expect(await runTargetRegistryTool(PUT.filter((a) => a !== "--checklist-confirmed"), h.deps)).toBe(2);
    expect(h.clients).toEqual([]);
    expect(h.err.join("\n")).toContain("--checklist-confirmed");
  });

  it("--dry-run validates and prints the record and the checklist without any AWS client or profile", async () => {
    const h = harness();
    const dry = ["put", "--file", "record.json", "--updated-by", "platform-admin", "--secret-id-prefix", PREFIX, "--dry-run"];
    expect(await runTargetRegistryTool(dry, h.deps)).toBe(0);
    expect(h.clients).toEqual([]);
    const text = h.out.join("\n");
    expect(text).toContain('"targetId": "example-app-dev"');
    expect(text).toContain("CHECKLIST");
  });
});

describe("target registry tool: get and checklist", () => {
  it("get reads one item with a consistent GetItem and prints it without the key attributes", async () => {
    const stored = { pk: "TARGET#example-app-dev", sk: "META", ...input(), schemaVersion: 1, version: 2, updatedAt: NOW, updatedBy: "platform-admin" };
    const h = harness({ reply: () => ({ Item: stored }) });
    const argv = ["get", "--target-id", "example-app-dev", "--registry-table", "cicd-registry-dev", "--region", "us-east-1", "--profile", "cicd-admin"];
    expect(await runTargetRegistryTool(argv, h.deps)).toBe(0);
    expect(h.sent).toEqual([{ name: "GetCommand", input: { TableName: "cicd-registry-dev", Key: { pk: "TARGET#example-app-dev", sk: "META" }, ConsistentRead: true } }]);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ ...input(), schemaVersion: 1, version: 2, updatedAt: NOW, updatedBy: "platform-admin" });
  });

  it("get of a missing target exits 1", async () => {
    const h = harness({ reply: () => ({}) });
    expect(await runTargetRegistryTool(["get", "--target-id", "example-app-dev", "--registry-table", "t-1", "--region", "us-east-1", "--profile", "cicd-admin"], h.deps)).toBe(1);
  });

  it("checklist covers the source repository id, the single caller workflow, the script ownership and interface, and the B2 gate", async () => {
    const h = harness();
    expect(await runTargetRegistryTool(["checklist"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    for (const needle of ["repository_id", "V1-R2", "not writable by the deploy user", "V1-R3", "§6.5", "mutex", "P-R1", "P-R2", "SenderId", "host key"]) {
      expect(text).toContain(needle);
    }
  });

  it("an unknown command or argument is a usage error (exit 2)", async () => {
    expect(await runTargetRegistryTool(["delete"], harness().deps)).toBe(2);
    expect(await runTargetRegistryTool([...PUT, "--force"], harness().deps)).toBe(2);
    expect(await runTargetRegistryTool([], harness().deps)).toBe(2);
  });
});
