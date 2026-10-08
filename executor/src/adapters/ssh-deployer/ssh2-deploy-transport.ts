// @akili-spec changes/cicd-executor-poc design §5.1, §6.3, §6.5, §7.2, §7.5, DD-22, DD-23, DD-28; requirements FR-12, FR-13; tasks R-5 (AC-02 V1)
//
// `DeployTransport` over `ssh2`. The adapter only connects to the target named
// by the execution's snapshot and runs the deploy script INSTALLED ON THE
// TARGET at the snapshot's `deployScript` path, with quoted ARGUMENTS; it
// never looks inside the script, never decides what the arguments mean and
// carries no per-project logic (NFR-01). AC-02 V1: nothing is uploaded (no
// SFTP, no checksum, no remote temporary directory, no remote cleanup); the
// script's integrity is the target's responsibility (V1-R3).
//
// Security properties (each covered by a test against a REAL ssh2 server):
//  - Host key pinning: `hostVerifier` compares the presented key with the key
//    lines of the snapshot. Anything else aborts the handshake before
//    authentication, so no credential is ever sent to an unverified host; the
//    failure is HOST_KEY_MISMATCH and is never retried. No usable pinned key:
//    fail closed before connecting.
//  - Credential read through `SecretProvider` (the snapshot's `credentialRef`)
//    at the point of use, per connect attempt, kept only in a local variable
//    and in the ssh2 config; never logged, never written to disk. Private key
//    only: the V1 target record has no temporary-password marker (FR-12).
//  - Script path: refused unless absolute, without `.`/`..` segments, trailing
//    slash, whitespace or shell metacharacters (defense in depth behind the
//    record schema); every element of the command line is single-quoted.
//  - Retries: none here (one attempt per connect(); the coordinator owns the §7.2 loop).
//    Nothing is ever retried after exec starts; a lost session is reported, not re-run (DD-28).
//  - Errors never carry raw ssh2 text (it can contain host, IP or port: DD-23); messages are generic.
import { StringDecoder } from "node:string_decoder";
import type { Client as Ssh2Client, ClientChannel } from "ssh2";
import {
  DeployTransportError,
  type CicdResult,
  type DeploySession,
  type DeployTransport,
  type ScriptExecOutcome,
  type ScriptExecRequest,
  type SshTarget,
} from "../../ports/deploy-transport.js";
import type { SecretProvider } from "../../ports/secret-provider.js";
import { redactString } from "../../observability/logger/redaction.js";
import { parseCicdResult } from "./cicd-result.js";
import { hostKeyFingerprint, matchesPinnedHostKey, parsePinnedHostKeys } from "./host-key.js";
import { assertSafeScriptPath, buildRemoteCommand } from "./shell-quote.js";
import { Client } from "./ssh2-module.js";

export interface DeployTransportLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface Ssh2DeployTransportOptions {
  readonly secrets: SecretProvider;
  readonly logger?: DeployTransportLogger;
  readonly readyTimeoutMs?: number;
}

const LOG_TAIL_CHARS = 16 * 1024;
const STDOUT_TAIL_CHARS = 64 * 1024;
const DEFAULT_SSH_PORT = 22;

export class Ssh2DeployTransport implements DeployTransport {
  public constructor(private readonly options: Ssh2DeployTransportOptions) {}

  /**
   * ONE attempt per call. The "2 retries before exec" policy (design §7.2) is
   * owned by the deploy coordinator; retrying here too would multiply attempts.
   */
  public async connect(target: SshTarget): Promise<DeploySession> {
    const { secrets } = this.options;
    // The snapshot's lines joined back into the form the parser reads (one OpenSSH public-key line each).
    const pinned = parsePinnedHostKeys(target.hostKey.join("\n"));
    // Fail closed: without a usable pinned key nothing can be verified, so nothing is connected and no credential is read.
    if (pinned.length === 0) {
      throw new DeployTransportError("HOST_KEY_MISMATCH", "no usable pinned host key for the target");
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
    let privateKey: string;
    try {
      privateKey = await secrets.getSecret(target.credentialRef);
    } catch {
      throw new DeployTransportError("SSH_CONNECT", "cannot read the SSH credential");
    }

    const client = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("ready", () => resolve());
        client.once("error", (error: Error) => reject(error));
        client.once("close", () => reject(new Error("connection closed before ready")));
        try {
          client.connect({
            host: target.host,
            port: target.port ?? DEFAULT_SSH_PORT,
            username: target.user,
            privateKey,
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
          targetId: target.targetId,
          presentedFingerprint,
        });
        throw new DeployTransportError("HOST_KEY_MISMATCH", "presented host key does not match the pinned host key");
      }
      throw new DeployTransportError("SSH_CONNECT", "SSH connection failed");
    }

    // Post-ready errors (keepalive timeout, reset) are surfaced through the exec outcome; never crash the process.
    client.on("error", () => undefined);
    return new Ssh2DeploySession(client, target.targetId, this.options, privateKey);
  }
}

class Ssh2DeploySession implements DeploySession {
  private execStarted = false;
  private closed = false;
  private lost = false;

  public constructor(
    private readonly client: Ssh2Client,
    private readonly targetId: string,
    private readonly options: Ssh2DeployTransportOptions,
    private readonly secretValue: string,
  ) {
    client.once("close", () => {
      this.lost = true;
    });
  }

  public async exec(request: ScriptExecRequest): Promise<ScriptExecOutcome> {
    if (this.execStarted) throw new Error("the deploy script is never run twice on a session");
    // Refuses an unsafe path, line breaks or NUL BEFORE anything is sent; every element is single-quoted.
    assertSafeScriptPath(request.scriptPath);
    const command = buildRemoteCommand(request.scriptPath, request.args);
    this.execStarted = true;
    const run = await runRemote(this.client, command, request.timeoutMs, () => this.lost);
    if (run.kind === "TIMEOUT" || run.kind === "SESSION_LOST") {
      this.options.logger?.warn("deploy script outcome unknown", { targetId: this.targetId, executionId: request.executionId, kind: run.kind });
      return { kind: run.kind };
    }
    const cicdResult: CicdResult | undefined = parseCicdResult(run.stdout, run.stdoutTruncated);
    const logTail = scrub(run.tail, [this.secretValue]);
    this.options.logger?.info("deploy script finished", {
      targetId: this.targetId,
      executionId: request.executionId,
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

  /** Idempotent. Nothing was delivered, so nothing is removed on the target. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.end();
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
// misc

/** Redacts known secret patterns and the literal credential value from text that may be logged or persisted. */
function scrub(text: string, literals: readonly string[]): string {
  let out = text;
  for (const literal of literals) {
    if (literal.length >= 4) out = out.split(literal).join("[REDACTED]");
  }
  return redactString(out);
}
