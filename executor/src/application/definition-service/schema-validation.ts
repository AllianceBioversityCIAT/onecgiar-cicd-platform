// @akili-spec changes/cicd-executor-poc requirements FR-01, FR-02; design DD-19, §7
// Ajv wiring for definition-service. Mirrors
// executor/test/contract/support/ajv-factory.ts (same draft, same CJS/ESM
// interop workaround — ajv and ajv-formats ship no ESM entry point under
// NodeNext resolution).
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import type { ValidationIssue } from "./semantic-rules.js";

const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

export function createAjv(): Ajv2020 {
  // strictRequired disabled for the same reason as the contract-test factory:
  // event.schema.json's allOf/if/then blocks legitimately `require`
  // properties declared in the parent `properties`, which Ajv's strict mode
  // otherwise flags.
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv;
}

export function ajvErrorsToIssues(validate: ValidateFunction, label: string): ValidationIssue[] {
  return (validate.errors ?? []).map((err) => ({
    rule: "schema",
    field: `${label}${err.instancePath || ""}`,
    message: err.message ?? "schema validation failed",
  }));
}
