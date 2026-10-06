// @akili-spec changes/cicd-executor-poc requirements FR-01, FR-03
// Turns Ajv errors into "<instancePath> <keyword> <offending property>" strings so
// negative contract tests can assert WHICH field was rejected, not just that
// something failed.
import type { ValidateFunction } from "ajv";

export function violations(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) => {
    const params = e.params as { additionalProperty?: string; missingProperty?: string; propertyName?: string };
    const prop = params.additionalProperty ?? params.missingProperty ?? params.propertyName ?? "";
    return prop ? `${e.instancePath} ${e.keyword} ${prop}` : `${e.instancePath} ${e.keyword}`;
  });
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
