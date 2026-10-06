// @akili-spec changes/cicd-executor-poc design §6.5, §7.2, §7.5, DD-10, DD-22, DD-23, DD-28; requirements FR-12, FR-13
//
// `DeployTransport` over `ssh2`. The adapter only connects, delivers the
// bundled script (SFTP) and runs it with quoted ARGUMENTS; it never looks
// inside the script, never decides what the arguments mean and carries no
// per-project logic (NFR-01).
//
// Security properties (each covered by a test against a REAL ssh2 server):
//  - Host key pinning: `hostVerifier` compares the presented key with the key
//    pinned in the registry (`hostKeyRef`). Anything else aborts the handshake
//    before authentication, so no credential is ever sent to an unverified
//    host; the failure is HOST_KEY_MISMATCH and is never retried.
//  - Credential read through `SecretProvider` at the point of use, per connect
//    attempt, kept only in a local variable and in the ssh2 config; never
//    logged, never written to disk. Private key by default; a password only
//    when the target is explicitly marked temporary (FR-12).
//  - Script integrity: the script is uploaded with an exclusive create into a
//    0700 directory, then READ BACK over SFTP and hashed locally (sha256) and
//    compared with the hash of the bytes the adapter intended to deliver. Read
//    back over SFTP rather than a remote `sha256sum`: it needs no remote shell
//    or coreutils, executes nothing on the target before the script, and
//    checks the bytes the target will actually run.
//  - Retries: none here (one attempt per connect(); the coordinator owns the §7.2 loop).
//    Nothing is ever retried after exec starts; a lost session is reported, not re-run (DD-28).
//  - Errors never carry raw ssh2 text (it can contain host, IP or port: DD-23); messages are generic.
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Client as Ssh2Client, ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import type { DefinitionSource } from "../../ports/definition-source.js";
import {
  DeployTransportError,
  type CicdResult,
  type DeploySession,
  type DeployTransport,
  type ScriptExecOutcome,
  type ScriptExecRequest,
} from "../../ports/deploy-transport.js";
import type { SecretProvider } from "../../ports/secret-provider.js";
import { redactString } from "../../observability/logger/redaction.js";
import { parseResolvedConnection } from "../../application/definition-service/registry-rules.js";
import { parseCicdResult } from "./cicd-result.js";
import { hostKeyFingerprint, matchesPinnedHostKey, parsePinnedHostKeys } from "./host-key.js";
import { assertSafeExecutionId, buildRemoteCommand, shellQuote } from "./shell-quote.js";
import { Client } from "./ssh2-module.js";

/** Logical references of one target (Target Registry entry, design §6.3). Values are references, never resolved secrets. */
export interface TargetConnectionDetails {
  readonly connectionRef: string;
  readonly hostKeyRef: string;
  readonly credentialRef: string;
  /** FR-12: a password is accepted ONLY when the registry entry marks it temporary. Default: private key. */
  readonly temporaryPassword?: boolean;
}

/** Resolves the opaque `targetRef` of the coordinator to the registry's references. */
export interface TargetResolver {
  resolve(targetRef: string): Promise<TargetConnectionDetails | undefined>;
}

export interface DeployTransportLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface Ssh2DeployTransportOptions {
  readonly secrets: SecretProvider;
  readonly definitions: DefinitionSource;
  readonly targets: TargetResolver;
  readonly logger?: DeployTransportLogger;
  /** Bundled script name for `DefinitionSource.getDeployScript`. Default `deploy-container.sh`. */
  readonly scriptName?: string;
  readonly readyTimeoutMs?: number;
  /** FR-12: invoked with the sha256 of the delivered script so the caller can record it. */
  readonly onScriptDelivered?: (info: { executionId: string; sha256: string; definitionRef: string }) => void;
}

const DEFAULT_SCRIPT_NAME = "deploy-container.sh";
const SFTP_CHUNK = 32 * 1024;
const LOG_TAIL_CHARS = 16 * 1024;
const STDOUT_TAIL_CHARS = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 15_000;

export function remoteDirFor(executionId: string): string {
  return `/tmp/cicd-${executionId}`;
}

export class Ssh2DeployTransport implements DeployTransport {
  public constructor(private readonly options: Ssh2DeployTransportOptions) {}

