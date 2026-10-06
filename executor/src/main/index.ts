// @akili-spec changes/cicd-executor-poc design §4.2, §7, §12
// Process entry point (Dockerfile: `node dist/src/main/index.js`). Composition
// itself lives in `./bootstrap.ts` (testable without starting a process); this
// file only adds process concerns: the SecretProvider adapter, signal handling
// and the exit code. Shutdown order on SIGTERM/SIGINT: stop the consumer, wait
// for in-flight work, flush logs (design §12; NFR-04).
import { ConfigError } from "../composition/config.js";
import type { SecretProvider } from "../ports/secret-provider.js";
import { bootstrap } from "./bootstrap.js";

/**
 * The `SecretProvider` over Secrets Manager (`adapters/secrets-manager-provider`) is still a skeleton and the
 * `@aws-sdk/client-secrets-manager` dependency is not in the package yet, so the process cannot resolve the
 * Executor's own operational references. Failing here is deliberate: wiring a guess would hide the gap.
 */
function createRuntimeSecretProvider(): SecretProvider {
  throw new Error(
    "no SecretProvider adapter is wired: adapters/secrets-manager-provider is not implemented yet (escalated; needs the Secrets Manager SDK dependency and OD-Q12 credentials decision)",
  );
}

async function run(): Promise<number> {
  let executor;
  try {
    executor = await bootstrap({ env: process.env, secrets: createRuntimeSecretProvider() });
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
