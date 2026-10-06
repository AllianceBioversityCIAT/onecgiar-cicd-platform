// @akili-spec changes/cicd-executor-poc design §6.5, §7.5, DD-10, FR-12
export {
  Ssh2DeployTransport,
  remoteDirFor,
  type DeployTransportLogger,
  type Ssh2DeployTransportOptions,
  type TargetConnectionDetails,
  type TargetResolver,
} from "./ssh2-deploy-transport.js";
export { assertSafeExecutionId, assertSafeScriptArgs, buildRemoteCommand, shellQuote, UnsafeArgumentError } from "./shell-quote.js";
export { parseCicdResult, parseCicdResultLine } from "./cicd-result.js";
export { hostKeyFingerprint, matchesPinnedHostKey, parsePinnedHostKeys } from "./host-key.js";
