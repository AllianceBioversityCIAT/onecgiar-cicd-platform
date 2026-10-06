// @akili-spec changes/cicd-executor-poc design §6.5, §7.5, DD-04, DD-05, DD-10, DD-28
// Port: the SSH call abstraction of the deploy coordinator (replaces the
// closed step-handler registry, DD-05). It only connects, delivers the
// bundled script (SFTP) and runs it with ARGUMENTS (never a concatenated
// command string, design §7 Forbidden). N-13 implements it with `ssh2`; the
// coordinator is tested with a fake. No SSH library types leak through here.

/** `CICD_RESULT` JSON of the script's last stdout line (design §6.5), present on exits 0/10/20/30/40/50. */
export interface CicdResult {
  readonly status: string;
  readonly deployedImages?: Readonly<Record<string, string>>;
  /** Opaque strings: may carry the script's `unresolved:sha256:<id>` marker. */
  readonly previousImages?: Readonly<Record<string, string>>;
  readonly migrations?: "APPLIED" | "NONE" | "FAILED";
  readonly healthy?: boolean;
  readonly mutexHolder?: string;
}

export interface ScriptExecRequest {
  readonly executionId: string;
  /** Script arguments, one element per argument (design §6.5). Never joined into a shell string. */
  readonly args: readonly string[];
  /** The script's own deadline (definition `timeoutMinutes`). */
  readonly timeoutMs: number;
}

export type ScriptExecOutcome =
  /** The script ran to an exit code; `cicdResult` is the parsed last stdout line when present. */
  | { readonly kind: "EXIT"; readonly exitCode: number; readonly cicdResult?: CicdResult; readonly logTail?: string }
  /** The session dropped while the script may still be running. */
  | { readonly kind: "SESSION_LOST" }
  /** `timeoutMs` elapsed with the script still running (the script ignores HUP and is NOT aborted). */
  | { readonly kind: "TIMEOUT" };

/** Failure before the script started: connection or host-key verification (design §7.2). */
export class DeployTransportError extends Error {
  public constructor(
    public readonly code: "SSH_CONNECT" | "HOST_KEY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "DeployTransportError";
  }
}

export interface DeploySession {
  /** SFTP-delivers the bundled script for `executionId` (DD-10). Throws `DeployTransportError` on failure. */
  deliverScript(executionId: string): Promise<void>;
  /** Runs the delivered script once. Must never re-run it; a lost session is reported, not retried (DD-28). */
  exec(request: ScriptExecRequest): Promise<ScriptExecOutcome>;
  /** Idempotent. Closing the session does not stop a running script (it ignores HUP). */
  close(): Promise<void>;
}

export interface DeployTransport {
  /** Opens a session to the target named by a logical reference. Throws `DeployTransportError` on failure. */
  connect(targetRef: string): Promise<DeploySession>;
}
