// @akili-spec changes/cicd-executor-poc design DD-03 (T-08's integration tests)
// Downloads and runs DynamoDB Local for the Executor's integration tests.
// Owner constraint: NO Docker, no Docker alternative, no machine config
// changes — DynamoDB Local runs as a plain Java 17 process, with its jar
// downloaded on demand into the gitignored `.local/` directory (never
// committed, never a machine-wide install).
//
// Plain Node (.mjs, no TypeScript) so it can run standalone via `node` with
// no build step, same convention as the existing `scripts/inspect-image.mjs`.
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import https from "node:https";
import * as tar from "tar";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXECUTOR_ROOT = join(__dirname, "..", "..");
export const LOCAL_DIR = join(EXECUTOR_ROOT, ".local", "dynamodb-local");
export const JAR_PATH = join(LOCAL_DIR, "DynamoDBLocal.jar");
const DOWNLOAD_URL = "https://s3.us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.tar.gz";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 20_000;

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

/** Downloads + extracts the DynamoDB Local jar into `.local/` if not already present. Idempotent. */
export async function ensureDynamoDbLocalJar() {
  if (existsSync(JAR_PATH)) {
    return JAR_PATH;
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  const tarballPath = join(LOCAL_DIR, "dynamodb_local_latest.tar.gz");
  try {
    await downloadFile(DOWNLOAD_URL, tarballPath);
    await tar.extract({ file: tarballPath, cwd: LOCAL_DIR });
  } finally {
    await rm(tarballPath, { force: true });
  }
  if (!existsSync(JAR_PATH)) {
    throw new Error(`extracted DynamoDB Local but ${JAR_PATH} is still missing — unexpected archive layout`);
  }
  return JAR_PATH;
}

/** Finds a free TCP port by asking the OS for an ephemeral one, then releasing it. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) {
          reject(new Error("could not determine a free port"));
        } else {
          resolve(port);
        }
      });
    });
  });
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
          reject(new Error(`DynamoDB Local did not start listening on port ${String(port)} within ${String(timeoutMs)}ms`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

/**
 * Spawns `java -jar DynamoDBLocal.jar -inMemory -port <port>` and waits until
 * it accepts connections. Returns `{ port, stop() }`. Throws if Java is
 * unavailable or the process does not come up in time — the caller (the
 * `npm run test:integration` orchestrator) is responsible for turning that
 * into a clear, visible SKIP, never a silent pass.
 */
export async function startDynamoDbLocal(port) {
  const jarPath = await ensureDynamoDbLocalJar();
  const libPath = join(LOCAL_DIR, "DynamoDBLocal_lib");
  const child = spawn(
    "java",
    [`-Djava.library.path=${libPath}`, "-jar", jarPath, "-inMemory", "-sharedDb", "-port", String(port)],
    // POSIX: its own process group so stop() can signal the whole tree.
    // stdout is never read, so it is ignored (an unread pipe can keep Node alive).
    { cwd: LOCAL_DIR, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true },
  );

  let stderrOutput = "";
  child.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  const exitBeforeReady = new Promise((_resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`DynamoDB Local exited early (code ${String(code)}): ${stderrOutput}`)));
    child.once("error", reject);
  });

  await Promise.race([waitForPortOpen(port, START_TIMEOUT_MS), exitBeforeReady]);

  return {
    port,
    stop: async () => {
      killProcessTree(child);
      await waitForPortClosed(port, 10_000);
    },
  };
}

/**
 * Kills `child` AND its descendants. On Windows, `java` may be a launcher shim
 * that starts the real JVM as its own child, so `child.kill()` alone would
 * leave the JVM running (and its pipes open, hanging Node).
 */
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

/** Resolves once nothing accepts connections on `port` (throws on timeout). */
export function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const conn = connect({ port, host: "127.0.0.1" }, () => {
        conn.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`port ${String(port)} still accepts connections ${String(timeoutMs)}ms after stop()`));
        } else {
          setTimeout(attempt, 200);
        }
      });
      conn.on("error", () => {
        conn.destroy();
        resolve();
      });
    };
    attempt();
  });
}

// Allow `node test/support/dynamodb-local.mjs` as a standalone dev command
// (`npm run dynamodb:local`): start on a fixed, memorable port and keep
// running until Ctrl+C.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = 8000;
  console.log(`[dynamodb-local] ensuring jar in ${LOCAL_DIR} ...`);
  const instance = await startDynamoDbLocal(port);
  console.log(`[dynamodb-local] listening on http://127.0.0.1:${String(instance.port)} (Ctrl+C to stop)`);
  process.on("SIGINT", async () => {
    await instance.stop();
    process.exit(0);
  });
}
