// @akili-spec changes/cicd-executor-poc gate-b-plan K-7 (D-5), design §7.5, FR-12
// The owner-run `executor-ssh-probe` tool: argument parsing, --dry-run (no SDK/SSH call) and end-to-end runs
// against the real in-process ssh2 test server with a fake SecretProvider.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ssh2DeployTransport } from "../../src/adapters/ssh-deployer/index.js";
import { redactString } from "../../src/observability/logger/redaction.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";
import { SshTestServer, generateTestKeyPair, reply, type ExecContext, type TestKeyPair } from "../support/ssh-test-server.js";
import { parseArgs, runProbe, type ProbeDeps, type ProbeExecutor } from "../../../tools/gate-b/probe/executor-ssh-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "..", "..", "..", "tools", "gate-b", "probe", "target-probe.sh");
const scriptSha256 = createHash("sha256").update(Buffer.from(readFileSync(scriptPath, "utf8").replace(/\r\n/g, "\n"), "utf8")).digest("hex");

const REFS = ["--connection-ref", "<TEST_CONNECTION>", "--host-key-ref", "<TEST_HOST_KEY>", "--credential-ref", "<TEST_CREDENTIAL>"];
const ENV = { CICD_SECRET_ID_PREFIX: "test/", AWS_REGION: "test-region-1" };

function sink(): { text: string; write(t: string): void } {
  const s = {
    text: "",
    write(t: string): void {
      s.text += t;
    },
  };
  return s;
}

let captured: { definitions: { getDeployScript(name: string): Promise<{ content: string }> } } | undefined;
class CapturingTransport extends Ssh2DeployTransport {
  public constructor(options: ConstructorParameters<typeof Ssh2DeployTransport>[0]) {
    super(options);
    captured = options as unknown as typeof captured;
  }
}

const realExecutor = (): Promise<ProbeExecutor> =>
  Promise.resolve({
    Ssh2DeployTransport: CapturingTransport as unknown as ProbeExecutor["Ssh2DeployTransport"],
    SecretsManagerSecretProvider: class {} as unknown as ProbeExecutor["SecretsManagerSecretProvider"],
    createSecretsManagerClient: () => {
      throw new Error("no SDK client may be created in tests");
    },
    redactString,
  });

