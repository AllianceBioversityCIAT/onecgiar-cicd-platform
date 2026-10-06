// @akili-spec changes/cicd-executor-poc design §6.5, §7.2, §7.5, DD-10, DD-23, DD-28; requirements FR-12, FR-13
// N-13: the ssh2 deploy transport against a REAL in-process ssh2 server (no mocks of ssh2).
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Ssh2DeployTransport,
  UnsafeArgumentError,
  assertSafeScriptArgs,
  remoteDirFor,
  type TargetConnectionDetails,
} from "../../src/adapters/ssh-deployer/index.js";
import { DeployTransportError, type DeploySession } from "../../src/ports/deploy-transport.js";
import type { SecretProvider } from "../../src/ports/secret-provider.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";
import { SshTestServer, generateTestKeyPair, reply, type ExecContext, type TestKeyPair } from "../support/ssh-test-server.js";

const SCRIPT_NAME = "deploy-container.sh";
const SCRIPT_BODY = "#!/usr/bin/env bash\necho fake bundled script\n";
const EXECUTION_ID = "exec-0001";
const SCRIPT_PATH = `${remoteDirFor(EXECUTION_ID)}/${SCRIPT_NAME}`;
const TARGET: TargetConnectionDetails = {
  connectionRef: "<TEST_CONNECTION>",
  hostKeyRef: "<TEST_HOST_KEY>",
  credentialRef: "<TEST_CREDENTIAL>",
};

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

function scriptExec(handler: (ctx: ExecContext) => void): (ctx: ExecContext) => void {
  return (ctx) => {
    if (ctx.command.startsWith("rm -rf")) {
      ctx.server.files.clear();
      return reply(ctx.stream, { code: 0 });
    }
    handler(ctx);
  };
}

