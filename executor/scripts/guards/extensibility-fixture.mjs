// @akili-spec changes/cicd-executor-poc requirements NFR-08; design §4.2, §7, DD-19
//
// Guard 6: "Adding a deployment of the same pattern requires only a
// definition and a registry entry, with no code changes to the Executor"
// (requirements.md NFR-08). Proven by validating a SECOND, fictitious
// deployment definition + target registry entry (fake project "atlas-sync",
// never cited anywhere in the spec — see
// executor/test/fixtures/nfr08-second-definition/) through the real,
// unmodified definition-service (`validateForCi`, loaded via
// loadTsDirectoryModule — never duplicated) against the EXACT SAME schema
// files the real PRMS Reporting DEV definition uses. No Executor source
// file is touched by this guard.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadTsModule, loadTsDirectoryModule } from "./lib/load-ts-module.mjs";

/**
 * @param {string} repoRoot
 * @param {object} [overrides]
 * @param {string} [overrides.deploymentYamlPath]
 * @param {string} [overrides.targetRegistryYamlPath]
 */
export async function runExtensibilityFixtureGuard(repoRoot, overrides = {}) {
  const definitionServiceDir = path.join(repoRoot, "executor", "src", "application", "definition-service");
  const inMemorySourcePath = path.join(repoRoot, "executor", "test", "support", "in-memory-definition-source.ts");
  const deploymentSchemaPath = path.join(repoRoot, "schemas", "deployment.schema.json");
  const targetsSchemaPath = path.join(repoRoot, "schemas", "targets.schema.json");
  const deploymentYamlPath =
    overrides.deploymentYamlPath ??
    path.join(repoRoot, "executor", "test", "fixtures", "nfr08-second-definition", "deployment.yaml");
  const targetRegistryYamlPath =
    overrides.targetRegistryYamlPath ??
    path.join(repoRoot, "executor", "test", "fixtures", "nfr08-second-definition", "target-registry.yaml");

  const anchorDir = path.join(repoRoot, "executor");
  const definitionService = await loadTsDirectoryModule(definitionServiceDir, "index", anchorDir);
  const { InMemoryDefinitionSource } = await loadTsModule(inMemorySourcePath, anchorDir);

  const fictitiousDeploymentId = "atlas-sync-dev";
  const definitionSource = new InMemoryDefinitionSource({
    deployments: { [fictitiousDeploymentId]: readFileSync(deploymentYamlPath, "utf8") },
    targetRegistry: readFileSync(targetRegistryYamlPath, "utf8"),
    schemas: {
      "deployment.schema.json": readFileSync(deploymentSchemaPath, "utf8"),
      "targets.schema.json": readFileSync(targetsSchemaPath, "utf8"),
    },
  });

  try {
    await definitionService.validateForCi({ definitionSource }, [fictitiousDeploymentId]);
    return [];
  } catch (error) {
    const detail =
      error && typeof error === "object" && "issues" in error
        ? JSON.stringify(error.issues)
        : String(error?.message ?? error);
    return [
      {
        guard: "extensibility-fixture",
        file: path.relative(repoRoot, deploymentYamlPath).split(path.sep).join("/"),
        message: `a second, fictitious deployment of the same pattern failed validateForCi with NO code changes to the Executor (NFR-08 is violated): ${detail}`,
      },
    ];
  }
}
