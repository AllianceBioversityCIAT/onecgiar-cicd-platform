// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §4.2
// Applies the boundary scanner (test/support/dockerfile-boundary-scanner.ts)
// to the Executor's real, shipped Dockerfile. The scanner's own rules are
// proven able to fail — one negative fixture per rule — in
// dockerfile-boundary-scanner.test.ts; this file only asserts the real
// artifact is clean, so it can never pass by construction (delete/break the
// real Dockerfile's cleanup and this test goes red).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanFinalStage, splitStages } from "../support/dockerfile-boundary-scanner.js";

const dockerfilePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "Dockerfile",
);

describe("Dockerfile final-stage boundary (NFR-01)", () => {
  const dockerfileText = readFileSync(dockerfilePath, "utf8");

  it("declares at least one build stage", () => {
    expect(splitStages(dockerfileText).length).toBeGreaterThan(0);
  });

  it("final stage has zero boundary violations", () => {
    const violations = scanFinalStage(dockerfileText);
    expect(violations).toEqual([]);
  });
});

// T-01 falsifier: a Dockerfile variant that installs the Docker CLI in the
// final stage MUST fail the boundary check. The real, dynamic gate
// (scripts/inspect-image.mjs against this same fixture) is DEFERRED until a
// Docker daemon is reachable — the Leader runs it then — but the static
// scanner must already catch this mutation today.
describe("Dockerfile falsifier fixture (Docker CLI installed in the final stage)", () => {
  const falsifierPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "dockerfiles",
    "Dockerfile.falsifier-docker-cli",
  );
  const falsifierText = readFileSync(falsifierPath, "utf8");

  it("goes red on the Docker-CLI falsifier (forbidden-package:docker package)", () => {
    const violations = scanFinalStage(falsifierText);
    expect(violations.some((v) => v.rule === "forbidden-package:docker package")).toBe(true);
  });
});

// T-01 attempt 4 falsifier: apt-installed Maven places /usr/bin/mvn (and
// /usr/bin/java) as alternatives-system SYMLINKS to real binaries under
// /usr/share/maven and /usr/lib/jvm — the exact shape of binary the
// attempt 3 review found the real gate (scripts/inspect-image.mjs) blind
// to. The static scanner must already catch the package install; the real,
// dynamic gate against this same fixture is exercised once a Docker daemon
// is reachable (see the fixture file's own header comment).
describe("Dockerfile falsifier fixture (Maven installed in the final stage)", () => {
  const mavenFalsifierPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "dockerfiles",
    "Dockerfile.falsifier-maven",
  );
  const mavenFalsifierText = readFileSync(mavenFalsifierPath, "utf8");

  it("goes red on the Maven falsifier (forbidden-package:maven package)", () => {
    const violations = scanFinalStage(mavenFalsifierText);
    expect(violations.some((v) => v.rule === "forbidden-package:maven package")).toBe(true);
  });
});
