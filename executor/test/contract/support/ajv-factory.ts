// @akili-spec changes/cicd-executor-poc requirements FR-01, FR-02, FR-04
// Draft 2020-12 Ajv instance (schemas/*.schema.json declare
// "$schema": "https://json-schema.org/draft/2020-12/schema") with formats
// (uuid, date-time) registered, shared by every contract test.
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// ajv and ajv-formats are CommonJS packages with no "type": "module" and no
// "exports" map; under this project's ESM + NodeNext module resolution, a
// default-import of either triggers a known Ajv/TS interop mismatch (the
// default binding types as the whole module namespace instead of the
// exported class/function — see https://github.com/ajv-validator/ajv/issues
// for the same report against NodeNext consumers). `createRequire` loads the
// real CJS values directly, and the `import type`s above (erased at compile
// time, so they never go through the broken default-import resolution) give
// them back their real types.
const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

export function createAjv(): Ajv2020 {
  // strictRequired is disabled: event.schema.json's `allOf`/`if`/`then` blocks
  // legitimately `require` properties declared in the parent schema's
  // `properties` (not repeated in each `then`, since only `required` varies
  // per eventType) — a valid, non-redundant JSON Schema pattern that Ajv's
  // strictRequired lint otherwise flags as a likely mistake.
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv;
}

export function readJsonSchema(filePath: string): object {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
