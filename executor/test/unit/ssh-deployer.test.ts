// @akili-spec changes/cicd-executor-poc design §6.3, §6.5, §7.2, §7.5, DD-23, DD-28; requirements FR-12, FR-13; tasks R-5 (AC-02 V1)
// The ssh2 deploy transport against a REAL in-process ssh2 server (no mocks of ssh2).
// AC-02 V1: the target comes from the execution snapshot (host, port, user,
// pinned host-key lines, credential REFERENCE); the deploy script is INSTALLED on
// the target and run by path: nothing is uploaded (no SFTP, no checksum, no
// remote temporary directory and no remote cleanup).
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Ssh2DeployTransport,
  UnsafeArgumentError,
  assertSafeScriptArgs,
} from "../../src/adapters/ssh-deployer/index.js";
import { DeployTransportError, type DeploySession, type SshTarget } from "../../src/ports/deploy-transport.js";
import type { SecretProvider } from "../../src/ports/secret-provider.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";
import { SshTestServer, generateTestKeyPair, reply, type ExecContext, type TestKeyPair } from "../support/ssh-test-server.js";

const SCRIPT_PATH = "/opt/cicd/example-app/deploy.sh";
const EXECUTION_ID = "example-app-dev-1";
const CREDENTIAL_REF = "cicd-poc/dev/example-app-dev/ssh";

class SpySecrets implements SecretProvider {
  public readonly reads: string[] = [];
  public constructor(private readonly inner: FakeSecretProvider) {}
  public async getSecret(ref: string): Promise<string> {
    this.reads.push(ref);
    return this.inner.getSecret(ref);
  }
  public exists(ref: string): Promise<boolean> {
    return this.inner.exists(ref);
  }
}

/** Parses a command line made only of single-quoted words (`'\''` escapes), exactly as a POSIX shell would. */
function parseQuotedWords(command: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < command.length) {
    let word = "";
    for (;;) {
      if (command[i] === "'") {
        const end = command.indexOf("'", i + 1);
        word += command.slice(i + 1, end);
        i = end + 1;
      } else if (command[i] === "\\" && command[i + 1] === "'") {
        word += "'";
        i += 2;
      } else {
        break;
      }
    }
    words.push(word);
    if (i < command.length) {
      expect(command[i]).toBe(" "); // anything unquoted other than the word separator is a bug
      i += 1;
    }
  }
  return words;
}

