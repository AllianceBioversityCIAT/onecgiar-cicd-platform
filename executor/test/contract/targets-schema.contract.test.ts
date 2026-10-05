// @akili-spec changes/cicd-executor-poc requirements FR-02; design 7.7, DD-11, DD-21, DD-23
//
// Contract tests for schemas/targets.schema.json (repo root). Proves:
//  1. The real, versioned pipeline-definitions/targets/dev.yaml validates.
//  2. A negative corpus, one fixture per FR-02 rule, each fails validation.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, beforeAll } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { targetsSchemaPath, targetsDevYamlPath } from "./support/schema-paths.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("schemas/targets.schema.json (FR-02)", () => {
  let validate: ValidateFunction;
  let validRegistry: Record<string, Record<string, unknown>>;

  beforeAll(() => {
    const ajv = createAjv();
    const schema = readJsonSchema(targetsSchemaPath);
    validate = ajv.compile(schema);
    validRegistry = parseYaml(readFileSync(targetsDevYamlPath, "utf8"));
  });

  it("accepts the real, versioned DEV target registry", () => {
    const ok = validate(validRegistry);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts the not-required/none branch (design 7.7 amended: none ⇔ not-required)", () => {
    const fixture = clone(validRegistry);
    const entry = fixture["prms-reporting-dev"]!;
    delete entry.externalDeployersRef;
    entry.externalDeployers = "none";
    entry.deployWindowPolicy = "not-required";
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  describe("negative corpus — one case per FR-02 rule", () => {
    it("rejects an entry missing hostKeyRef, even though the connection reference exists", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      delete entry.hostKeyRef;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an entry that omits deployWindowPolicy entirely", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      delete entry.deployWindowPolicy;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects deployWindowPolicy=not-required combined with an externalDeployersRef", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      entry.deployWindowPolicy = "not-required";
      // externalDeployersRef is still present — exactly the forbidden combination
      // (requirements FR-02 'política de ventana obligatoria': "declara
      // desplegadores externos con una política que no exige ventana").
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an entry that omits the external-deployers declaration entirely (neither externalDeployersRef nor none)", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      // deployWindowPolicy stays "required", but neither externalDeployersRef
      // nor externalDeployers: none is declared — requirements FR-02 'política
      // de ventana obligatoria': "omite la declaración de desplegadores
      // externos ... se rechaza antes de cualquier deploy".
      delete entry.externalDeployersRef;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects deployWindowPolicy=required combined with externalDeployers: none", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      // design 7.7 (amended 2026-10-05): a resolved empty external-deployers
      // list REQUIRES not-required; required + none is invalid by
      // construction (owner ruling, execution.md 2026-10-05) because a
      // window can only cover a non-empty external-deployers list.
      delete entry.externalDeployersRef;
      entry.externalDeployers = "none";
      // entry.deployWindowPolicy is left as "required" from the base fixture.
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an entry declaring both externalDeployersRef and externalDeployers: none", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      // Both forms present at once — neither oneOf branch (additionalProperties:
      // false) admits the other branch's property, so this must be rejected
      // regardless of which value deployWindowPolicy carries.
      entry.externalDeployers = "none";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects migrations enabled without attestation (migrationCompatibility/attestedBy)", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      const migration = entry.migration as Record<string, unknown>;
      delete migration.attestedBy;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects migrations enabled without migrationCompatibility declared", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      const migration = entry.migration as Record<string, unknown>;
      delete migration.migrationCompatibility;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an inline secret value (password) instead of a reference", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      entry.password = "hunter2";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an inline private key value instead of a reference", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      entry.privateKey = "-----BEGIN PRIVATE KEY-----\nMIIB...\n-----END PRIVATE KEY-----";
      expect(validate(fixture)).toBe(false);
    });
  });
});
