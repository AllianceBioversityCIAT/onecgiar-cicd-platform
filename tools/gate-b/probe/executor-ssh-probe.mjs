// @akili-spec changes/cicd-executor-poc gate-b-plan K-7 (D-5), design §6.3, §6.5, §7.5, DD-22, DD-23; tasks R-5 (AC-02 V1, owner decision 2026-10-07: B4 probe option A)
//
// OWNER-RUN tool (Gate B, B4). Exercises the Executor's REAL V1 SSH adapter against one
// target of the Target Registry: it reads the target record with one GetItem (R-3
// adapter, validated with schemas/target-record.schema.json), pins the record's host key,
// reads the SSH credential through `credentialRef` at connect time, runs ONLY the
// read-only diagnostic script that the owner installed on the target, with no
// arguments, and parses `CICD_RESULT`. Nothing is uploaded (V1: no SFTP, no checksum).
//
// B4-only restriction on `--probe-script` (owner decision 2026-10-07; a property of this
// tool, not an Executor capability): an absolute path with the same safe character
// rules as a `deployScript`, whose file name is exactly `target-probe.sh`, and which is
// never the target's `deployScript`. There is no flag for a free-form command.
//
// Usage (after `npm run build` in executor/):
//   tools/gate-b/probe/executor-ssh-probe --target-id <TARGET_ID> --probe-script <ABSOLUTE_PATH>/target-probe.sh \
//     [--registry-table <TABLE>] [--secret-id-prefix <PREFIX>] [--region <REGION>] [--timeout-seconds <N>] [--dry-run]
//
// Exit codes: 0 probe OK, 1 probe failed (target record, host key, connection, script), 2 usage error.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_FILE_NAME = "target-probe.sh";
const DEFAULT_TIMEOUT_SECONDS = 60;
const TARGET_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Same rules as the record's `deployScript` (schemas/target-record.schema.json) and the transport's path guard.
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]{1,255}$/;
// Also rejects empty segments ("//"), so the deployScript comparison below cannot be bypassed by an equivalent spelling.
const FORBIDDEN_SEGMENTS = /(^|\/)\.{1,2}(\/|$)|\/$|\/\//;
// Same character set as the Secrets Manager provider (secretIdPrefixProblem in the Executor).
const SECRET_ID_PREFIX = /^[A-Za-z0-9/_+=.@-]*$/;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

export const USAGE = `Usage: executor-ssh-probe --target-id <TARGET_ID> --probe-script <ABSOLUTE_PATH>/target-probe.sh
         [--registry-table <TABLE>] [--secret-id-prefix <PREFIX>] [--region <REGION>] [--timeout-seconds <N>] [--dry-run]

  --probe-script is the read-only diagnostic script YOU installed on the target; its file name must be
  target-probe.sh and it must not be the target's deployScript. Nothing is uploaded.
  --registry-table defaults to $CICD_REGISTRY_TABLE_NAME; --secret-id-prefix to $CICD_SECRET_ID_PREFIX;
  --region to $AWS_REGION / $AWS_DEFAULT_REGION.
  --dry-run prints the plan and the sha256 of the repository's reference target-probe.sh (compare it with
  sha256sum of the installed file) and makes no AWS or SSH call.
`;

class UsageError extends Error {}

/** B4-only rule for the diagnostic script path (see the header). Throws UsageError. */
function checkProbeScript(value) {
  if (!SAFE_ABSOLUTE_PATH.test(value) || FORBIDDEN_SEGMENTS.test(value)) {
    throw new UsageError("--probe-script must be a safe absolute path (letters, digits, . _ / - only; no . or .. or empty segment)");
  }
  if (path.posix.basename(value) !== PROBE_FILE_NAME) {
    throw new UsageError(`--probe-script must name a file called ${PROBE_FILE_NAME}`);
  }
}