describe("Ssh2DeployTransport against a real ssh2 server (AC-02 V1)", () => {
  let hostKey: TestKeyPair;
  let clientKey: TestKeyPair;
  let server: SshTestServer;
  let secrets: SpySecrets;
  let logs: string[];
  let logger: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void };
  let port: number;
  const open: DeploySession[] = [];

  const target = (over: Partial<SshTarget> = {}): SshTarget => ({
    targetId: "example-app-dev",
    host: "127.0.0.1",
    port,
    user: "deployer",
    hostKey: [hostKey.publicKey],
    credentialRef: CREDENTIAL_REF,
    ...over,
  });

  async function start(opts: { onExec?: (ctx: ExecContext) => void; credential?: string; password?: string } = {}): Promise<Ssh2DeployTransport> {
    server = new SshTestServer({
      hostKey,
      ...(opts.password === undefined ? { authorizedPublicKey: clientKey.publicKey } : { authorizedPassword: opts.password }),
      onExec: opts.onExec ?? (({ stream }) => reply(stream, { code: 0 })),
    });
    port = await server.listen();
    secrets = new SpySecrets(new FakeSecretProvider({ [CREDENTIAL_REF]: opts.credential ?? clientKey.privateKey }));
    return new Ssh2DeployTransport({ secrets, logger, readyTimeoutMs: 5_000 });
  }

  async function connect(transport: Ssh2DeployTransport, over: Partial<SshTarget> = {}): Promise<DeploySession> {
    const session = await transport.connect(target(over));
    open.push(session);
    return session;
  }

  beforeEach(() => {
    hostKey = generateTestKeyPair();
    clientKey = generateTestKeyPair();
    logs = [];
    const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
      logs.push(JSON.stringify({ level, message, fields }));
    };
    logger = { info: record("info"), warn: record("warn") };
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await server?.close();
  });

  it("verifies the pinned host key and runs the script installed at deployScript, uploading nothing", async () => {
    const transport = await start({
      onExec: ({ stream }) =>
        reply(stream, {
          stdout: 'noise\nCICD_RESULT {"status":"SUCCESS","deployedImages":{"app":"repo@sha256:abc"},"migrations":"NONE","healthy":true}\n',
          code: 0,
        }),
    });
    const session = await connect(transport);
    const outcome = await session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: ["--execution-id", EXECUTION_ID], timeoutMs: 10_000 });
    expect(outcome).toMatchObject({
      kind: "EXIT",
      exitCode: 0,
      cicdResult: { status: "SUCCESS", migrations: "NONE", healthy: true, deployedImages: { app: "repo@sha256:abc" } },
    });
    expect(server.execCommands).toEqual([`'${SCRIPT_PATH}' '--execution-id' '${EXECUTION_ID}'`]);
    expect(server.files.size).toBe(0);
    expect(server.directories.size).toBe(0);
  });

  it("connects to the snapshot's port (default 22 only when absent) and user", async () => {
    const transport = await start();
    await connect(transport);
    expect(server.connectionCount).toBe(1);
  });

  it("HOST_KEY_MISMATCH: an unregistered host key is never accepted, never retried, and nothing runs (FR-12)", async () => {
    const transport = await start();
    await expect(transport.connect(target({ hostKey: [generateTestKeyPair().publicKey] }))).rejects.toMatchObject({
      name: "DeployTransportError",
      code: "HOST_KEY_MISMATCH",
    });
    expect(server.authAttempts).toEqual([]); // aborted before authentication: no credential reached the host
    expect(server.execCommands).toEqual([]);
    expect(server.connectionCount).toBe(1); // a single attempt: never retried
  });

  it("fails closed, without connecting or reading the credential, when no pinned host-key line is usable", async () => {
    const transport = await start();
    await expect(transport.connect(target({ hostKey: ["# not a key"] }))).rejects.toMatchObject({ code: "HOST_KEY_MISMATCH" });
    expect(server.connectionCount).toBe(0);
    expect(secrets.reads).toEqual([]);
  });

  it("accepts any one of several pinned keys (rotation)", async () => {
    const transport = await start();
    await connect(transport, { hostKey: [generateTestKeyPair().publicKey, `${hostKey.publicKey} comment`] });
    expect(server.connectionCount).toBe(1);
  });

  it("passes hostile arguments to the remote command literally (FR-12 arguments)", async () => {
    const transport = await start();
    const session = await connect(transport);
    const hostile = [
      "--artifact",
      "app=sha256:" + "a".repeat(64),
      "x; touch /tmp/pwned",
      "$(touch /tmp/pwned)",
      "`touch /tmp/pwned`",
      "it's \"quoted\" and 'again'",
      "a && b || c | d > e",
      "$HOME ${IFS} *",
      "",
      "--flag=-rf /",
      "'; rm -rf / #",
    ];
    await session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: hostile, timeoutMs: 10_000 });
    const received = server.execCommands.find((c) => c.startsWith(`'${SCRIPT_PATH}'`));
    expect(received).toBeDefined();
    expect(parseQuotedWords(received!)).toEqual([SCRIPT_PATH, ...hostile]);

    // With a real POSIX shell available, prove the shell itself sees the exact argv and executes nothing.
    const sh = spawnSync("sh", ["-c", "true"]);
    if (sh.status === 0) {
      const rest = received!.slice(`'${SCRIPT_PATH}'`.length);
      const probe = spawnSync("sh", ["-c", `printf '%s\\0' ${rest}`], { encoding: "utf8" });
      expect(probe.stdout.split("\0").slice(0, -1)).toEqual(hostile);
    }
  });

  it("rejects an argument containing a line break before sending anything", async () => {
    expect(() => assertSafeScriptArgs(["ok", "bad\nvalue"])).toThrow(UnsafeArgumentError);
    expect(() => assertSafeScriptArgs(["bad\rvalue"])).toThrow(UnsafeArgumentError);
    expect(() => assertSafeScriptArgs(["bad\0value"])).toThrow(UnsafeArgumentError);

    const transport = await start();
    const session = await connect(transport);
    await expect(
      session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: ["--target-id", "a\nrm -rf /"], timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(UnsafeArgumentError);
    expect(server.execCommands).toEqual([]);
  });

  it.each(["relative/deploy.sh", "/opt/../bin/sh", "/opt/./x.sh", "/opt/cicd/", "/opt/cicd/deploy.sh;id", "/opt/cicd/deploy sh", "/"])(
    "refuses the unsafe script path %j before sending anything (defense in depth behind the record schema)",
    async (scriptPath) => {
      const transport = await start();
      const session = await connect(transport);
      await expect(session.exec({ executionId: EXECUTION_ID, scriptPath, args: [], timeoutMs: 10_000 })).rejects.toBeInstanceOf(UnsafeArgumentError);
      expect(server.execCommands).toEqual([]);
    },
  );

  describe("connect failures", () => {
    it("makes ONE attempt per connect() (the coordinator owns the §7.2 retry loop) and its error carries no host, IP or port (DD-23)", async () => {
      const transport = await start();
      const closedPort = port;
      await server.close();
      const error = (await transport.connect(target({ port: closedPort })).catch((e: unknown) => e)) as Error;
      expect(error).toMatchObject({ name: "DeployTransportError", code: "SSH_CONNECT" });
      expect(secrets.reads.filter((r) => r === CREDENTIAL_REF)).toHaveLength(1);
      for (const text of [error.message, logs.join(" ")]) {
        expect(text).not.toContain("127.0.0.1");
        expect(text).not.toContain(String(closedPort));
        expect(text).not.toMatch(/ECONNREFUSED|ENOTFOUND/);
      }
    });

    it("an unreadable credential fails as SSH_CONNECT without connecting", async () => {
      server = new SshTestServer({ hostKey, authorizedPublicKey: clientKey.publicKey });
      port = await server.listen();
      const transport = new Ssh2DeployTransport({ secrets: new FakeSecretProvider({}), logger, readyTimeoutMs: 2_000 });
      await expect(transport.connect(target())).rejects.toMatchObject({ code: "SSH_CONNECT" });
      expect(server.connectionCount).toBe(0);
    });
  });

  it("does not retry after exec started: a dropped session is SESSION_LOST and the script is not re-run (DD-28)", async () => {
    const transport = await start({ onExec: ({ server: s }) => s.dropConnections() });
    const session = await connect(transport);
    const outcome = await session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: ["--target-id", "t"], timeoutMs: 10_000 });
    expect(outcome).toEqual({ kind: "SESSION_LOST" });
    expect(server.execCommands).toHaveLength(1);
    expect(server.connectionCount).toBe(1);
    await expect(session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: [], timeoutMs: 1_000 })).rejects.toThrow(/never run twice/);
  });

  it("reports TIMEOUT without aborting the script and runs nothing else on close", async () => {
    const transport = await start({ onExec: () => undefined }); // never replies
    const session = await connect(transport);
    const outcome = await session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: [], timeoutMs: 150 });
    expect(outcome).toEqual({ kind: "TIMEOUT" });
    await session.close();
    expect(server.execCommands).toHaveLength(1);
  });

  it("closing a session runs no remote cleanup command (nothing was delivered) and is idempotent", async () => {
    const transport = await start({ onExec: ({ stream }) => reply(stream, { code: 10 }) });
    const session = await connect(transport);
    expect(await session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: [], timeoutMs: 10_000 })).toMatchObject({ kind: "EXIT", exitCode: 10 });
    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
    expect(server.execCommands).toEqual([`'${SCRIPT_PATH}'`]);
  });

  describe("CICD_RESULT (design §6.5)", () => {
    const run = async (stdout: string, code: number) => {
      const transport = await start({ onExec: ({ stream }) => reply(stream, { stdout, stderr: "warn\n", code }) });
      const session = await connect(transport);
      return session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: [], timeoutMs: 10_000 });
    };

    it("is parsed from the last stdout line", async () => {
      const outcome = await run('x\nCICD_RESULT {"status":"FAILED","migrations":"FAILED"}\n', 20);
      expect(outcome).toMatchObject({ kind: "EXIT", exitCode: 20, cicdResult: { status: "FAILED", migrations: "FAILED" } });
    });

    it("is treated as missing when malformed, but the exit code is still returned", async () => {
      const outcome = await run("CICD_RESULT {not json\n", 30);
      expect(outcome).toMatchObject({ kind: "EXIT", exitCode: 30 });
      expect(outcome.kind === "EXIT" && outcome.cicdResult).toBeUndefined();
    });

    it("is treated as missing when absent", async () => {
      const outcome = await run("just logs\n", 2);
      expect(outcome).toMatchObject({ kind: "EXIT", exitCode: 2 });
      expect(outcome.kind === "EXIT" && outcome.cicdResult).toBeUndefined();
    });

    it("is not trusted partially: a valid line that is NOT the last line is ignored", async () => {
      const outcome = await run('CICD_RESULT {"status":"SUCCESS"}\ntrailing log\n', 0);
      expect(outcome.kind === "EXIT" && outcome.cicdResult).toBeUndefined();
    });

    it("returns a log tail that includes stderr", async () => {
      const outcome = await run("out\n", 0);
      expect(outcome.kind === "EXIT" && outcome.logTail).toContain("warn");
    });
  });

  describe("credentials (FR-12, DD-23)", () => {
    it("never appear in logs, results or errors; the key is read at the point of use only, through credentialRef", async () => {
      const transport = await start();
      const session = await connect(transport);
      const outcome = await session.exec({ executionId: EXECUTION_ID, scriptPath: SCRIPT_PATH, args: ["--target-id", "t"], timeoutMs: 10_000 });
      await session.close();
      const keyBody = clientKey.privateKey.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"));
      const everything = logs.join("\n") + JSON.stringify(outcome);
      for (const line of keyBody) expect(everything).not.toContain(line);
      expect(everything).not.toContain("PRIVATE KEY");
      expect(secrets.reads).toEqual([CREDENTIAL_REF]);
    });

    it("authenticates with the private key only: a password secret is never offered as a password (V1 record has no temporary-password marker)", async () => {
      const transport = await start({ password: "S3cretPassw0rd-for-test", credential: "S3cretPassw0rd-for-test" });
      const error = (await transport.connect(target()).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(DeployTransportError);
      expect((error as DeployTransportError).code).toBe("SSH_CONNECT");
      expect(server.authAttempts).not.toContain("password");
      expect(error.message).not.toContain("S3cretPassw0rd-for-test");
      expect(logs.join("\n")).not.toContain("S3cretPassw0rd-for-test");
    });
  });
});
