// @akili-spec changes/cicd-executor-poc design §12 "Liveness"
//
// Thin `node:fs` adapter for `HealthcheckWriter` (`./index.ts`). Deliberately
// the only file in the observability module that imports `node:fs` — the
// heartbeat core takes the port, never the filesystem, so it stays testable
// with a fake writer (see `test/unit/observability-heartbeat.test.ts`).
//
// Writes atomically (write to a sibling temp file, then rename over the
// target): a container healthcheck probe reads this file concurrently with
// the heartbeat's writes, and a truncate-then-write-in-place would let the
// probe observe a half-written (or empty) file mid-write. `rename` is a
// single filesystem operation — POSIX guarantees it atomic, and Node's
// `renameSync` on Windows replaces the destination in one `MoveFileExW`
// call — so the probe only ever sees the old complete file or the new one.
import { renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { HealthcheckWriter } from "./index.js";

export function createFsHealthcheckWriter(): HealthcheckWriter {
  return {
    write(filePath: string, contents: string): void {
      const tempPath = `${filePath}.tmp-${randomUUID()}`;
      writeFileSync(tempPath, contents, "utf8");
      renameSync(tempPath, filePath);
    },
  };
}
