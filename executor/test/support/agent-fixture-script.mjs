// Test-only stand-in for a catalog deploy script (architecture-change-04 E3 tests). Run as
// `node agent-fixture-script.mjs <contract args...>` by the tests' spawn function; its behavior comes from the JSON in
// CICD_TEST_CONTROL: { markers, sleepMs, exitCode, stdout, ignoreTerm, spawnApp }. It appends {start, end, args} to the
// markers file, prints some output (including secret-shaped text to prove redaction), then CICD_RESULT as its last line.
// `spawnApp: { pidFile, holdStdout }` starts a long-lived detached "application" process (as `docker compose up -d` or
// a supervisor would leave one) and writes its pid; with `holdStdout` the application inherits the script's stdout,
// with `sameGroup` it stays in the script's process group (as `nohup app &` would).
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const control = JSON.parse(process.env.CICD_TEST_CONTROL ?? "{}");
const args = process.argv.slice(2);
const start = Date.now();
if (control.ignoreTerm) process.on("SIGTERM", () => undefined);
process.stdout.write(`starting with ${String(args.length)} arguments\n`);
process.stdout.write(`${control.stdout ?? "password=hunter2-not-a-real-secret"}\n`);
process.stderr.write("a warning on stderr\n");
if (control.spawnApp) {
  const app = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 120000)"], {
    detached: !control.spawnApp.sameGroup,
    stdio: control.spawnApp.holdStdout ? ["ignore", "inherit", "ignore"] : "ignore",
    windowsHide: true,
  });
  writeFileSync(control.spawnApp.pidFile, String(app.pid));
  app.unref();
}
setTimeout(() => {
  if (control.markers) appendFileSync(control.markers, `${JSON.stringify({ start, end: Date.now(), args })}\n`);
  const commit = args[args.indexOf("--commit-sha") + 1];
  process.stdout.write(`CICD_RESULT ${JSON.stringify({ status: control.exitCode === 0 || control.exitCode === undefined ? "SUCCESS" : "FAILED", ...(commit ? { deployedCommit: commit } : {}) })}\n`);
  process.exit(control.exitCode ?? 0);
}, control.sleepMs ?? 50);
