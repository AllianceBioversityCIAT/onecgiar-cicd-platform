// @akili-spec changes/cicd-executor-poc design §7 (sqs-consumer row), DD-02, DD-14 (N-17a emulator tests)
// Downloads and runs ElasticMQ (a local SQS emulator) for the SQS consumer's
// emulator tests. Same constraints as the DynamoDB Local helper: NO Docker,
// no machine configuration changes — ElasticMQ is a plain Java process whose
// standalone jar is downloaded on demand into the gitignored `.local/`
// directory (never committed, never a machine-wide install).
//
// Plain Node (.mjs) so it runs standalone via `node`, like dynamodb-local.mjs.
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import https from "node:https";
import { findFreePort, waitForPortClosed } from "./dynamodb-local.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXECUTOR_ROOT = join(__dirname, "..", "..");
export const LOCAL_DIR = join(EXECUTOR_ROOT, ".local", "elasticmq");
export const JAR_PATH = join(LOCAL_DIR, "elasticmq-server.jar");
const VERSION = "1.7.1";
const DOWNLOAD_URL = `https://github.com/softwaremill/elasticmq/releases/download/v${VERSION}/elasticmq-server-all-${VERSION}.jar`;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 30_000;

export { findFreePort };

function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
      const { statusCode, headers } = response;
      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects downloading ${url}`));
          return;
        }
        downloadFile(headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed: ${url} responded ${String(statusCode)}`));
        return;
      }
      const fileStream = createWriteStream(destPath);
      response.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(() => resolve()));
      fileStream.on("error", reject);
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`timed out downloading ${url}`)));
  });
}

/** Downloads the ElasticMQ standalone jar into `.local/` if not already present. Idempotent. */
export async function ensureElasticMqJar() {
  if (existsSync(JAR_PATH)) {
    return JAR_PATH;
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  const partial = `${JAR_PATH}.part`;
  try {
    await downloadFile(DOWNLOAD_URL, partial);
    await rename(partial, JAR_PATH);
  } finally {
    await rm(partial, { force: true });
  }
  return JAR_PATH;
}

function waitForPortOpen(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const conn = connect({ port, host: "127.0.0.1" }, () => {
        conn.end();
        resolve();
      });
      conn.on("error", () => {
        conn.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`ElasticMQ did not start listening on port ${String(port)} within ${String(timeoutMs)}ms`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

/** Kills `child` AND its descendants (see dynamodb-local.mjs for why on Windows). */
function killProcessTree(child) {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  child.stderr?.destroy();
}

/**
 * Spawns `java -jar elasticmq-server.jar` on `port` and waits until it accepts
 * connections. Returns `{ port, endpoint, stop() }`. Throws if Java is
 * unavailable, the jar cannot be fetched, or the process does not come up —
 * the caller turns that into a visible SKIPPED, never a pass.
 */
export async function startElasticMqLocal(port) {
  const jarPath = await ensureElasticMqJar();
  const configPath = join(LOCAL_DIR, `custom-${String(port)}.conf`);
  await writeFile(
    configPath,
    [
      'include classpath("application.conf")',
      `node-address { protocol = http, host = "127.0.0.1", port = ${String(port)}, context-path = "" }`,
      `rest-sqs { enabled = true, bind-port = ${String(port)}, bind-hostname = "127.0.0.1", sqs-limits = strict }`,
      "rest-stats { enabled = false }",
      "queues {}",
      "",
    ].join("\n"),
  );
  const child = spawn("java", [`-Dconfig.file=${configPath}`, "-jar", jarPath], {
    cwd: LOCAL_DIR,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  let stderrOutput = "";
  child.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });
  const exitBeforeReady = new Promise((_resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`ElasticMQ exited early (code ${String(code)}): ${stderrOutput}`)));
    child.once("error", reject);
  });
  // Swallow the rejection if stop() wins the race later.
  exitBeforeReady.catch(() => undefined);

  try {
    await Promise.race([waitForPortOpen(port, START_TIMEOUT_MS), exitBeforeReady]);
  } catch (error) {
    killProcessTree(child);
    await rm(configPath, { force: true });
    throw error;
  }

  return {
    port,
    endpoint: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
      killProcessTree(child);
      await waitForPortClosed(port, 10_000);
      await rm(configPath, { force: true });
    },
  };
}

// Standalone dev command (`npm run sqs:local`): fixed port, runs until Ctrl+C.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = 9324;
  console.log(`[elasticmq-local] ensuring jar in ${LOCAL_DIR} ...`);
  const instance = await startElasticMqLocal(port);
  console.log(`[elasticmq-local] listening on ${instance.endpoint} (Ctrl+C to stop)`);
  process.on("SIGINT", async () => {
    await instance.stop();
    process.exit(0);
  });
}