  /**
   * ONE attempt per call. The "2 retries before exec" policy (design §7.2) is
   * owned by the deploy coordinator; retrying here too would multiply attempts.
   */
  public async connect(targetRef: string): Promise<DeploySession> {
    return this.connectOnce(targetRef);
  }

  private async connectOnce(targetRef: string): Promise<DeploySession> {
    const { secrets, targets } = this.options;
    const details = await targets.resolve(targetRef);
    if (details === undefined) throw new DeployTransportError("SSH_CONNECT", "unknown deploy target");

    let pinned: Buffer[];
    let host: string;
    let port: number;
    let username: string;
    try {
      const connection = parseResolvedConnection(details.connectionRef, await secrets.getSecret(details.connectionRef));
      if (connection.user === undefined) throw new Error("connection identity has no user");
      host = connection.host;
      port = connection.port ?? 22;
      username = connection.user;
      pinned = parsePinnedHostKeys(await secrets.getSecret(details.hostKeyRef));
    } catch {
      throw new DeployTransportError("SSH_CONNECT", "cannot resolve the target connection");
    }
    // Fail closed: without a usable pinned key nothing can be verified, so nothing is connected.
    if (pinned.length === 0) {
      throw new DeployTransportError("HOST_KEY_MISMATCH", "no usable pinned host key resolved for the target");
    }

    let presentedFingerprint: string | undefined;
    let mismatch = false;
    const hostVerifier = (presented: Buffer): boolean => {
      if (matchesPinnedHostKey(presented, pinned)) return true;
      mismatch = true;
      presentedFingerprint = hostKeyFingerprint(presented);
      return false;
    };

    // Credential read at the point of use; it lives only in this scope and in the ssh2 config.
    let secretValue: string;
    try {
      secretValue = await secrets.getSecret(details.credentialRef);
    } catch {
      throw new DeployTransportError("SSH_CONNECT", "cannot read the SSH credential");
    }
    const auth: Pick<ConnectConfig, "privateKey" | "password"> =
      details.temporaryPassword === true ? { password: secretValue } : { privateKey: secretValue };

    const client = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("ready", () => resolve());
        client.once("error", (error: Error) => reject(error));
        client.once("close", () => reject(new Error("connection closed before ready")));
        try {
          client.connect({
            host,
            port,
            username,
            ...auth,
            hostVerifier,
            readyTimeout: this.options.readyTimeoutMs ?? 20_000,
            keepaliveInterval: 15_000,
            keepaliveCountMax: 3,
            tryKeyboard: false,
          });
        } catch (error) {
          reject(error);
        }
      });
    } catch {
      client.destroy();
      if (mismatch) {
        this.options.logger?.warn("ssh host key mismatch; connection aborted before authentication", {
          targetRef,
          presentedFingerprint,
        });
        throw new DeployTransportError("HOST_KEY_MISMATCH", "presented host key does not match the pinned host key");
      }
      throw new DeployTransportError("SSH_CONNECT", "SSH connection failed");
    }

    // Post-ready errors (keepalive timeout, reset) are surfaced through the exec outcome; never crash the process.
    client.on("error", () => undefined);
    return new Ssh2DeploySession(client, targetRef, this.options, secretValue);
  }
}

class Ssh2DeploySession implements DeploySession {
  private executionId: string | undefined;
  private execStarted = false;
  /** Temp files may only be removed when the script never started or has finished (it uses them while running). */
  private cleanupAllowed = false;
  private closed = false;
  private lost = false;

  public constructor(
    private readonly client: Ssh2Client,
    private readonly targetRef: string,
    private readonly options: Ssh2DeployTransportOptions,
    private readonly secretValue: string,
  ) {
    client.once("close", () => {
      this.lost = true;
    });
  }

