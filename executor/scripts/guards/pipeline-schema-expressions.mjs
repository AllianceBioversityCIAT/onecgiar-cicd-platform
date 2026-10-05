// @akili-spec changes/cicd-executor-poc requirements FR-01, NFR-01; design DD-19
//
// Guard 3: schemas/pipeline.schema.json rejects expressions, GitHub-Actions-
// style `${{ ... }}`, unwhitelisted `${...}` interpolation, shell
// command-substitution, and any unknown field (the only way a "condition"
// construct like `if:`/`when:` could be smuggled in, since the schema's
// step objects are `additionalProperties: false`).
//
// This is an OPERATIONAL guard for `npm run validate` (CI / pre-image-build
// gate) — it must work standalone, without a prior `npm run build` and
// without vitest. The AUTHORITATIVE, exhaustive proof of this property is
// executor/test/contract/pipeline-schema.contract.test.ts (run under `npm
// test`), which this guard deliberately does not re-litigate rule-by-rule;
// it reuses the SAME schema file and the SAME Ajv factory
// (createAjv/schema-validation.ts, loaded unmodified via loadTsModule) and
// carries only a small smoke corpus mirroring that contract test's
// expression-rejection cases, so `npm run validate` can fail fast on a
// schema regression even before vitest runs. If the contract test's corpus
// grows a new FR-01 rule, mirror it here too.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadTsModule } from "./lib/load-ts-module.mjs";

function findStep(definition, type) {
  const step = (definition.steps ?? []).find((s) => s.type === type);
  if (!step) throw new Error(`guard fixture error: no "${type}" step in the base definition`);
  return step;
}

const NEGATIVE_CORPUS = [
  {
    name: "GitHub-Actions-style expression construct (${{ ... }})",
    mutate: (def) => {
      findStep(def, "ssh").with.args = ["${{ 1 + 1 }}"];
    },
  },
  {
    name: "interpolation outside the whitelist (${env.*})",
    mutate: (def) => {
      findStep(def, "ssh").with.args = ["--secret=${env.AWS_SECRET_ACCESS_KEY}"];
    },
  },
  {
    name: "shell command-substitution ($(...))",
    mutate: (def) => {
      findStep(def, "ssh").with.args = ["--x=$(rm -rf /)"];
    },
  },
  {
    name: "backtick command-substitution",
    mutate: (def) => {
      findStep(def, "ssh").with.args = ["--x=`id`"];
    },
  },
  {
    name: "shell metacharacter (;) in an ssh arg",
    mutate: (def) => {
      findStep(def, "ssh").with.args = ["--unit=x; rm -rf /"];
    },
  },
  {
    name: 'a condition field ("if") on a step — closed-vocabulary rejection',
    mutate: (def) => {
      findStep(def, "ssh").if = "${{ success() }}";
    },
  },
];

/**
 * @param {string} schemaPath absolute path to a pipeline schema JSON file
 * @param {string} yamlPath absolute path to a valid pipeline definition YAML (must contain an "ssh" step)
 * @param {string} schemaValidationTsPath absolute path to definition-service's schema-validation.ts (reused, unmodified, for its Ajv factory)
 */
export async function runPipelineSchemaExpressionGuard(repoRoot, overrides = {}) {
  const schemaPath = overrides.schemaPath ?? path.join(repoRoot, "schemas", "pipeline.schema.json");
  const yamlPath =
    overrides.yamlPath ?? path.join(repoRoot, "pipeline-definitions", "prms", "reporting-dev.yaml");
  const schemaValidationTsPath =
    overrides.schemaValidationTsPath ??
    path.join(repoRoot, "executor", "src", "application", "definition-service", "schema-validation.ts");

  const { createAjv } = await loadTsModule(schemaValidationTsPath, path.join(repoRoot, "executor"));
  const ajv = createAjv();
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = ajv.compile(schema);

  const baseDefinition = parseYaml(readFileSync(yamlPath, "utf8"));
  const relSchemaPath = path.relative(repoRoot, schemaPath).split(path.sep).join("/");

  const violations = [];

  if (!validate(structuredClone(baseDefinition))) {
    violations.push({
      guard: "pipeline-schema-expressions",
      file: relSchemaPath,
      message: `the real, valid pipeline definition at ${path
        .relative(repoRoot, yamlPath)
        .split(path.sep)
        .join("/")} was unexpectedly rejected: ${JSON.stringify(validate.errors)}`,
    });
  }

  for (const corpusCase of NEGATIVE_CORPUS) {
    const fixture = structuredClone(baseDefinition);
    corpusCase.mutate(fixture);
    if (validate(fixture)) {
      violations.push({
        guard: "pipeline-schema-expressions",
        file: relSchemaPath,
        message: `expected rejection for "${corpusCase.name}" but the schema accepted it — expressions/conditions must never validate (FR-01, NFR-01)`,
      });
    }
  }

  return violations;
}
