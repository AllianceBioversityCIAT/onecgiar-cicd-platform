// @akili-spec changes/cicd-executor-poc requirements FR-04, FR-20; design §6.1
// Draft 2020-12 Ajv instance (schemas/event.schema.json declares
// "$schema": "https://json-schema.org/draft/2020-12/schema") with formats
// (uuid, date-time) registered. Mirrors executor/test/contract/support/ajv-factory.ts.
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// ajv and ajv-formats are CommonJS packages with no "type": "module" and no
// "exports" map; under this project's ESM + NodeNext module resolution, a
// default-import of either triggers a known Ajv/TS interop mismatch. See
// executor/test/contract/support/ajv-factory.ts for the full rationale.
const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv;
}

export function readJsonSchema(filePath: string): object {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