  public async deliverScript(executionId: string): Promise<void> {
    try {
      assertSafeExecutionId(executionId);
      const script = await this.options.definitions.getDeployScript(this.options.scriptName ?? DEFAULT_SCRIPT_NAME);
      const bytes = Buffer.from(script.content, "utf8");
      const expected = createHash("sha256").update(bytes).digest("hex");
      const dir = remoteDirFor(executionId);
      const file = `${dir}/${this.options.scriptName ?? DEFAULT_SCRIPT_NAME}`;
      this.executionId = executionId;
      const sftp = await openSftp(this.client);
      try {
        await sftpMkdirFresh(sftp, dir);
        this.cleanupAllowed = true; // only a directory created by THIS attempt is ever removed
        await sftpUpload(sftp, file, bytes);
        const actual = await sftpSha256(sftp, file, bytes.length);
        if (actual !== expected) {
          throw new DeployTransportError("SSH_CONNECT", "delivered script checksum does not match the bundled script");
        }
      } finally {
        sftp.end();
      }
      this.options.logger?.info("deploy script delivered", { targetRef: this.targetRef, executionId, sha256: expected });
      this.options.onScriptDelivered?.({ executionId, sha256: expected, definitionRef: script.definitionRef });
    } catch (error) {
      if (error instanceof DeployTransportError) throw error;
      throw new DeployTransportError("SSH_CONNECT", "script delivery failed");
    }
  }

  public async exec(request: ScriptExecRequest): Promise<ScriptExecOutcome> {
    if (this.execStarted) throw new Error("the deploy script is never run twice on a session");
    if (this.executionId === undefined || this.executionId !== request.executionId) {
      throw new Error("the script was not delivered for this execution");
    }
    // Rejects line breaks/NUL BEFORE anything is sent; every argument is single-quoted.
    const command = buildRemoteCommand(
      `${remoteDirFor(request.executionId)}/${this.options.scriptName ?? DEFAULT_SCRIPT_NAME}`,
      request.args,
    );
    this.execStarted = true;
    this.cleanupAllowed = false;
    const run = await runRemote(this.client, command, request.timeoutMs, () => this.lost);
    if (run.kind === "TIMEOUT" || run.kind === "SESSION_LOST") {
      this.options.logger?.warn("deploy script outcome unknown", { targetRef: this.targetRef, kind: run.kind });
      return { kind: run.kind };
    }
    this.cleanupAllowed = true;
    const cicdResult: CicdResult | undefined = parseCicdResult(run.stdout, run.stdoutTruncated);
    const logTail = scrub(run.tail, [this.secretValue]);
    this.options.logger?.info("deploy script finished", {
      targetRef: this.targetRef,
      exitCode: run.exitCode,
      cicdResultPresent: cicdResult !== undefined,
    });
    return {
      kind: "EXIT",
      exitCode: run.exitCode,
      ...(cicdResult === undefined ? {} : { cicdResult }),
      logTail,
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.cleanupAllowed && this.executionId !== undefined && !this.lost) {
        const dir = remoteDirFor(this.executionId);
        // Best effort: never masks the result of the deploy.
        await runRemote(
          this.client,
          `rm -rf -- ${shellQuote(dir)} ${shellQuote(`${dir}.result.json`)}`,
          CLEANUP_TIMEOUT_MS,
          () => this.lost,
        ).catch(() => undefined);
      }
    } catch {
      // ignored on purpose
    } finally {
      this.client.end();
    }
  }
}

// ---------------------------------------------------------------------------
// exec plumbing
// ---------------------------------------------------------------------------
type RemoteRun =
  | { kind: "EXIT"; exitCode: number; stdout: string; stdoutTruncated: boolean; tail: string }
  | { kind: "TIMEOUT" }
  | { kind: "SESSION_LOST" };

function appendTail(current: string, chunk: string, max: number): { value: string; truncated: boolean } {
  const joined = current + chunk;
  return joined.length > max ? { value: joined.slice(joined.length - max), truncated: true } : { value: joined, truncated: false };
}

