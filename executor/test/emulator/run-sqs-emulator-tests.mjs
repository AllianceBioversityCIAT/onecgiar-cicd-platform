// @akili-spec changes/cicd-executor-poc design §7 (sqs-consumer row), DD-14, FR-04 (N-17a)
// Orchestrator behind `npm run test:sqs-emulator`. Starts ElasticMQ (no Docker:
// Java + the on-demand jar in `.local/`), points the emulator suite at it
// through SQS_LOCAL_ENDPOINT, runs `vitest run test/emulator`, then tears the
// server down.
//
// If ElasticMQ cannot be started (no Java, no network to fetch the jar, ...),
// it prints a clearly labeled SKIPPED block and exits 0 WITHOUT running vitest:
// not a pass, not a fail. Without SQS_LOCAL_ENDPOINT the suite itself is
// reported by vitest as skipped, never as passed.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePort, startElasticMqLocal } from "../support/elasticmq-local.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXECUTOR_ROOT = join(__dirname, "..", "..");
const VITEST_CLI = join(EXECUTOR_ROOT, "node_modules", "vitest", "vitest.mjs");
const VITEST_TIMEOUT_MS = 5 * 60 * 1000;

async function main() {
  let instance;
  try {
    const port = await findFreePort();
    instance = await startElasticMqLocal(port);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log("================================================================");
    console.log("SKIPPED: the ElasticMQ SQS emulator could not be started — the");
    console.log("emulator tests were NOT run (not a pass, not a fail: skipped).");
    console.log(`Reason: ${reason}`);
    console.log("================================================================");
    process.exitCode = 0;
    return;
  }

  console.log(`[test:sqs-emulator] ElasticMQ up on ${instance.endpoint}`);
  const env = {
    ...process.env,
    SQS_LOCAL_ENDPOINT: instance.endpoint,
    // Publicly documented AWS SDK EXAMPLE credentials: obviously fake.
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    AWS_REGION: "us-east-1",
  };

  try {
    process.exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [VITEST_CLI, "run", "test/emulator"], {
        cwd: EXECUTOR_ROOT,
        stdio: "inherit",
        env,
      });
      const hardTimeout = setTimeout(() => {
        console.error(`[test:sqs-emulator] vitest exceeded ${String(VITEST_TIMEOUT_MS)}ms — killing it (FAIL, not a pass).`);
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
        console.error(`[test:sqs-emulator] failed to launch vitest: ${error.message}`);
        resolve(1);
      });
    });
  } finally {
    await instance.stop();
    console.log("[test:sqs-emulator] ElasticMQ stopped.");
  }
}

await main();
