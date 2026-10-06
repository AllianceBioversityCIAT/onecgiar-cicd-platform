// @akili-spec changes/cicd-executor-poc design DD-03 (T-08)
// Orchestrator behind `npm run test:integration`. Starts DynamoDB Local (no
// Docker, Java 17 + the on-demand jar in `.local/`), points the test suite at
// it, runs `vitest run test/integration`, then tears the server down.
//
// If DynamoDB Local cannot be started (no Java, no network to fetch the jar,
// a port that refuses to come up, ...), this prints a clearly labeled SKIP
// line and exits 0 WITHOUT ever invoking vitest — it never falls back to a
// hand-written fake store (that would defeat the point: these tests exist to
// prove real DynamoDB conditional-write semantics, not an in-memory guess at
// them) and it never just swallows the failure silently.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePort, startDynamoDbLocal } from "../support/dynamodb-local.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXECUTOR_ROOT = join(__dirname, "..", "..");
const VITEST_CLI = join(EXECUTOR_ROOT, "node_modules", "vitest", "vitest.mjs");
// Hard ceiling so a stuck child (e.g. a shell/registry hang) can never leave
// this gate hanging forever — it is a FAILURE (non-zero), never a silent
// pass, and DynamoDB Local is always stopped on the way out either way.
const VITEST_TIMEOUT_MS = 5 * 60 * 1000;

async function main() {
  let dynamoInstance;
  try {
    const port = await findFreePort();
    dynamoInstance = await startDynamoDbLocal(port);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log("================================================================");
    console.log("SKIPPED: DynamoDB Local could not be started — integration tests");
    console.log("were NOT run (not a pass, not a fail: skipped).");
    console.log(`Reason: ${reason}`);
    console.log("================================================================");
    process.exitCode = 0;
    return;
  }

  console.log(`[test:integration] DynamoDB Local up on http://127.0.0.1:${String(dynamoInstance.port)}`);

  const env = {
    ...process.env,
    DYNAMODB_LOCAL_ENDPOINT: `http://127.0.0.1:${String(dynamoInstance.port)}`,
    DYNAMODB_TEST_TABLE: "cicd-executor-test",
    // Well-known, publicly-documented AWS SDK EXAMPLE credentials (used
    // throughout AWS's own docs) — obviously fake, never a real secret
    // (publication policy, CLAUDE.md §4.1). DynamoDB Local never checks
    // whether a credential is REAL, but it does reject one that is not even
    // shaped like an access key, which a free-form string like
    // "local-fake-access-key-id" is not.
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    AWS_REGION: "us-east-1",
  };

  try {
    const vitestExitCode = await new Promise((resolve) => {
      // Invoke vitest's own CLI entry directly with THIS node binary — no
      // `npx` and no shell. `npx` on Windows needs the `.cmd` shim resolved
      // through a nested shell, which is slow and, during this task's own
      // development, hung indefinitely; calling the local package's CLI
      // module straight from `process.execPath` sidesteps all of that.
      const child = spawn(process.execPath, [VITEST_CLI, "run", "test/integration"], {
        cwd: EXECUTOR_ROOT,
        stdio: "inherit",
        env,
      });

      const hardTimeout = setTimeout(() => {
        console.error(`[test:integration] vitest exceeded ${String(VITEST_TIMEOUT_MS)}ms — killing it (FAIL, not a pass).`);
        child.kill("SIGKILL");
        resolve(1);
      }, VITEST_TIMEOUT_MS);
      hardTimeout.unref();

      child.on("exit", (code) => {
        clearTimeout(hardTimeout);
        resolve(code ?? 1);
      });
      child.on("error", (error) => {
        clearTimeout(hardTimeout);
        console.error(`[test:integration] failed to launch vitest: ${error.message}`);
        resolve(1);
      });
    });

    process.exitCode = vitestExitCode;
  } finally {
    // ALWAYS stop DynamoDB Local, including on the hard-timeout/kill path
    // above — this orchestrator must never leave a java.exe behind.
    await dynamoInstance.stop();
    console.log("[test:integration] DynamoDB Local stopped.");
  }
}

await main();
