// @akili-spec changes/cicd-executor-poc gate-b-plan K-7 (D-5), design §6.3, §6.5, §7.5, FR-12; tasks R-5 (AC-02 V1, owner decision 2026-10-07: B4 probe option A)
// The owner-run `executor-ssh-probe` tool (V1): argument parsing with the B4-only probe-script restriction,
// --dry-run (no SDK/SSH call) and end-to-end runs against the real in-process ssh2 test server, with a fake
// Target Registry and a fake SecretProvider. Nothing is uploaded: the probe script is installed on the target
// by the owner and run by path.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ssh2DeployTransport } from "../../src/adapters/ssh-deployer/index.js";
import { redactString } from "../../src/observability/logger/redaction.js";
import type { TargetLookup, TargetRecord } from "../../src/ports/target-registry.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";
import { SshTestServer, generateTestKeyPair, reply, type TestKeyPair } from "../support/ssh-test-server.js";
import { parseArgs, runProbe, type ProbeDeps, type ProbeExecutor } from "../../../tools/gate-b/probe/executor-ssh-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const localScript = path.resolve(here, "..", "..", "..", "tools", "gate-b", "probe", "target-probe.sh");
const localSha256 = createHash("sha256").update(Buffer.from(readFileSync(localScript, "utf8").replace(/\r\n/g, "\n"), "utf8")).digest("hex");

const TARGET_ID = "example-app-dev";
const PROBE_PATH = "/opt/cicd/probe/target-probe.sh";
const CREDENTIAL_REF = "cicd-poc/dev/example-app-dev/ssh";
const ARGS = ["--target-id", TARGET_ID, "--probe-script", PROBE_PATH];
const ENV = { CICD_SECRET_ID_PREFIX: "test/", AWS_REGION: "test-region-1", CICD_REGISTRY_TABLE_NAME: "cicd-registry-test" };

function sink(): { text: string; write(t: string): void } {
  const s = {
    text: "",
    write(t: string): void {
      s.text += t;
    },
  };
  return s;
}

const realExecutor = (): Promise<ProbeExecutor> =>
  Promise.resolve({
    Ssh2DeployTransport: Ssh2DeployTransport as unknown as ProbeExecutor["Ssh2DeployTransport"],
    SecretsManagerSecretProvider: class {} as unknown as ProbeExecutor["SecretsManagerSecretProvider"],
    createSecretsManagerClient: () => {
      throw new Error("no SDK client may be created in tests");
    },
    DynamoDbTargetRegistry: class {} as unknown as ProbeExecutor["DynamoDbTargetRegistry"],
    createDocumentClient: () => {
      throw new Error("no SDK client may be created in tests");
    },
    redactString,
  });

