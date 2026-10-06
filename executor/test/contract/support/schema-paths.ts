// @akili-spec changes/cicd-executor-poc requirements FR-01, FR-02, FR-04; design 6.1, 7.7, DD-23
// Shared paths for contract tests: repo-root schemas/ and deployment-definitions/
// (never duplicated under executor/ — the schemas are the single source of truth).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// here = executor/test/contract/support -> up 4 levels to the repo root.
export const repoRoot = path.resolve(here, "..", "..", "..", "..");
export const schemasDir = path.join(repoRoot, "schemas");

export const targetsSchemaPath = path.join(schemasDir, "targets.schema.json");
export const eventSchemaPath = path.join(schemasDir, "event.schema.json");

export const targetsDevYamlPath = path.join(repoRoot, "deployment-definitions", "targets", "dev.yaml");

// Model B (AC-01) contracts: deployment definition, deploy request, deployment-definitions/.
export const deploymentDefinitionsDir = path.join(repoRoot, "deployment-definitions");
export const deploymentSchemaPath = path.join(schemasDir, "deployment.schema.json");
export const deployRequestSchemaPath = path.join(schemasDir, "deploy-request.schema.json");
export const prmsReportingDevDeploymentYamlPath = path.join(deploymentDefinitionsDir, "prms", "reporting-dev.yaml");
