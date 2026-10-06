// @akili-spec changes/cicd-executor-poc requirements FR-01, NFR-01; design §6.2, DD-19
//
// Guard 3: schemas/deployment.schema.json rejects expressions, GitHub-Actions-
// style `${{ ... }}`, `${...}` interpolation, shell command-substitution, and
// any unknown field (the only way a "condition" construct such as `if:` /
// `when:` or a step graph could be smuggled in, since every object of the
// flat Deployment Definition is `additionalProperties: false`).
//
// (The file keeps its historical name; since AC-01 it guards the Deployment
// Definition schema, the successor of the pipeline schema.)
//
// This is an OPERATIONAL guard for `npm run validate` (CI / pre-image-build
// gate) — it must work standalone, without a prior `npm run build` and
// without vitest. The AUTHORITATIVE, exhaustive proof of this property is
// executor/test/contract/deployment-schema.contract.test.ts (run under `npm
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

const NEGATIVE_CORPUS = [
  {
    name: "GitHub-Actions-style expression construct (${{ ... }}) in a migration command",
    mutate: (def) => {
      def.migration.runCommand = "${{ 1 + 1 }}";
    },
  },
  {
    name: "interpolation (${env.*}) in a migration command",
    mutate: (def) => {
      def.migration.checkCommand = "check ${env.AWS_SECRET_ACCESS_KEY}";
    },
  },
  {
    name: "shell command-substitution ($(...)) in a health command",
    mutate: (def) => {
      const container = Object.keys(def.health)[0];
      def.health[container] = { command: "$(rm -rf /)" };
    },
  },
  {
    name: "backtick command-substitution in a migration command",
    mutate: (def) => {
      def.migration.runCommand = "`id`";
    },
  },
  {
    name: "shell metacharacter (;) in a migration command",
    mutate: (def) => {
      def.migration.runCommand = "migrate; rm -rf /";
    },
  },
  {
    name: "an interpolated raw value where a logical reference is required",
    mutate: (def) => {
      def.allowedSenderRef = "${env.ROLE}";
    },
  },
  {
    name: 'a condition field ("when") — closed-vocabulary rejection',
    mutate: (def) => {
      def.when = "${{ success() }}";
    },
  },
  {
    name: 'a condition field ("if") — closed-vocabulary rejection',
    mutate: (def) => {
      def.if = "always";
    },
  },
  {
    name: "a step graph (steps / needs) — no step graph in Model B",
    mutate: (def) => {
      def.steps = [{ id: "a", needs: [] }];
    },
  },
];

/**
 * @param {string} repoRoot
 * @param {object} [overrides]
 * @param {string} [overrides.schemaPath] absolute path to a deployment schema JSON file
 * @param {string} [overrides.yamlPath] absolute path to a valid deployment definition YAML (must contain `migration` and `health`)
 * @param {string} [overrides.schemaValidationTsPath] absolute path to definition-service's schema-validation.ts (reused, unmodified, for its Ajv factory)
 */
export async function runPipelineSchemaExpressionGuard(repoRoot, overrides = {}) {
  const schemaPath = overrides.schemaPath ?? path.join(repoRoot, "schemas", "deployment.schema.json");
  const yamlPath =
    overrides.yamlPath ?? path.join(repoRoot, "deployment-definitions", "prms", "reporting-dev.yaml");
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
      message: `the real, valid deployment definition at ${path
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
