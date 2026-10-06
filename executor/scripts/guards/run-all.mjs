#!/usr/bin/env node
// @akili-spec changes/cicd-executor-poc requirements NFR-01, NFR-02, NFR-08, NFR-10; design §4.1, DD-23
//
// T-21: runs all boundary/publication-policy guards and exits non-zero
// if any reports a violation. This is what `npm run validate` wires up
// (package.json). Each guard is independent and reports its own
// violations; this script only orchestrates and prints a clear English
// report naming the guard and the offending file:line (values are masked —
// see lib/report.mjs — never printed in full).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerfileBoundaryGuard } from "./dockerfile-boundary.mjs";
import { runProjectIdentifiersGuard } from "./project-identifiers.mjs";
import { runPipelineSchemaExpressionGuard } from "./pipeline-schema-expressions.mjs";
import { runPublicationPolicyGuard } from "./publication-policy.mjs";
import { runLocalAnalysisFilesGuard } from "./local-analysis-files.mjs";
import { runExtensibilityFixtureGuard } from "./extensibility-fixture.mjs";
import { runObsolescenceGuard, listPendingObsolescence } from "./obsolescence.mjs";
import { formatViolation } from "./lib/report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// scripts/guards -> scripts -> executor -> repo root
const repoRoot = path.resolve(here, "..", "..", "..");

const GUARDS = [
  { name: "1. dockerfile-boundary (NFR-01)", run: () => runDockerfileBoundaryGuard(repoRoot) },
  { name: "2. project-identifiers (NFR-01)", run: () => runProjectIdentifiersGuard(repoRoot) },
  { name: "3. pipeline-schema-expressions (FR-01, NFR-01)", run: () => runPipelineSchemaExpressionGuard(repoRoot) },
  { name: "4. publication-policy (NFR-02, DD-23)", run: () => runPublicationPolicyGuard(repoRoot) },
  { name: "5. local-analysis-files (design §4.1)", run: () => runLocalAnalysisFilesGuard(repoRoot) },
  { name: "6. extensibility-fixture (NFR-08)", run: () => runExtensibilityFixtureGuard(repoRoot) },
  { name: "8. obsolescence (NFR-01, design §15)", run: () => runObsolescenceGuard(repoRoot) },
];

async function main() {
  let anyFailed = false;
  for (const guard of GUARDS) {
    let violations;
    try {
      violations = await guard.run();
    } catch (error) {
      anyFailed = true;
      console.error(`FAIL  ${guard.name}`);
      console.error(`      guard threw: ${error?.stack ?? error}`);
      continue;
    }
    if (violations.length === 0) {
      console.log(`PASS  ${guard.name}`);
    } else {
      anyFailed = true;
      console.error(`FAIL  ${guard.name} (${violations.length} violation(s))`);
      for (const violation of violations) {
        console.error(`      ${formatViolation(violation)}`);
      }
    }
  }

  const pending = listPendingObsolescence(repoRoot).filter((p) => p.present);
  if (pending.length > 0) {
    console.log(`\nobsolescence: ${pending.length} PENDING entr${pending.length === 1 ? "y" : "ies"} (not failing; N-22 requires none):`);
    for (const p of pending) {
      console.log(`      ${p.owner}  ${p.path}${p.symbol ? ` :: ${p.symbol}` : ""}`);
    }
  }

  if (anyFailed) {
    console.error("\nvalidate: one or more boundary/publication-policy guards failed (see above).");
    process.exitCode = 1;
  } else {
    console.log("\nvalidate: all boundary/publication-policy guards passed.");
  }
}

await main();
