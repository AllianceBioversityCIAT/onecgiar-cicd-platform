// @akili-spec changes/cicd-executor-poc design §4.2, §7, §12
// Process entry point (Dockerfile: `node dist/src/main/index.js`). Composition
// itself lives in `./bootstrap.ts` (testable without starting a process); this
// file only adds process concerns: the SecretProvider adapter, signal handling
// and the exit code. Shutdown order on SIGTERM/SIGINT: stop the consumer, wait
// for in-flight work, flush logs (design §12; NFR-04).
import { createSecretsManagerClient, SecretsManagerSecretProvider } from "../adapters/secrets-manager-provider/index.js";
import { ConfigError, loadConfig } from "../composition/config.js";
import type { SecretProvider } from "../ports/secret-provider.js";
import { bootstrap } from "./bootstrap.js";

/**
 * The Executor's own operational secrets come from Secrets Manager through the SDK default credential chain
 * (DD-16). Region and the optional id prefix are validated by `loadConfig`, so an invalid value is a ConfigError
 * and the process refuses to start.
 */
function createRuntimeSecretProvider(env: NodeJS.ProcessEnv): SecretProvider {
  const config = loadConfig(env);
  return new SecretsManagerSecretProvider({ client: createSecretsManagerClient(config.region), secretIdPrefix: config.secretIdPrefix });
}

async function run(): Promise<number> {
  let executor;
  try {
    executor = await bootstrap({ env: process.env, secrets: createRuntimeSecretProvider(process.env) });
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
    process.stderr.write(`executor refused to start: ${message}\n`);
    return 1;
  }
  const shutdown = (): void => {
    void executor.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await executor.start();
  } catch (error) {
    // Non-sensitive: the message only (redaction-safe), never the error object with its context.
    process.stderr.write(`executor failed to start: ${error instanceof Error ? error.message : "unknown error"}
`);
    await executor.stop().catch(() => undefined);
    return 1;
  }
  return -1; // keep running until a signal arrives
}

const code = await run();
if (code >= 0) process.exitCode = code;
