// @akili-spec changes/cicd-executor-poc gate-b-plan K-7 (D-5), design §6.5, §7.5, DD-10, DD-22, DD-23
//
// OWNER-RUN tool. Exercises the Executor's REAL SSH adapter (host-key pinning,
// fresh 0700 SFTP delivery, read-back sha256, quoted exec, CICD_RESULT parsing)
// against one target, using the read-only `target-probe.sh`. It is not a
// deployment: it is outside the `deployScript` allowlist, never reads
// definitions, and the adapter is reused unmodified.
//
// Usage (after `npm run build` in executor/):
//   tools/gate-b/probe/executor-ssh-probe --connection-ref '<REF>' --host-key-ref '<REF>' \
//     --credential-ref '<REF>' --secret-id-prefix <PREFIX> --region <REGION> [--dry-run]
//
// Exit codes: 0 probe OK, 1 probe failed (connection, host key, delivery, script), 2 usage error.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = "target-probe.sh";
const LOGICAL_REF = /^<[A-Z][A-Z0-9_]*>$/;
const DEFAULT_TIMEOUT_SECONDS = 60;
// Same character set as the Secrets Manager provider (secretIdPrefixProblem in the Executor).
const SECRET_ID_PREFIX = /^[A-Za-z0-9/_+=.@-]*$/;
const TARGET_REF = "probe-target";

export const USAGE = `Usage: executor-ssh-probe --connection-ref <REF> --host-key-ref <REF> --credential-ref <REF>
         [--secret-id-prefix <PREFIX>] [--region <REGION>] [--timeout-seconds <N>] [--dry-run]

  <REF> is a logical reference such as '<NAME>' (quote it in the shell).
  --secret-id-prefix defaults to $CICD_SECRET_ID_PREFIX; --region defaults to $AWS_REGION / $AWS_DEFAULT_REGION.
  --dry-run prints the plan and the probe script sha256 and makes no AWS or SSH call.
`;

class UsageError extends Error {}

const REF_FLAGS = new Map([
  ["--connection-ref", "connectionRef"],
  ["--host-key-ref", "hostKeyRef"],
  ["--credential-ref", "credentialRef"],
]);

/** Pure argument parsing. Throws UsageError on any problem. */
export function parseArgs(argv, env = {}) {
  const options = {
    dryRun: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    secretIdPrefix: env.CICD_SECRET_ID_PREFIX,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const takesValue = REF_FLAGS.has(flag) || ["--secret-id-prefix", "--region", "--timeout-seconds"].includes(flag);
    if (!takesValue) throw new UsageError(`unknown argument: ${String(flag)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    i += 1;
    if (REF_FLAGS.has(flag)) {
      if (!LOGICAL_REF.test(value)) throw new UsageError(`${flag} must be a logical reference like <NAME>`);
      options[REF_FLAGS.get(flag)] = value;
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
  for (const [flag, key] of REF_FLAGS) {
    if (options[key] === undefined) throw new UsageError(`${flag} is required`);
  }
  return options;
}

/** Loads the Executor's built modules (`npm run build` in executor/). */
export async function loadExecutor() {
  const dist = path.join(here, "..", "..", "..", "executor", "dist", "src");
  const load = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
  try {
    const [ssh, sm, redaction] = await Promise.all([
      load("adapters/ssh-deployer/index.js"),
      load("adapters/secrets-manager-provider/index.js"),
      load("observability/logger/redaction.js"),
    ]);
    return {
      Ssh2DeployTransport: ssh.Ssh2DeployTransport,
      SecretsManagerSecretProvider: sm.SecretsManagerSecretProvider,
      createSecretsManagerClient: sm.createSecretsManagerClient,
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
 *  - scriptPath: path of the probe script
 * Returns the process exit code.
 */
export async function runProbe(argv, deps = {}) {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const scriptPath = deps.scriptPath ?? path.join(here, SCRIPT_NAME);

  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err.write(`error: ${error.message}\n${USAGE}`);
    return 2;
  }

  const scriptText = (await readFile(scriptPath, "utf8")).replace(/\r\n/g, "\n");
  const scriptSha256 = sha256Hex(scriptText);

  if (options.dryRun) {
    out.write(
      [
        "executor-ssh-probe dry run (no AWS call, no SSH connection)",
        `  connectionRef: ${options.connectionRef}`,
        `  hostKeyRef:    ${options.hostKeyRef}`,
        `  credentialRef: ${options.credentialRef}`,
        `  secretIdPrefix: ${options.secretIdPrefix === undefined ? "(unset)" : "(set)"}`,
        `  region:         ${options.region === undefined ? "(unset)" : "(set)"}`,
        `  script: ${SCRIPT_NAME} sha256=${scriptSha256}`,
        "  plan: resolve refs -> pin host key -> deliver to a fresh 0700 dir -> verify read-back sha256 -> run with no arguments -> parse CICD_RESULT -> clean up",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (options.secretIdPrefix === undefined || options.region === undefined) {
    err.write(`error: a secret id prefix and a region are required (flags or environment)\n${USAGE}`);
    return 2;
  }

  const executor = await (deps.loadExecutor ?? loadExecutor)();
  const secrets =
    deps.createSecrets !== undefined
      ? deps.createSecrets({ secretIdPrefix: options.secretIdPrefix, region: options.region, executor })
      : new executor.SecretsManagerSecretProvider({
          client: executor.createSecretsManagerClient(options.region),
          secretIdPrefix: options.secretIdPrefix,
        });

  // The ONLY definition this tool serves: the probe script bytes. Everything else is refused.
  const refuse = async () => {
    throw new Error("the probe serves no definitions");
  };
  const definitions = {
    getDeployScript: async (name) => {
      if (name !== SCRIPT_NAME) throw new Error("unexpected script request");
      return { content: scriptText, definitionRef: "gate-b-probe" };
    },
    getDeploymentDefinition: refuse,
    getTargetRegistry: refuse,
    getSchema: refuse,
  };
  const targets = {
    resolve: async () => ({
      connectionRef: options.connectionRef,
      hostKeyRef: options.hostKeyRef,
      credentialRef: options.credentialRef,
    }),
  };
  const transport = new executor.Ssh2DeployTransport({
    secrets,
    definitions,
    targets,
    scriptName: SCRIPT_NAME,
    logger: { info: () => undefined, warn: () => undefined },
  });

  const redact = executor.redactString ?? ((text) => text);
  const executionId = `probe-${randomBytes(6).toString("hex")}`;
  let session;
  try {
    session = await transport.connect(TARGET_REF);
    out.write("host key verified against the pinned key\n");
    await session.deliverScript(executionId);
    out.write(`probe script delivered to a fresh 0700 directory; read-back sha256 verified (${scriptSha256})\n`);
    const outcome = await session.exec({ executionId, args: [], timeoutMs: options.timeoutSeconds * 1000 });
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
