// @akili-spec changes/cicd-executor-poc design §6.1, §6.4, DD-19; requirements FR-03, FR-04
// Ajv wiring to validate a parseable message against the repo-root
// schemas/deploy-request.schema.json (DEPLOY_REQUESTED) and
// schemas/event.schema.json (internal events). Both schemas are obtained
// through the `SchemaSource` port (AC-02 V1, R-6: the bundled `schemas/`) and
// compiled once at startup, never rebuilt per message. The rules live only in the
// schemas ("reuse it, do not duplicate the rules").
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import type { SchemaSource } from "../../ports/schema-source.js";

// ajv and ajv-formats are CommonJS packages: see
// executor/test/contract/support/ajv-factory.ts for the NodeNext interop note.
const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

export const DEPLOY_REQUEST_SCHEMA_NAME = "deploy-request.schema.json";
export const EVENT_SCHEMA_NAME = "event.schema.json";

export interface SchemaValidationResult {
  readonly valid: boolean;
  /** `<instancePath> <keyword>[ <property>]` per violated rule (FR-04: the violated rule is recorded). Empty when valid. */
  readonly errors: readonly string[];
}

export interface MessageSchemaValidator {
  validate(candidate: unknown): SchemaValidationResult;
}

export interface MessageValidators {
  readonly deployRequest: MessageSchemaValidator;
  readonly internalEvent: MessageSchemaValidator;
}

function describeErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) => {
    const params = e.params as { additionalProperty?: string; missingProperty?: string; unevaluatedProperty?: string };
    const property = params.additionalProperty ?? params.missingProperty ?? params.unevaluatedProperty ?? "";
    return `${e.instancePath || "(root)"} ${e.keyword}${property ? ` ${property}` : ""}`;
  });
}

function toValidator(validate: ValidateFunction): MessageSchemaValidator {
  return {
    validate(candidate: unknown): SchemaValidationResult {
      return validate(candidate) ? { valid: true, errors: [] } : { valid: false, errors: describeErrors(validate) };
    },
  };
}

export async function createMessageValidators(schemaSource: SchemaSource): Promise<MessageValidators> {
  // strictRequired is disabled: the per-type oneOf branches `require` properties declared in the same branch.
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const [request, event] = await Promise.all([
    schemaSource.getSchema(DEPLOY_REQUEST_SCHEMA_NAME),
    schemaSource.getSchema(EVENT_SCHEMA_NAME),
  ]);
  return {
    deployRequest: toValidator(ajv.compile(JSON.parse(request.content) as object)),
    internalEvent: toValidator(ajv.compile(JSON.parse(event.content) as object)),
  };
}