describe("executor-ssh-probe argument parsing (V1)", () => {
  it("accepts a targetId and the probe path, with defaults from the environment", () => {
    expect(parseArgs(ARGS, ENV)).toMatchObject({
      targetId: TARGET_ID,
      probeScript: PROBE_PATH,
      dryRun: false,
      secretIdPrefix: "test/",
      region: "test-region-1",
      registryTable: "cicd-registry-test",
    });
  });

  it.each([
    ["a missing targetId", ["--probe-script", PROBE_PATH]],
    ["a missing probe script", ["--target-id", TARGET_ID]],
    ["an invalid targetId", ["--target-id", "Bad Target", "--probe-script", PROBE_PATH]],
    ["a relative probe path", ["--target-id", TARGET_ID, "--probe-script", "target-probe.sh"]],
    ["a probe path with a parent segment", ["--target-id", TARGET_ID, "--probe-script", "/opt/../tmp/target-probe.sh"]],
    ["a probe path with a shell metacharacter", ["--target-id", TARGET_ID, "--probe-script", "/opt/x;id/target-probe.sh"]],
    ["a probe path with an empty segment (equivalent spelling)", ["--target-id", TARGET_ID, "--probe-script", "/opt//cicd/target-probe.sh"]],
    ["a probe file not named target-probe.sh (e.g. the deploy script)", ["--target-id", TARGET_ID, "--probe-script", "/opt/cicd/example-app/deploy.sh"]],
    ["a probe file with a lookalike name", ["--target-id", TARGET_ID, "--probe-script", "/opt/cicd/target-probe.sh.bak"]],
    ["an unknown flag (no free-form command)", [...ARGS, "--command", "id"]],
    ["the removed connection-ref flag", [...ARGS, "--connection-ref", "<X>"]],
    ["a flag without a value", [...ARGS, "--region"]],
    ["a secret id prefix with illegal characters", [...ARGS, "--secret-id-prefix", "bad prefix;x"]],
    ["a registry table with illegal characters", [...ARGS, "--registry-table", "bad table"]],
    ["a bad timeout", [...ARGS, "--timeout-seconds", "0"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseArgs(argv, ENV)).toThrow();
  });

  it("runProbe answers a usage error with exit code 2 and the usage text", async () => {
    const stderr = sink();
    expect(await runProbe(["--target-id", TARGET_ID], { stdout: sink(), stderr, env: ENV })).toBe(2);
    expect(stderr.text).toContain("Usage: executor-ssh-probe");
    expect(stderr.text).toContain("--probe-script is required");
  });

  it("runProbe exits 2 without a secret prefix, a region or a registry table (non dry-run)", async () => {
    const stderr = sink();
    expect(await runProbe(ARGS, { stdout: sink(), stderr, env: {} })).toBe(2);
    expect(stderr.text).toContain("a secret id prefix, a region and a registry table are required");
  });
});

describe("executor-ssh-probe --dry-run", () => {
  it("prints the plan and the local reference script sha256 without loading the SDK, the registry, the secrets provider or any SSH code", async () => {
    const stdout = sink();
    const forbidden = (): never => {
      throw new Error("must not be called in --dry-run");
    };
    const deps: ProbeDeps = { stdout, stderr: sink(), env: {}, loadExecutor: forbidden, createSecrets: forbidden, createRegistry: forbidden };
    expect(await runProbe([...ARGS, "--dry-run"], deps)).toBe(0);
    expect(stdout.text).toContain(TARGET_ID);
    expect(stdout.text).toContain(PROBE_PATH);
    expect(stdout.text).toContain(`sha256=${localSha256}`);
    expect(stdout.text).toContain("no AWS call, no SSH connection");
  });
});

describe("executor-ssh-probe end to end against the in-process SSH server (V1: nothing uploaded)", () => {
  let hostKey: TestKeyPair;
  let clientKey: TestKeyPair;
  let server: SshTestServer;

  const PROBE_STDOUT =
    "probe.bash_version=5.2.0\nprobe.flock_present=yes\nprobe.flock_contention=busy\nprobe.flock_release=free\n" +
    'CICD_RESULT {"status":"PROBE_OK","healthy":true}\n';

  const record = (port: number, over: Partial<TargetRecord> = {}): TargetRecord => ({
    targetId: TARGET_ID,
    project: "example",
    environment: "dev",
    host: "127.0.0.1",
    port,
    user: "deployer",
    hostKey: [hostKey.publicKey],
    credentialRef: CREDENTIAL_REF,
    deployScript: "/opt/cicd/example-app/deploy.sh",
    deployWindowPolicy: "required",
    sourceRepositoryId: "123456789",
    schemaVersion: 1,
    version: 1,
    updatedAt: "2026-10-07T12:00:00Z",
    updatedBy: "platform-admin",
    ...over,
  });

  async function run(opts: { exec?: { stdout: string; code: number }; lookup?: (port: number) => TargetLookup; argv?: string[] } = {}) {
    server = new SshTestServer({
      hostKey,
      authorizedPublicKey: clientKey.publicKey,
      onExec: (ctx) => reply(ctx.stream, opts.exec ?? { stdout: PROBE_STDOUT, code: 0 }),
    });
    const port = await server.listen();
    const reads: string[] = [];
    const stdout = sink();
    const stderr = sink();
    const code = await runProbe(opts.argv ?? [...ARGS, "--timeout-seconds", "20"], {
      stdout,
      stderr,
      env: ENV,
      loadExecutor: realExecutor,
      createSecrets: () => new FakeSecretProvider({ [CREDENTIAL_REF]: clientKey.privateKey }),
      createRegistry: () => ({
        getTarget: async (id: string) => {
          reads.push(id);
          return opts.lookup?.(port) ?? { kind: "found", target: record(port) };
        },
      }),
    });
    return { code, stdout: stdout.text, stderr: stderr.text, reads, port };
  }

  beforeEach(() => {
    hostKey = generateTestKeyPair();
    clientKey = generateTestKeyPair();
  });
  afterEach(async () => {
    await server?.close();
  });

  it("reads the target, pins its host key, runs ONLY the installed probe script with no arguments, uploads nothing, reports success", async () => {
    const r = await run();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.reads).toEqual([TARGET_ID]);
    expect(r.stdout).toContain("target record read and validated");
    expect(r.stdout).toContain("host key verified against the pinned key");
    expect(r.stdout).toContain("probe.flock_contention=busy");
    expect(r.stdout).toContain("CICD_RESULT parsed: yes (status PROBE_OK)");
    expect(r.stdout).toContain("probe OK");
    expect(server.execCommands).toEqual([`'${PROBE_PATH}'`]); // the probe only, no arguments, no cleanup command
    expect(server.files.size).toBe(0);
    expect(server.directories.size).toBe(0);
  });

  it("never prints the private key, the host, the port, the user or the credential reference; redacts secret-looking probe lines", async () => {
    const r = await run({ exec: { stdout: "probe.note=password=hunter2hunter2\n" + PROBE_STDOUT, code: 0 } });
    const all = r.stdout + r.stderr;
    expect(all).not.toContain(clientKey.privateKey.split("\n")[1]!);
    expect(all).not.toContain("OPENSSH PRIVATE");
    expect(all).not.toContain("deployer");
    expect(all).not.toContain("127.0.0.1");
    expect(all).not.toContain(String(r.port));
    expect(all).not.toContain(CREDENTIAL_REF);
    expect(all).not.toContain("hunter2hunter2");
    expect(all).toContain("probe.note=password=");
  });

  it("a failing probe script (PROBE_FAILED, exit 10) makes the tool exit 1", async () => {
    const r = await run({ exec: { stdout: 'probe.failed_checks=flock_missing\nCICD_RESULT {"status":"PROBE_FAILED","healthy":false}\n', code: 10 } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("probe FAILED");
    expect(r.stdout).toContain("exit code: 10");
  });

  it("a record pinning another host key: HOST_KEY_MISMATCH, exit 1, no credential sent and nothing run (the owner's B4 negative check)", async () => {
    const r = await run({ lookup: (port) => ({ kind: "found", target: record(port, { hostKey: [generateTestKeyPair().publicKey] }) }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HOST_KEY_MISMATCH");
    expect(r.stdout).not.toContain("host key verified");
    expect(server.authAttempts).toEqual([]);
    expect(server.execCommands).toEqual([]);
  });

  it.each([
    ["an unknown target", { kind: "missing" } as TargetLookup, "TARGET_UNKNOWN"],
    ["an invalid target record", { kind: "invalid", problems: ["/hostKey minItems"] } as TargetLookup, "TARGET_INVALID"],
  ])("%s: exit 1 before any SSH connection", async (_label, lookup, reason) => {
    const r = await run({ lookup: () => lookup });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(reason);
    expect(server.connectionCount).toBe(0);
  });

  it("refuses to run the target's deployScript even if it were named target-probe.sh (B4 restriction): exit 1, no connection", async () => {
    const r = await run({ lookup: (port) => ({ kind: "found", target: record(port, { deployScript: PROBE_PATH }) }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the probe script must not be the target's deployScript");
    expect(server.connectionCount).toBe(0);
  });
});