function runRemote(client: Ssh2Client, command: string, timeoutMs: number, isLost: () => boolean): Promise<RemoteRun> {
  return new Promise<RemoteRun>((resolve) => {
    let settled = false;
    const finish = (result: RemoteRun): void => { // `timer` is initialised below, before any call
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener("close", onClientClose);
      resolve(result);
    };
    // The script ignores HUP and is NOT aborted on timeout: only the wait ends.
    const timer = setTimeout(() => finish({ kind: "TIMEOUT" }), Math.max(1, timeoutMs));
    const onClientClose = (): void => finish({ kind: "SESSION_LOST" });
    client.once("close", onClientClose);
    if (isLost()) return finish({ kind: "SESSION_LOST" });

    client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
      if (error !== undefined) return finish({ kind: "SESSION_LOST" });
      let stdout = "";
      let stdoutTruncated = false;
      let tail = "";
      let exitCode: number | undefined;
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => {
        const text = outDecoder.write(chunk);
        const o = appendTail(stdout, text, STDOUT_TAIL_CHARS);
        stdout = o.value;
        stdoutTruncated ||= o.truncated;
        tail = appendTail(tail, text, LOG_TAIL_CHARS).value;
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        tail = appendTail(tail, errDecoder.write(chunk), LOG_TAIL_CHARS).value;
      });
      stream.on("exit", (code: number | null | undefined) => {
        if (typeof code === "number") exitCode = code;
      });
      stream.on("error", () => finish({ kind: "SESSION_LOST" }));
      stream.on("close", () => {
        // No numeric exit status (killed by a signal, channel cut): the outcome is unknown, never guessed.
        if (exitCode === undefined) return finish({ kind: "SESSION_LOST" });
        finish({ kind: "EXIT", exitCode, stdout: stdout + outDecoder.end(), stdoutTruncated, tail });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// SFTP plumbing
// ---------------------------------------------------------------------------
function openSftp(client: Ssh2Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

/**
 * Creates the per-execution directory FRESH (mode 0700). A directory that
 * already exists is refused whatever its owner or mode: another local user
 * could have pre-created it and swap the script between the checksum and the
 * exec (FR-12 "the script executed is the one delivered"). The created
 * directory is then re-checked to be owner-only.
 */
async function sftpMkdirFresh(sftp: SFTPWrapper, dir: string): Promise<void> {
  const made = await new Promise<boolean>((resolve) => {
    sftp.mkdir(dir, { mode: 0o700 }, (error) => resolve(error === undefined || error === null));
  });
  if (!made) throw new Error("remote work directory already exists or cannot be created");
  await new Promise<void>((resolve, reject) => {
    sftp.lstat(dir, (error, stats) => {
      if (error || !stats.isDirectory() || (stats.mode & 0o077) !== 0) reject(new Error("remote work directory is not private"));
      else resolve();
    });
  });
}

function sftpUpload(sftp: SFTPWrapper, file: string, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // Exclusive create (`wx`): never writes through a pre-existing file or link.
    sftp.open(file, "wx", { mode: 0o500 }, (openError, handle) => {
      if (openError) return reject(openError);
      const writeFrom = (position: number): void => {
        if (position >= bytes.length) {
          return sftp.close(handle, (closeError) => (closeError ? reject(closeError) : resolve()));
        }
        const chunk = bytes.subarray(position, position + SFTP_CHUNK);
        sftp.write(handle, chunk, 0, chunk.length, position, (writeError) => {
          if (writeError) return reject(writeError);
          writeFrom(position + chunk.length);
        });
      };
      writeFrom(0);
    });
  });
}

/** Reads the file back (at most `expectedLength + 1` bytes) and returns its sha256 hex. */
function sftpSha256(sftp: SFTPWrapper, file: string, expectedLength: number): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.open(file, "r", (openError, handle) => {
      if (openError) return reject(openError);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(SFTP_CHUNK);
      const finishWith = (fn: () => void): void => {
        sftp.close(handle, () => fn());
      };
      const readAt = (position: number): void => {
        if (position > expectedLength) {
          return finishWith(() => resolve(`oversize:${position}`)); // longer than delivered: cannot match
        }
        sftp.read(handle, buffer, 0, buffer.length, position, (readError, bytesRead) => {
          if (readError) return finishWith(() => reject(readError));
          if (bytesRead === 0) return finishWith(() => resolve(hash.digest("hex")));
          hash.update(buffer.subarray(0, bytesRead));
          readAt(position + bytesRead);
        });
      };
      readAt(0);
    });
  });
}

// ---------------------------------------------------------------------------
// misc

/** Redacts known secret patterns and the literal credential value from text that may be logged or persisted. */
function scrub(text: string, literals: readonly string[]): string {
  let out = text;
  for (const literal of literals) {
    if (literal.length >= 4) out = out.split(literal).join("[REDACTED]");
  }
  return redactString(out);
}