describe("Ssh2DeployTransport against a real ssh2 server", () => {
  let hostKey: TestKeyPair;
  let clientKey: TestKeyPair;
  let server: SshTestServer;
  let secrets: SpySecrets;
  let logs: string[];
  let logger: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void };
  const open: DeploySession[] = [];
  let delivered: { executionId: string; sha256: string; definitionRef: string }[];

  async function start(opts: {
    onExec?: (ctx: ExecContext) => void;
    corruptWritesWith?: Buffer;
    pinnedKey?: string;
    password?: string;
    temporaryPassword?: boolean;
    port?: number;
  } = {}): Promise<Ssh2DeployTransport> {
    server = new SshTestServer({
      hostKey,
      ...(opts.password === undefined ? { authorizedPublicKey: clientKey.publicKey } : { authorizedPassword: opts.password }),
      onExec: opts.onExec ?? scriptExec(({ stream }) => reply(stream, { code: 0 })),
      ...(opts.corruptWritesWith === undefined ? {} : { corruptWritesWith: opts.corruptWritesWith }),
    });
    const port = await server.listen();
    const connectPort = opts.port ?? port;
    secrets = new SpySecrets(
      new FakeSecretProvider({
        "<TEST_CONNECTION>": JSON.stringify({ host: "127.0.0.1", port: connectPort, user: "deployer" }),
        "<TEST_HOST_KEY>": opts.pinnedKey ?? hostKey.publicKey,
        "<TEST_CREDENTIAL>": opts.password ?? clientKey.privateKey,
      }),
    );
    delivered = [];
    return new Ssh2DeployTransport({
      secrets,
      definitions: new InMemoryDefinitionSource({ deployScripts: { [SCRIPT_NAME]: SCRIPT_BODY }, definitionRef: "test-ref" }),
      targets: {
        resolve: async () => ({ ...TARGET, ...(opts.temporaryPassword === true ? { temporaryPassword: true } : {}) }),
      },
      logger,
      onScriptDelivered: (info) => delivered.push(info),
      readyTimeoutMs: 5_000,
    });
  }

  async function connectAndDeliver(transport: Ssh2DeployTransport): Promise<DeploySession> {
    const session = await transport.connect("target-a");
    open.push(session);
    await session.deliverScript(EXECUTION_ID);
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

  it("verifies the pinned host key, delivers the script (0700, checksum recorded) and runs it", async () => {
    const transport = await start({
      onExec: scriptExec(({ stream }) =>
        reply(stream, {
          stdout: 'noise\nCICD_RESULT {"status":"SUCCESS","deployedImages":{"app":"repo@sha256:abc"},"migrations":"NONE","healthy":true}\n',
          code: 0,
        }),
      ),
    });
    const session = await connectAndDeliver(transport);
    expect(server.files.get(SCRIPT_PATH)?.toString("utf8")).toBe(SCRIPT_BODY);
    expect((server.fileModes.get(SCRIPT_PATH) ?? 0) & 0o777).toBe(0o500); // owner read/exec only: not writable after delivery
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const outcome = await session.exec({ executionId: EXECUTION_ID, args: ["--execution-id", EXECUTION_ID], timeoutMs: 10_000 });
    expect(outcome).toMatchObject({
      kind: "EXIT",
      exitCode: 0,
      cicdResult: { status: "SUCCESS", migrations: "NONE", healthy: true, deployedImages: { app: "repo@sha256:abc" } },
    });
    expect(server.execCommands[0]).toBe(`'${SCRIPT_PATH}' '--execution-id' '${EXECUTION_ID}'`);
  });

  it("HOST_KEY_MISMATCH: an unregistered host key is never accepted, never retried, and nothing runs (FR-12)", async () => {
    const other = generateTestKeyPair();
    const transport = await start({ pinnedKey: other.publicKey });
    await expect(transport.connect("target-a")).rejects.toMatchObject({ name: "DeployTransportError", code: "HOST_KEY_MISMATCH" });
    expect(server.authAttempts).toEqual([]); // the handshake was aborted before authentication: no credential reached the host
    expect(server.execCommands).toEqual([]);
    expect(server.files.size).toBe(0);
    expect(server.connectionCount).toBe(1); // a single attempt: never retried
    expect(secrets.reads.filter((r) => r === TARGET.credentialRef)).toHaveLength(1);
  });

  it("fails closed when the pinned host key resolves to nothing usable", async () => {
    const transport = await start({ pinnedKey: "# empty\n" });
    await expect(transport.connect("target-a")).rejects.toMatchObject({ code: "HOST_KEY_MISMATCH" });
    expect(server.connectionCount).toBe(0);
  });

  it("accepts any one of several pinned keys (rotation)", async () => {
    const transport = await start({ pinnedKey: `${generateTestKeyPair().publicKey}\n${hostKey.publicKey} comment\n` });
    const session = await transport.connect("target-a");
    open.push(session);
    expect(server.connectionCount).toBe(1);
  });

  it("passes hostile arguments to the remote command literally (FR-12 arguments)", async () => {
    const transport = await start();
    const session = await connectAndDeliver(transport);
    const hostile = [
      "--artifact",
      "app=repo@sha256:" + "a".repeat(64),
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
    await session.exec({ executionId: EXECUTION_ID, args: hostile, timeoutMs: 10_000 });
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

  it("rejects an argument containing a line break before sending anything (forward pointer from T-13)", async () => {
    expect(() => assertSafeScriptArgs(["ok", "bad\nvalue"])).toThrow(UnsafeArgumentError);
    expect(() => assertSafeScriptArgs(["bad\rvalue"])).toThrow(UnsafeArgumentError);
    expect(() => assertSafeScriptArgs(["bad\0value"])).toThrow(UnsafeArgumentError);

    const transport = await start();
    const session = await connectAndDeliver(transport);
    await expect(
      session.exec({ executionId: EXECUTION_ID, args: ["--unit", "a\nrm -rf /"], timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(UnsafeArgumentError);
    expect(server.execCommands.filter((c) => c.includes(SCRIPT_NAME))).toEqual([]);
  });

  it("rejects an unsafe executionId before touching the remote filesystem", async () => {
    const transport = await start();
    const session = await transport.connect("target-a");
    open.push(session);
    await expect(session.deliverScript("../../etc")).rejects.toBeInstanceOf(DeployTransportError);
    expect(server.files.size).toBe(0);
    expect(server.directories.size).toBe(0);
  });

  describe("connect failures", () => {
    it("makes ONE attempt per connect() (the coordinator owns the §7.2 retry loop) and its error carries no host, IP or port (DD-23)", async () => {
      const probe = new SshTestServer({ hostKey });
      const port = await probe.listen();
      await probe.close();
      const spy = new SpySecrets(
        new FakeSecretProvider({
          "<TEST_CONNECTION>": JSON.stringify({ host: "127.0.0.1", port, user: "deployer" }),
          "<TEST_HOST_KEY>": hostKey.publicKey,
          "<TEST_CREDENTIAL>": clientKey.privateKey,
        }),
      );
      const transport = new Ssh2DeployTransport({
        secrets: spy,
        definitions: new InMemoryDefinitionSource({ deployScripts: { [SCRIPT_NAME]: SCRIPT_BODY } }),
        targets: { resolve: async () => TARGET },
        readyTimeoutMs: 2_000,
        logger,
      });
      const error = (await transport.connect("target-a").catch((e: unknown) => e)) as Error;
      expect(error).toMatchObject({ name: "DeployTransportError", code: "SSH_CONNECT" });
      expect(spy.reads.filter((r) => r === TARGET.credentialRef)).toHaveLength(1);
      for (const text of [error.message, logs.join(" ")]) {
        expect(text).not.toContain("127.0.0.1");
        expect(text).not.toContain(String(port));
        expect(text).not.toMatch(/ECONNREFUSED|ENOTFOUND/);
      }
    });
  });

  describe("temporary directory hijack (FR-12: the script executed is the one delivered)", () => {
    const DIR = remoteDirFor(EXECUTION_ID);

    it.each([
      ["world-writable (0777) directory owned by another user", 0o777, 1001],
      ["private directory owned by another user", 0o700, 1001],
      ["open (0777) directory even if owned by the SSH user", 0o777, 1000],
      ["private directory owned by the SSH user (not created by this attempt)", 0o700, 1000],
    ])("refuses a pre-existing %s, fails before exec and removes nothing", async (_name, mode, uid) => {
      const transport = await start();
      server.seedDirectory(DIR, mode, uid);
      const session = await transport.connect("target-a");
      open.push(session);
      await expect(session.deliverScript(EXECUTION_ID)).rejects.toMatchObject({ name: "DeployTransportError", code: "SSH_CONNECT" });
      expect(server.files.size).toBe(0);
      expect(server.execCommands).toEqual([]);
      await session.close();
      expect(server.execCommands).toEqual([]); // the foreign directory is not ours to remove
    });

    it("creates a fresh private (0700) directory and a non-writable script", async () => {
      const transport = await start();
      const session = await connectAndDeliver(transport);
      void session;
      expect(server.directories.get(DIR)).toEqual({ mode: 0o700, uid: 1000 });
      expect((server.fileModes.get(SCRIPT_PATH) ?? 0) & 0o222).toBe(0);
    });
  });

  it("does not retry after exec started: a dropped session is SESSION_LOST and the script is not re-run (DD-28)", async () => {
    const transport = await start({
      onExec: scriptExec(({ server: s }) => {
        s.dropConnections();
      }),
    });
    const session = await connectAndDeliver(transport);
    const outcome = await session.exec({ executionId: EXECUTION_ID, args: ["--unit", "u"], timeoutMs: 10_000 });
    expect(outcome).toEqual({ kind: "SESSION_LOST" });
    expect(server.execCommands.filter((c) => c.includes(SCRIPT_NAME))).toHaveLength(1);
    expect(server.connectionCount).toBe(1);
    await expect(session.exec({ executionId: EXECUTION_ID, args: [], timeoutMs: 1_000 })).rejects.toThrow(/never run twice/);
    await session.close();
    expect(server.execCommands.some((c) => c.startsWith("rm -rf"))).toBe(false); // the script may still be running: nothing is removed
  });

  it("reports TIMEOUT without aborting the script or removing its files", async () => {
    const transport = await start({ onExec: scriptExec(() => undefined) }); // never replies
    const session = await connectAndDeliver(transport);
    const outcome = await session.exec({ executionId: EXECUTION_ID, args: [], timeoutMs: 150 });
    expect(outcome).toEqual({ kind: "TIMEOUT" });
    await session.close();
    expect(server.execCommands.some((c) => c.startsWith("rm -rf"))).toBe(false);
    expect(server.files.has(SCRIPT_PATH)).toBe(true);
  });

  describe("CICD_RESULT (design §6.5)", () => {
    const run = async (stdout: string, code: number) => {
      const transport = await start({ onExec: scriptExec(({ stream }) => reply(stream, { stdout, stderr: "warn\n", code })) });
      const session = await connectAndDeliver(transport);
      return session.exec({ executionId: EXECUTION_ID, args: [], timeoutMs: 10_000 });
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

  it("SFTP checksum mismatch fails before exec and removes the temporary directory", async () => {
    const transport = await start({ corruptWritesWith: Buffer.from("tampered") });
    const session = await transport.connect("target-a");
    open.push(session);
    await expect(session.deliverScript(EXECUTION_ID)).rejects.toMatchObject({ name: "DeployTransportError", code: "SSH_CONNECT" });
    expect(delivered).toEqual([]);
    expect(server.execCommands.filter((c) => c.includes(SCRIPT_NAME))).toEqual([]);
    await session.close();
    expect(server.execCommands).toEqual([`rm -rf -- '${remoteDirFor(EXECUTION_ID)}' '${remoteDirFor(EXECUTION_ID)}.result.json'`]);
  });

  it("removes /tmp/cicd-{executionId} at the end, best effort, without masking the result", async () => {
    const transport = await start({
      onExec: (ctx) => (ctx.command.startsWith("rm -rf") ? reply(ctx.stream, { code: 1, stderr: "cannot remove" }) : reply(ctx.stream, { code: 10 })),
    });
    const session = await connectAndDeliver(transport);
    const outcome = await session.exec({ executionId: EXECUTION_ID, args: [], timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ kind: "EXIT", exitCode: 10 }); // cleanup failure below must not change this
    await expect(session.close()).resolves.toBeUndefined();
    expect(server.execCommands.at(-1)).toBe(`rm -rf -- '${remoteDirFor(EXECUTION_ID)}' '${remoteDirFor(EXECUTION_ID)}.result.json'`);
    await expect(session.close()).resolves.toBeUndefined(); // idempotent
  });

  describe("credentials (FR-12, DD-23)", () => {
    it("never appear in logs, results or errors; the key is read at the point of use only", async () => {
      const transport = await start();
      const session = await connectAndDeliver(transport);
      const outcome = await session.exec({ executionId: EXECUTION_ID, args: ["--unit", "u"], timeoutMs: 10_000 });
      await session.close();
      const keyBody = clientKey.privateKey.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"));
      const everything = logs.join("\n") + JSON.stringify(outcome);
      for (const line of keyBody) expect(everything).not.toContain(line);
      expect(everything).not.toContain("PRIVATE KEY");
      expect(secrets.reads.filter((r) => r === TARGET.credentialRef)).toHaveLength(1);
    });

    it("a wrong password fails as SSH_CONNECT without echoing the password anywhere", async () => {
      const transport = await start({ password: "S3cretPassw0rd-for-test", temporaryPassword: true });
      // Make the server expect a different password than the one the secret provider returns.
      await server.close();
      server = new SshTestServer({ hostKey, authorizedPassword: "another-password" });
      const port = await server.listen();
      const wrong = new Ssh2DeployTransport({
        secrets: new FakeSecretProvider({
          "<TEST_CONNECTION>": JSON.stringify({ host: "127.0.0.1", port, user: "deployer" }),
          "<TEST_HOST_KEY>": hostKey.publicKey,
          "<TEST_CREDENTIAL>": "S3cretPassw0rd-for-test",
        }),
        definitions: new InMemoryDefinitionSource({ deployScripts: { [SCRIPT_NAME]: SCRIPT_BODY } }),
        targets: { resolve: async () => ({ ...TARGET, temporaryPassword: true }) },
        logger,
        readyTimeoutMs: 3_000,
      });
      void transport;
      const error = (await wrong.connect("target-a").catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(DeployTransportError);
      expect((error as DeployTransportError).code).toBe("SSH_CONNECT");
      expect(error.message).not.toContain("S3cretPassw0rd-for-test");
      expect(logs.join("\n")).not.toContain("S3cretPassw0rd-for-test");
    });

    it("uses a password only when the target is marked temporary", async () => {
      const transport = await start({ password: "S3cretPassw0rd-for-test", temporaryPassword: true });
      const session = await transport.connect("target-a");
      open.push(session);
      expect(server.authAttempts).toContain("password");
    });

    it("does not fall back to a password for a target not marked temporary", async () => {
      const transport = await start({ password: "S3cretPassw0rd-for-test" }); // key auth attempted with a non-key secret
      await expect(transport.connect("target-a")).rejects.toMatchObject({ code: "SSH_CONNECT" });
      expect(server.authAttempts).not.toContain("password");
    });
  });
});
