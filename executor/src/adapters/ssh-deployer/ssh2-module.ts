// @akili-spec changes/cicd-executor-poc design §7.5, DD-10
// `ssh2` is CommonJS and its `module.exports` is not statically analyzable by
// Node's ESM named-export detection (`Server` is missing), so it is loaded
// through `createRequire`. Types still come from `@types/ssh2`.
import { createRequire } from "node:module";

const ssh2 = createRequire(import.meta.url)("ssh2") as typeof import("ssh2");

export const Client = ssh2.Client;
export const Server = ssh2.Server;
export const utils = ssh2.utils;
