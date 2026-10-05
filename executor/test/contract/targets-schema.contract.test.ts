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

  it("accepts an entry that declares credentialRef alongside connectionRef (owner ruling, execution.md 2026-10-05: SSH credential kept separate from host identity)", () => {
    const fixture = clone(validRegistry);
    const entry = fixture["prms-reporting-dev"]!;
    expect(typeof entry.credentialRef).toBe("string");
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
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

    it("rejects an entry missing credentialRef (owner ruling, execution.md 2026-10-05: SSH credential is required, kept separate from connectionRef)", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      delete entry.credentialRef;
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
      // (requirements FR-02 'mandatory window policy': "declares external
      // deployers with a policy that does not require a window").
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an entry that omits the external-deployers declaration entirely (neither externalDeployersRef nor none)", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      // deployWindowPolicy stays "required", but neither externalDeployersRef
      // nor externalDeployers: none is declared — requirements FR-02 'mandatory
      // window policy': "omits the external-deployers declaration ...
      // rejected before any deploy".
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

    it("rejects a migration.run value outside the script-name pattern (T-03 forward pointer, T-02 review)", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      const migration = entry.migration as Record<string, unknown>;
      // Free text / shell-metacharacter-bearing value instead of a
      // package-script-style identifier (schemas/targets.schema.json
      // $defs/scriptName).
      migration.run = "migration:run; rm -rf /";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a migration.check value outside the script-name pattern", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      const migration = entry.migration as Record<string, unknown>;
      migration.check = "Migration Check CI"; // uppercase/spaces: not a script-name
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an entry missing portRef on a container", () => {
      const fixture = clone(validRegistry);
      const entry = fixture["prms-reporting-dev"]!;
      const containers = entry.containers as Array<Record<string, unknown>>;
      delete containers[0]!.portRef;
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
