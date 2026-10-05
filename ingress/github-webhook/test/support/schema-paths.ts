// @akili-spec changes/cicd-executor-poc design §6.1; api-design-principles (contracts and schemas)
// Shared path to the repo-root schemas/ (single source of truth — never duplicated under this package).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// here = ingress/github-webhook/test/support -> up 4 levels to the repo root.
export const repoRoot = path.resolve(here, "..", "..", "..", "..");
export const eventSchemaPath = path.join(repoRoot, "schemas", "event.schema.json");
