// @akili-spec changes/cicd-executor-poc design §6.3, §6.5, §7.5, DD-04, DD-05, DD-28; requirements FR-12, FR-13; tasks R-5 (AC-02 V1)
// Port: the SSH call abstraction of the deploy coordinator (replaces the
// closed step-handler registry, DD-05). It only connects to the target named
// by the execution's snapshot and runs the deploy script INSTALLED ON THE
// TARGET at the snapshot's `deployScript` path, with ARGUMENTS (never a
// concatenated command string, design §7 Forbidden). AC-02 V1: nothing is
// delivered to the target (no SFTP upload, no checksum, DD-10 removed). The
// `ssh2` adapter implements it; the coordinator is tested with a fake. No SSH
// library types leak through here.

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

/** Where to connect, from the execution's target snapshot (design §5.1, §6.3). Non-secret values plus a credential REFERENCE. */
export interface SshTarget {
  readonly targetId: string;
  readonly host: string;
  /** SSH port; absent means 22. */
  readonly port?: number;
  readonly user: string;
  /** Pinned host key: one or more OpenSSH public-key lines (strict, never `StrictHostKeyChecking=no`). */
  readonly hostKey: readonly string[];
  /** Secrets Manager reference of the SSH credential; the transport reads it at connect time and keeps it in memory only. */
  readonly credentialRef: string;
}

export interface ScriptExecRequest {
  readonly executionId: string;
  /** Absolute path of the deploy script installed on the target (the snapshot's `deployScript`). */
  readonly scriptPath: string;
  /** Script arguments, one element per argument (design §6.5). Never joined into a shell string. */
  readonly args: readonly string[];
  /** The script's own deadline (platform `deployTimeoutMinutes`). */
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
  /** Runs the target's script once. Must never re-run it; a lost session is reported, not retried (DD-28). */
  exec(request: ScriptExecRequest): Promise<ScriptExecOutcome>;
  /** Idempotent. Closing the session does not stop a running script (it ignores HUP). */
  close(): Promise<void>;
}

export interface DeployTransport {
  /** Opens a session to the snapshot's target. Throws `DeployTransportError` on failure. */
  connect(target: SshTarget): Promise<DeploySession>;
}
