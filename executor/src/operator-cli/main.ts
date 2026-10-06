// @akili-spec changes/cicd-executor-poc design §4.2 (tools/), DD-21
// Process entry point of the operator CLI. The real SQS publisher adapter
// (adapters/sqs-publisher) is still a skeleton, so this entry point wires a
// publisher that REFUSES to publish: use `--dry-run` to print the event until
// the adapter lands. No AWS call is made from here.
import { runOperatorCli } from "./index.js";

const code = await runOperatorCli(process.argv.slice(2), {
  clock: { now: () => new Date() },
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  publisher: {
    publish: () => Promise.reject(new Error("SQS publisher adapter is not wired yet; re-run with --dry-run")),
  },
});
process.exitCode = code;
