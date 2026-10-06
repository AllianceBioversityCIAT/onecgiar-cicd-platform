// @akili-spec changes/cicd-executor-poc design §6.2, DD-19
// Process entry point of the offline definitions check (`npm run definitions:check -- --root <dir>`). Never part of the Executor's start path.
import { runDefinitionsCheck } from "./index.js";

process.exitCode = await runDefinitionsCheck(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