/** Pure argument parsing. Throws UsageError on any problem. */
export function parseArgs(argv, env = {}) {
  const options = {
    dryRun: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    secretIdPrefix: env.CICD_SECRET_ID_PREFIX,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
    registryTable: env.CICD_REGISTRY_TABLE_NAME,
  };
  const valued = ["--target-id", "--probe-script", "--registry-table", "--secret-id-prefix", "--region", "--timeout-seconds"];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!valued.includes(flag)) throw new UsageError(`unknown argument: ${String(flag)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    i += 1;
    if (flag === "--target-id") {
      if (!TARGET_ID.test(value)) throw new UsageError("--target-id must match ^[a-z0-9][a-z0-9-]{1,62}$");
      options.targetId = value;
    } else if (flag === "--probe-script") {
      checkProbeScript(value);
      options.probeScript = value;
    } else if (flag === "--registry-table") {
      options.registryTable = value;
    } else if (flag === "--secret-id-prefix") {
      options.secretIdPrefix = value;
    } else if (flag === "--region") {
      options.region = value;
    } else {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new UsageError("--timeout-seconds must be an integer 1..600");
      options.timeoutSeconds = seconds;
    }
  }
  if (options.secretIdPrefix !== undefined && !SECRET_ID_PREFIX.test(options.secretIdPrefix)) {
    throw new UsageError("secret id prefix must contain only letters, digits and /_+=.@-");
  }
  if (options.registryTable !== undefined && !TABLE_NAME.test(options.registryTable)) {
    throw new UsageError("registry table name must contain only letters, digits and _.-");
  }
  if (options.targetId === undefined) throw new UsageError("--target-id is required");
  if (options.probeScript === undefined) throw new UsageError("--probe-script is required");
  return options;
}

/** Loads the Executor's built modules (`npm run build` in executor/). */
export async function loadExecutor() {
  const dist = path.join(here, "..", "..", "..", "executor", "dist", "src");
  const load = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
  try {
    const [ssh, sm, registry, store, redaction] = await Promise.all([
      load("adapters/ssh-deployer/index.js"),
      load("adapters/secrets-manager-provider/index.js"),
      load("adapters/dynamodb-target-registry/index.js"),
      load("adapters/dynamodb-state-store/client.js"),
      load("observability/logger/redaction.js"),
    ]);
    return {
      Ssh2DeployTransport: ssh.Ssh2DeployTransport,
      SecretsManagerSecretProvider: sm.SecretsManagerSecretProvider,
      createSecretsManagerClient: sm.createSecretsManagerClient,
      DynamoDbTargetRegistry: registry.DynamoDbTargetRegistry,
      createDocumentClient: store.createDocumentClient,
      redactString: redaction.redactString,
    };
  } catch {
    throw new Error("cannot load the Executor build; run `npm run build` in executor/ first");
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Runs the probe. `deps` (all optional, injectable for tests):
 *  - stdout / stderr: `{ write(text) }` sinks
 *  - env: process-like environment
 *  - loadExecutor(): resolves the adapter classes
 *  - createSecrets({ secretIdPrefix, region, executor }): SecretProvider factory
 *  - createRegistry({ registryTable, region, executor }): TargetRegistry factory
 *  - referenceScriptPath: the repository's reference target-probe.sh (for the dry-run sha256)
 * Returns the process exit code.
 */
export async function runProbe(argv, deps = {}) {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const referenceScriptPath = deps.referenceScriptPath ?? path.join(here, PROBE_FILE_NAME);

  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err.write(`error: ${error.message}\n${USAGE}`);
    return 2;
  }

  if (options.dryRun) {
    const referenceSha256 = sha256Hex((await readFile(referenceScriptPath, "utf8")).replace(/\r\n/g, "\n"));
    out.write(
      [
        "executor-ssh-probe dry run (no AWS call, no SSH connection)",
        `  targetId:       ${options.targetId}`,
        `  probe script:   ${options.probeScript}`,
        `  registry table: ${options.registryTable === undefined ? "(unset)" : "(set)"}`,
        `  secretIdPrefix: ${options.secretIdPrefix === undefined ? "(unset)" : "(set)"}`,
        `  region:         ${options.region === undefined ? "(unset)" : "(set)"}`,
        `  reference ${PROBE_FILE_NAME} sha256=${referenceSha256} (compare with sha256sum of the installed file)`,
        "  plan: GetItem the target record -> validate it -> refuse its deployScript -> pin its host key -> read the credential at connect ->",
        "        run the installed probe script with no arguments -> parse CICD_RESULT (nothing is uploaded)",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (options.secretIdPrefix === undefined || options.region === undefined || options.registryTable === undefined) {
    err.write(`error: a secret id prefix, a region and a registry table are required (flags or environment)\n${USAGE}`);
    return 2;
  }

  const executor = await (deps.loadExecutor ?? loadExecutor)();
  const redact = executor.redactString ?? ((text) => text);

  const registry =
    deps.createRegistry !== undefined
      ? deps.createRegistry({ registryTable: options.registryTable, region: options.region, executor })
      : new executor.DynamoDbTargetRegistry({
          client: executor.createDocumentClient({ tableName: options.registryTable, region: options.region }),
          tableName: options.registryTable,
          schema: JSON.parse(await readFile(path.join(here, "..", "..", "..", "schemas", "target-record.schema.json"), "utf8")),
        });

  let lookup;
  try {
    lookup = await registry.getTarget(options.targetId);
  } catch (error) {
    err.write(`probe FAILED: REGISTRY_READ_FAILED${typeof error?.name === "string" ? ` (${error.name})` : ""}\n`);
    return 1;
  }
  if (lookup.kind === "missing") {
    err.write("probe FAILED: TARGET_UNKNOWN\n");
    return 1;
  }
  if (lookup.kind === "invalid") {
    // Rule and path only, never a stored value (R-3 adapter contract).
    err.write(`probe FAILED: TARGET_INVALID (${lookup.problems.join("; ")})\n`);
    return 1;
  }
  const target = lookup.target;
  if (target.deployScript === options.probeScript) {
    err.write("probe FAILED: the probe script must not be the target's deployScript\n");
    return 1;
  }
  out.write("target record read and validated\n");

  const secrets =
    deps.createSecrets !== undefined
      ? deps.createSecrets({ secretIdPrefix: options.secretIdPrefix, region: options.region, executor })
      : new executor.SecretsManagerSecretProvider({
          client: executor.createSecretsManagerClient(options.region),
          secretIdPrefix: options.secretIdPrefix,
        });
  const transport = new executor.Ssh2DeployTransport({ secrets, logger: { info: () => undefined, warn: () => undefined } });

  const executionId = `probe-${randomBytes(6).toString("hex")}`;
  let session;
  try {
    session = await transport.connect({
      targetId: target.targetId,
      host: target.host,
      ...(target.port === undefined ? {} : { port: target.port }),
      user: target.user,
      hostKey: target.hostKey,
      credentialRef: target.credentialRef,
    });
    out.write("host key verified against the pinned key\n");
    const outcome = await session.exec({ executionId, scriptPath: options.probeScript, args: [], timeoutMs: options.timeoutSeconds * 1000 });
    if (outcome.kind !== "EXIT") {
      err.write(`probe FAILED: outcome ${outcome.kind}\n`);
      return 1;
    }
    const probeLines = (outcome.logTail ?? "")
      .split("\n")
      .filter((line) => line.startsWith("probe."))
      .map((line) => `  ${redact(line)}`);
    out.write(`${probeLines.join("\n")}${probeLines.length > 0 ? "\n" : ""}`);
    const status = outcome.cicdResult?.status;
    out.write(`exit code: ${outcome.exitCode}\nCICD_RESULT parsed: ${status === undefined ? "no" : `yes (status ${status})`}\n`);
    const ok = outcome.exitCode === 0 && status === "PROBE_OK";
    out.write(ok ? "probe OK\n" : "probe FAILED\n");
    return ok ? 0 : 1;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "ERROR";
    // Adapter messages are already generic (no host, IP or port); the raw error is never printed.
    err.write(`probe FAILED: ${code}${error?.name === "DeployTransportError" ? `: ${redact(String(error.message))}` : ""}\n`);
    return 1;
  } finally {
    if (session !== undefined) await session.close().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProbe(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`probe FAILED: ${error instanceof Error ? error.message : "unexpected error"}\n`);
      process.exitCode = 1;
    },
  );
}
