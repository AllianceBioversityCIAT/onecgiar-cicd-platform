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
import { finalStage, scanFinalStage, splitStages } from "../support/dockerfile-boundary-scanner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dockerfilePath = path.resolve(here, "..", "..", "Dockerfile");
const repoRootDockerignorePath = path.resolve(here, "..", "..", "..", ".dockerignore");

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

// T-03 (design DD-19 "pipeline-definitions/, schemas/ and deploy-scripts/ are
// copied into the image at build time"): the runtime (final, shipped) stage must
// actually COPY all three directories, from the repo root (they are
// siblings of executor/, so the build context must be the repo root — see
// scripts/inspect-image.mjs's resolveBuildContext and the Dockerfile's own
// "BUILD CONTEXT" header comment). A Dockerfile whose build context were
// `executor/` instead could never resolve these COPY sources at all.
describe("Dockerfile runtime stage packages pipeline-definitions/, schemas/ and deploy-scripts/ (DD-19)", () => {
  const dockerfileText = readFileSync(dockerfilePath, "utf8");
  const runtimeStageText = finalStage(dockerfileText).text;

  it.each([
    ["pipeline-definitions", "/pipeline-definitions"],
    ["schemas", "/schemas"],
    ["deploy-scripts", "/deploy-scripts"],
  ])("copies %s into the image", (source, dest) => {
    const copyLineRe = new RegExp(`COPY\\s+(?:--chown=\\S+\\s+)?${source}\\s+${dest}\\b`);
    expect(runtimeStageText).toMatch(copyLineRe);
  });
});

// T-03 attempt 2 (advisory): the runtime stage must set CICD_DEFINITIONS_ROOT
// explicitly to where pipeline-definitions/, schemas/ and deploy-scripts/
// are copied, rather than relying solely on BundledDefinitionSource's
// dev-only walk-up fallback.
describe("Dockerfile runtime stage sets CICD_DEFINITIONS_ROOT (T-03 attempt 2 advisory)", () => {
  const dockerfileText = readFileSync(dockerfilePath, "utf8");
  const runtimeStageText = finalStage(dockerfileText).text;

  it("declares CICD_DEFINITIONS_ROOT", () => {
    expect(runtimeStageText).toMatch(/ENV\s+CICD_DEFINITIONS_ROOT=/);
  });
});

// T-03 (design §4.1 publication policy): when the build context is the repo
// root, Docker reads its .dockerignore from the CONTEXT ROOT — i.e. this
// repo-root file, not executor/.dockerignore. It must keep the two
// local-only analysis files out of every image build.
describe("repo-root .dockerignore (DD-19 repo-root build context)", () => {
  const dockerignoreText = readFileSync(repoRootDockerignorePath, "utf8");

  it.each(["JENKINS_REPLACEMENT_AKILI_CONTEXT.md", "JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md"])(
    "excludes %s",
    (fileName) => {
      expect(dockerignoreText).toContain(fileName);
    },
  );
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
