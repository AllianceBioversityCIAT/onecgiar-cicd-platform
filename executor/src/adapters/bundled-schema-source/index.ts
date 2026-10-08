// @akili-spec changes/cicd-executor-poc design §1.2, DD-19 (superseded in V1: `schemas/` stays bundled); tasks R-6
// SchemaSource reading the `schemas/` directory bundled into the image (AC-02
// V1). Reads nothing else: no `deployment-definitions/`, no target registry
// file, no `deploy-scripts/`. The root comes from the composition root
// (`CICD_DEFINITIONS_ROOT`, the image sets `/`); without one it walks up from
// this module to the first ancestor holding `schemas/` (dev and tests).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SchemaContent, SchemaSource } from "../../ports/schema-source.js";

/** A bare schema file name: no directory part, so a name can never leave `schemas/`. */
const SCHEMA_NAME = /^[a-z0-9][a-z0-9-]*\.schema\.json$/;

export class SchemaSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaSourceError";
  }
}

/** First ancestor of `startDir` that contains a `schemas/` directory. */
export function findSchemasRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, "schemas"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new SchemaSourceError(`could not locate a directory containing "schemas/" walking up from ${startDir}`);
}

export interface BundledSchemaSourceOptions {
  /** Directory that contains `schemas/`. Defaults to the walk-up from this module. */
  readonly root?: string;
}

export class BundledSchemaSource implements SchemaSource {
  private readonly schemasDir: string;

  constructor(options: BundledSchemaSourceOptions = {}) {
    const root = options.root ?? findSchemasRoot(path.dirname(fileURLToPath(import.meta.url)));
    this.schemasDir = path.join(root, "schemas");
  }

  async getSchema(schemaName: string): Promise<SchemaContent> {
    if (!SCHEMA_NAME.test(schemaName)) {
      throw new SchemaSourceError(`invalid schema name ${JSON.stringify(schemaName)}: a bare "<name>.schema.json" file name is required`);
    }
    const filePath = path.join(this.schemasDir, schemaName);
    if (!existsSync(filePath)) throw new SchemaSourceError(`schema not found: "${schemaName}" (looked in ${filePath})`);
    return { content: await readFile(filePath, "utf8") };
  }
}
