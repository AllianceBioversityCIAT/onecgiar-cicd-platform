// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
//
// Guard 1 (image inspection, local pre-check): no toolchains, no Docker
// socket in the Executor's shipped image. Docker is NOT available locally
// (owner decision) — the REAL, authoritative image-inspection gate stays
// `npm run inspect:image` (scripts/inspect-image.mjs), which is DEFERRED
// (exit 3) without a reachable Docker daemon; this guard does not weaken or
// replace it. Instead this guard reuses, unmodified, the existing static
// Dockerfile boundary scanner (executor/test/support/dockerfile-boundary-scanner.ts,
// already proven against its own falsifier fixtures in
// dockerfile-boundary-scanner.test.ts) and runs it against the Executor's
// real Dockerfile, so `npm run validate` catches a boundary regression
// without a Docker daemon and without duplicating the scanner's rules.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadTsModule } from "./lib/load-ts-module.mjs";

export async function runDockerfileBoundaryGuard(repoRoot, dockerfilePath) {
  const scannerPath = path.join(repoRoot, "executor", "test", "support", "dockerfile-boundary-scanner.ts");
  const scanner = await loadTsModule(scannerPath, path.join(repoRoot, "executor"));
  const targetPath = dockerfilePath ?? path.join(repoRoot, "executor", "Dockerfile");
  const text = readFileSync(targetPath, "utf8");
  const violations = scanner.scanFinalStage(text);
  const relFile = path.relative(repoRoot, targetPath).split(path.sep).join("/");
  return violations.map((v) => ({
    guard: "dockerfile-boundary",
    file: relFile,
    message: `[${v.rule}] ${v.detail}`,
  }));
}
