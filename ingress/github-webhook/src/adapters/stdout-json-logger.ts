// @akili-spec changes/cicd-executor-poc design §6.6
// JSON stdout logger adapter: one structured JSON line per entry, written to
// process.stdout via console.log. No AWS SDK, no fs — the simplest possible
// sink for a Lambda, whose log lines reach CloudWatch through stdout
// capture. The core never calls console/process.stdout itself; only this
// adapter does (src/core/handle-webhook.ts depends on the Logger port only).
import type { Logger } from "../core/ports.js";

export class StdoutJsonLogger implements Logger {
  log(entry: Readonly<Record<string, unknown>>): void {
    console.log(JSON.stringify(entry));
  }
}
