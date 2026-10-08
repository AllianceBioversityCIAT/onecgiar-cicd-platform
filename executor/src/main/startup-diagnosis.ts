// @akili-spec changes/cicd-executor-poc design §4.2, §12, DD-23; tasks R-6
// The refusal line main prints on stderr before exiting 1. Only the error
// message is printed (configuration problems and unresolved references name
// the variable or the logical ref, never a resolved value).
export function describeStartupFailure(error: unknown): string[] {
  return [`executor refused to start: ${error instanceof Error ? error.message : String(error)}`];
}
