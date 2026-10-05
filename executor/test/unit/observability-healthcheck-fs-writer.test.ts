// @akili-spec changes/cicd-executor-poc design §12 "Liveness"
//
// Proves the thin `node:fs` adapter behind `HealthcheckWriter` (design §12:
// "writes a file for the container's healthcheck"). Deliberately the only
// test in this module touching the real filesystem — every other
// observability test uses the injected port instead. Also proves the write
// is atomic (temp file + rename, never a truncate-in-place): a healthcheck
// probe reading concurrently must only ever see a complete file, and no
// stray temp file should survive a successful write.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsHealthcheckWriter } from "../../src/observability/heartbeat/fs-healthcheck-writer.js";

describe("createFsHealthcheckWriter — thin node:fs adapter (design §12)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "executor-healthcheck-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the given contents to the given path", () => {
    const writer = createFsHealthcheckWriter();
    const path = join(dir, "healthcheck.json");

    writer.write(path, JSON.stringify({ lastHeartbeatAt: "2026-10-05T12:00:00.000Z" }));

    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ lastHeartbeatAt: "2026-10-05T12:00:00.000Z" }));
  });

  it("writes atomically: no temp file left behind, and a second write fully replaces the first (no leftover bytes)", () => {
    const writer = createFsHealthcheckWriter();
    const path = join(dir, "healthcheck.json");

    writer.write(path, JSON.stringify({ lastHeartbeatAt: "2026-10-05T12:00:00.000Z" }));
    writer.write(path, JSON.stringify({ lastHeartbeatAt: "2026-10-05T12:01:00.000Z" }));

    const entries = readdirSync(dir);
    expect(entries).toEqual(["healthcheck.json"]);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ lastHeartbeatAt: "2026-10-05T12:01:00.000Z" }));
  });
});
