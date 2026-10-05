// @akili-spec changes/cicd-executor-poc design §3.2, §7
// Port: abstracts wall-clock time so domain and application code never call
// `Date.now()`/`new Date()` directly. Lets deadline/lease/window logic
// (design §7.1, §7.6, §7.7) be tested deterministically.

export interface Clock {
  now(): Date;
}