describe("executor-ssh-probe argument parsing", () => {
  it("accepts the three logical refs and defaults from the environment", () => {
    expect(parseArgs(REFS, ENV)).toMatchObject({
      connectionRef: "<TEST_CONNECTION>",
      hostKeyRef: "<TEST_HOST_KEY>",
      credentialRef: "<TEST_CREDENTIAL>",
      dryRun: false,
      secretIdPrefix: "test/",
      region: "test-region-1",
    });
  });

  it.each([
    ["a missing ref", REFS.slice(0, 4)],
    ["a ref without angle brackets", ["--connection-ref", "PLAIN", ...REFS.slice(2)]],
    ["a lower-case ref", ["--connection-ref", "<lower>", ...REFS.slice(2)]],
    ["a literal host instead of a ref", ["--connection-ref", "203.0.113.1", ...REFS.slice(2)]],
    ["an unknown flag", [...REFS, "--no-verify"]],
    ["a flag without a value", [...REFS, "--region"]],
    ["a secret id prefix with illegal characters", [...REFS, "--secret-id-prefix", "bad prefix;x"]],
    ["a bad timeout", [...REFS, "--timeout-seconds", "0"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseArgs(argv, ENV)).toThrow();
  });

  it("runProbe answers a usage error with exit code 2 and the usage text", async () => {
    const stderr = sink();
    const code = await runProbe(["--connection-ref", "<TEST_CONNECTION>"], { stdout: sink(), stderr, env: ENV });
    expect(code).toBe(2);
    expect(stderr.text).toContain("Usage: executor-ssh-probe");
    expect(stderr.text).toContain("--host-key-ref is required");
  });

  it("runProbe exits 2 for an invalid ref form and for a missing secret prefix / region (non dry-run)", async () => {
    expect(await runProbe(["--connection-ref", "bad", ...REFS.slice(2)], { stdout: sink(), stderr: sink(), env: ENV })).toBe(2);
    const stderr = sink();
    expect(await runProbe(REFS, { stdout: sink(), stderr, env: {} })).toBe(2);
    expect(stderr.text).toContain("secret id prefix and a region are required");
  });
});

describe("executor-ssh-probe --dry-run", () => {
  it("prints the plan and the script sha256 without loading the SDK, the secrets provider or any SSH code", async () => {
    const stdout = sink();
    const forbidden = (): never => {
      throw new Error("must not be called in --dry-run");
    };
    const deps: ProbeDeps = { stdout, stderr: sink(), env: {}, loadExecutor: forbidden, createSecrets: forbidden };
    const code = await runProbe([...REFS, "--dry-run"], deps);
    expect(code).toBe(0);
    expect(stdout.text).toContain("<TEST_CONNECTION>");
    expect(stdout.text).toContain(`sha256=${scriptSha256}`);
    expect(stdout.text).toContain("no AWS call, no SSH connection");
  });
});

describe("executor-ssh-probe end to end against the in-process SSH server", () => {
  let hostKey: TestKeyPair;
  let clientKey: TestKeyPair;
  let server: SshTestServer;
  let probeScriptPath = "";

  const PROBE_STDOUT =
    "probe.bash_version=5.2.0\nprobe.flock_present=yes\nprobe.flock_contention=busy\nprobe.flock_release=free\n" +
    'CICD_RESULT {"status":"PROBE_OK","healthy":true}\n';

  function execHandler(result: { stdout: string; code: number }): (ctx: ExecContext) => void {
    return (ctx) => {
      if (ctx.command.startsWith("rm -rf")) {
        ctx.server.files.clear();
        return reply(ctx.stream, { code: 0 });
      }
      if (ctx.command.includes("target-probe.sh")) probeScriptPath = ctx.server.files.keys().next().value as string;
      reply(ctx.stream, result);
    };
  }

  async function run(opts: { pinned?: string; exec?: { stdout: string; code: number } } = {}) {
    server = new SshTestServer({
      hostKey,
      authorizedPublicKey: clientKey.publicKey,
      onExec: execHandler(opts.exec ?? { stdout: PROBE_STDOUT, code: 0 }),
    });
    const port = await server.listen();
    const secrets = new FakeSecretProvider({
      "<TEST_CONNECTION>": JSON.stringify({ host: "127.0.0.1", port, user: "deployer" }),
      "<TEST_HOST_KEY>": opts.pinned ?? hostKey.publicKey,
      "<TEST_CREDENTIAL>": clientKey.privateKey,
    });
    const stdout = sink();
    const stderr = sink();
    const code = await runProbe([...REFS, "--timeout-seconds", "20"], {
      stdout,
      stderr,
      env: ENV,
      loadExecutor: realExecutor,
      createSecrets: () => secrets,
    });
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  beforeEach(() => {
    hostKey = generateTestKeyPair();
    clientKey = generateTestKeyPair();
  });
  afterEach(async () => {
    await server?.close();
  });

  it("pinned host key OK: delivers the probe (verified sha256), runs it with no arguments and reports success", async () => {
    const r = await run();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("host key verified against the pinned key");
    expect(r.stdout).toContain(`read-back sha256 verified (${scriptSha256})`);
    expect(r.stdout).toContain("probe.flock_contention=busy");
    expect(r.stdout).toContain("CICD_RESULT parsed: yes (status PROBE_OK)");
    expect(r.stdout).toContain("probe OK");
    expect(server.authAttempts.length).toBeGreaterThan(0);
    expect(server.execCommands[0]).toMatch(/^'\/tmp\/cicd-probe-[0-9a-f]{12}\/target-probe\.sh'$/); // no arguments
    expect(probeScriptPath).toMatch(/^\/tmp\/cicd-probe-[0-9a-f]{12}\/target-probe\.sh$/);
    expect(server.execCommands.at(-1)).toMatch(/^rm -rf -- /); // cleaned up
    expect(server.files.size).toBe(0);
  });

  it("never prints the private key or the connection JSON; refuses any script name but the probe; redacts secret-looking probe lines", async () => {
    const r = await run({
      exec: { stdout: "probe.note=password=hunter2hunter2\n" + PROBE_STDOUT, code: 0 },
    });
    const all = r.stdout + r.stderr;
    const keyBody = clientKey.privateKey.split("\n")[1]!;
    expect(all).not.toContain(keyBody);
    expect(all).not.toContain("OPENSSH PRIVATE");
    expect(all).not.toContain("deployer");
    expect(all).not.toContain("127.0.0.1");
    expect(all).not.toContain(String(server.port));
    expect(all).not.toContain("hunter2hunter2");
    expect(all).toContain("probe.note=password=");
    await expect(captured!.definitions.getDeployScript("deploy-container.sh")).rejects.toThrow("unexpected script request");
    await expect(captured!.definitions.getDeployScript("target-probe.sh")).resolves.toHaveProperty("content");
  });

  it("a failing probe script (PROBE_FAILED, exit 10) makes the tool exit 1", async () => {
    const r = await run({ exec: { stdout: 'probe.failed_checks=flock_missing\nCICD_RESULT {"status":"PROBE_FAILED","healthy":false}\n', code: 10 } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("probe FAILED");
    expect(r.stdout).toContain("exit code: 10");
  });

  it("wrong pinned host key: HOST_KEY_MISMATCH, exit 1, no credential sent and nothing delivered or run", async () => {
    const r = await run({ pinned: generateTestKeyPair().publicKey });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HOST_KEY_MISMATCH");
    expect(r.stdout).not.toContain("host key verified");
    expect(server.authAttempts).toEqual([]);
    expect(server.execCommands).toEqual([]);
    expect(server.files.size).toBe(0);
  });
});
