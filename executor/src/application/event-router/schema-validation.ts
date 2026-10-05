// @akili-spec changes/cicd-executor-poc design §6.1, DD-19
// Ajv wiring to validate a candidate envelope against the repo-root
// schemas/event.schema.json (design §6.1: "reuse it, do not duplicate the
// rules"). The schema content itself is obtained through the
// `DefinitionSource` port — never a raw filesystem read here — per DD-19
// ("DefinitionSource is the core's only path to definitions") and
// CLAUDE.md rule 5: the core never knows whether schemas are bundled in the
// image or fetched some other way.
//
// The ajv construction mirrors
// executor/src/application/definition-service/schema-validation.ts and
// executor/test/contract/support/ajv-factory.ts (same draft, same CJS/ESM
// interop workaround — ajv and ajv-formats ship no ESM entry point under
// NodeNext resolution). Duplicated here deliberately: event-router does not
// import from definition-service (different owner, different module), and
// this snippet is small enough that the existing code already tolerates one
// copy per consuming module.
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import type { DefinitionSource } from "../../ports/definition-source.js";

const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

function createAjv(): Ajv2020 {
  // strictRequired disabled for the same reason as definition-service's
  // factory: event.schema.json's allOf/if/then blocks legitimately `require`
  // properties declared in the parent `properties`, which Ajv's strict mode
  // otherwise flags.
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv;
}

export interface EnvelopeValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface EnvelopeValidator {
  validate(candidate: unknown): EnvelopeValidationResult;
}

function toValidationResult(validate: ValidateFunction, valid: boolean): EnvelopeValidationResult {
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map((err) => `${err.instancePath || "(root)"} ${err.message ?? "invalid"}`);
  return { valid: false, errors };
}

/**
 * Compiles the event envelope schema once, via the injected `DefinitionSource`
 * (DD-19), and returns a reusable validator. Callers (event-router's
 * `routeEvent`, and ultimately the bootstrap wiring the SQS consumer, T-18)
 * build this once at startup and pass it into every `routeEvent` call — it is
 * not rebuilt per message.
 */
export async function createEnvelopeValidator(definitionSource: DefinitionSource): Promise<EnvelopeValidator> {
  const { content } = await definitionSource.getSchema("event.schema.json");
  const schema = JSON.parse(content) as object;
  const ajv = createAjv();
  const validateFn = ajv.compile(schema);
  return {
    validate(candidate: unknown): EnvelopeValidationResult {
      return toValidationResult(validateFn, validateFn(candidate));
    },
  };
}
