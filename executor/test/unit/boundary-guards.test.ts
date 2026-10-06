// @akili-spec changes/cicd-executor-poc requirements NFR-01, NFR-02, NFR-08, NFR-10; design §4.1, DD-23
//
// T-21: one negative case per guard wired into `npm run validate`
// (executor/scripts/guards/*.mjs), plus reviewer round-1/round-2 fix
// coverage (denylist completeness + false-positive narrowing for
// guard 2, untracked-file scanning + masking + exact-line .gitignore
// matching for guards 4/5). Every mutation here happens against a TEMP
// directory/fixture — never against the real repository tree. The guards
// themselves are plain Node ESM (no build step needed), so they are
// imported directly here.
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "../contract/support/schema-paths.js";
import { runDockerfileBoundaryGuard } from "../../scripts/guards/dockerfile-boundary.mjs";
import { scanForProjectIdentifiers, runProjectIdentifiersGuard } from "../../scripts/guards/project-identifiers.mjs";
import { runDeploymentSchemaExpressionGuard } from "../../scripts/guards/deployment-schema-expressions.mjs";
import { runPublicationPolicyGuard } from "../../scripts/guards/publication-policy.mjs";
import { runLocalAnalysisFilesGuard } from "../../scripts/guards/local-analysis-files.mjs";
import { runExtensibilityFixtureGuard } from "../../scripts/guards/extensibility-fixture.mjs";
import { runActionPinningGuard } from "../../scripts/guards/action-pinning.mjs";

// Split so THIS file's own source text never contains the full fixture
// literal contiguously — guard 4 now also scans untracked-but-not-ignored
// files (reviewer round-2 advisory), which includes this very test file;
// without the split, the guard would flag its own negative-case fixture.
const FAKE_LEAKED_ACCESS_KEY_ID = "AKIA" + "ABCDEFGHIJKLMNOPQRST".slice(0, 16);
// Obviously fake, 40-lowercase-hex SHA (digits interleaved so no 12-digit run appears).
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
// 12 consecutive digits assembled at runtime so this file never carries the literal.
const ACCOUNT_ID_SHAPED = "9".repeat(12);
const FAKE_GIT_EMAIL = "guard-test" + "@example.com";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initTempGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", FAKE_GIT_EMAIL], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Guard 1 — dockerfile-boundary (NFR-01)", () => {
  it("reports zero violations for the real, shipped Dockerfile", async () => {
    const violations = await runDockerfileBoundaryGuard(repoRoot);
    expect(violations).toEqual([]);
  });

  it("goes red on the Docker-CLI falsifier fixture", async () => {
    const falsifierPath = path.join(
      repoRoot,
      "executor",
      "test",
      "fixtures",
      "dockerfiles",
      "Dockerfile.falsifier-docker-cli",
    );
    const violations = await runDockerfileBoundaryGuard(repoRoot, falsifierPath);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.message.includes("forbidden-package:docker package"))).toBe(true);
  });
});

describe("Guard 2 — project-identifiers (NFR-01)", () => {
  it("reports zero violations for the real executor/src and deploy-scripts/ trees", async () => {
    const violations = await runProjectIdentifiersGuard(repoRoot);
    expect(violations).toEqual([]);
  });

  it("goes red on a temp fixture containing a denylisted project identifier (prms)", () => {
    const dir = makeTempDir("guard2-fixture-");
    mkdirSync(path.join(dir, "handlers"), { recursive: true });
    writeFileSync(
      path.join(dir, "handlers", "codebuild-handler.ts"),
      "export function dispatch(project: string) {\n  if (project === 'prms') {\n    return 'special-cased';\n  }\n  return 'generic';\n}\n",
      "utf8",
    );
    const violations = scanForProjectIdentifiers(dir);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.message).toContain('"prms"');
    expect(violations[0]?.file).toBe("handlers/codebuild-handler.ts");
  });

  it.each(["clarisa", "alliance-indicators"])(
    "goes red on a bare-word denylisted identifier (%s)",
    (term) => {
      const dir = makeTempDir("guard2-word-fixture-");
      writeFileSync(path.join(dir, "fixture.ts"), `export const owner = "${term}";\n`, "utf8");
      const violations = scanForProjectIdentifiers(dir);
      expect(violations.some((v) => v.message.includes(`"${term}"`))).toBe(true);
    },
  );

  it.each(["risk", "monitoring", "bi"])(
    "goes red on a quoted-literal denylisted identifier (%s) used as a code-shaped token",
    (term) => {
      const dir = makeTempDir("guard2-quoted-fixture-");
      writeFileSync(
        path.join(dir, "fixture.ts"),
        `export function dispatch(project: string) {\n  if (project === '${term}') {\n    return 'special';\n  }\n  return 'generic';\n}\n`,
        "utf8",
      );
      const violations = scanForProjectIdentifiers(dir);
      expect(violations.some((v) => v.message.includes(`"${term}"`))).toBe(true);
    },
  );

  it("does NOT go red on ordinary prose using the same words (false-positive narrowing)", () => {
    const dir = makeTempDir("guard2-prose-fixture-");
    writeFileSync(
      path.join(dir, "fixture.ts"),
      [
        "// There is a risk of a race condition here if two executions overlap.",
        "// Metrics for monitoring the state machine are emitted by the heartbeat.",
        "// A bi-directional channel is used for the health check.",
        "export {};",
        "",
      ].join("\n"),
      "utf8",
    );
    const violations = scanForProjectIdentifiers(dir);
    expect(violations).toEqual([]);
  });

  it("goes red on a deploy-scripts/*.sh CODE line, but NOT on a comment line mentioning the same term", () => {
    const dir = makeTempDir("guard2-deploy-scripts-");
    writeFileSync(
      path.join(dir, "deploy-container.sh"),
      [
        "#!/usr/bin/env bash",
        "# GENERIC: nothing prms-specific is hardcoded (comment only — must NOT flag).",
        "project=\"prms\"",
        "",
      ].join("\n"),
      "utf8",
    );
    const violations = scanForProjectIdentifiers(dir, undefined, {
      isCommentLine: (line) => /^\s*#/.test(line),
      fileFilter: (p) => p.endsWith(".sh"),
    });
    expect(violations.length).toBe(1);
    expect(violations[0]?.line).toBe(3);
  });
});

describe("Guard 3 — deployment schema expressions (FR-01, NFR-01)", () => {
  it("reports zero violations against the real deployment schema and the real PRMS Reporting DEV definition", async () => {
    const violations = await runDeploymentSchemaExpressionGuard(repoRoot);
    expect(violations).toEqual([]);
  });

  it("goes red when the schema's command and reference patterns are loosened", async () => {
    const dir = makeTempDir("guard3-fixture-");
    const realSchemaText = readFileSync(path.join(repoRoot, "schemas", "deployment.schema.json"), "utf8");
    const schema = JSON.parse(realSchemaText) as {
      $defs: { commandName: { pattern: string }; logicalRef: { pattern: string } };
    };
    // Loosen BOTH value patterns to "accept anything" — the exact regression this guard exists to catch.
    schema.$defs.commandName.pattern = "^.*$";
    schema.$defs.logicalRef.pattern = "^.*$";
    const loosenedSchemaPath = path.join(dir, "deployment.schema.json");
    writeFileSync(loosenedSchemaPath, JSON.stringify(schema), "utf8");

    const violations = await runDeploymentSchemaExpressionGuard(repoRoot, { schemaPath: loosenedSchemaPath });
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("Guard 4 — publication-policy (NFR-02, DD-23)", () => {
  it("reports zero violations for the real, versioned (and untracked-but-not-ignored) tree", async () => {
    const violations = await runPublicationPolicyGuard(repoRoot);
    expect(violations).toEqual([]);
  });

  it("goes red on a temp git repo with a committed AWS access key id, masking it to at most 2 characters", async () => {
    const dir = makeTempDir("guard4-fixture-");
    initTempGitRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), ".local/\n", "utf8");
    writeFileSync(path.join(dir, "leaked.txt"), `AWS_ACCESS_KEY_ID=${FAKE_LEAKED_ACCESS_KEY_ID}\n`, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "test fixture"], { cwd: dir });

    const violations = await runPublicationPolicyGuard(dir);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.message.includes("aws-access-key-id"))).toBe(true);
    // Never prints the secret value in full, and never more than its first 2 characters.
    const revealed = FAKE_LEAKED_ACCESS_KEY_ID.slice(0, 3); // "AKI" — 3 chars must never appear
    expect(violations.every((v) => !v.message.includes(FAKE_LEAKED_ACCESS_KEY_ID))).toBe(true);
    expect(violations.every((v) => !v.message.includes(revealed))).toBe(true);
  });

  it("goes red on an UNTRACKED, non-ignored file with a committed-nowhere secret (not just tracked/staged files)", async () => {
    const dir = makeTempDir("guard4-untracked-fixture-");
    initTempGitRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), ".local/\n", "utf8");
    // Deliberately left untracked (never `git add`): guard 4 must still see it.
    writeFileSync(path.join(dir, "untracked-leak.txt"), `token=${FAKE_LEAKED_ACCESS_KEY_ID}\n`, "utf8");

    const violations = await runPublicationPolicyGuard(dir);
    expect(violations.some((v) => v.file === "untracked-leak.txt" && v.message.includes("aws-access-key-id"))).toBe(
      true,
    );
  });

  it('requires .local/ as a WHOLE gitignore line, not merely mentioned in a comment', async () => {
    const dir = makeTempDir("guard4-gitignore-substring-");
    initTempGitRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), "# remember to keep .local/ out of git\nnode_modules/\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "test fixture"], { cwd: dir });

    const violations = await runPublicationPolicyGuard(dir);
    expect(violations.some((v) => v.file === ".gitignore" && v.message.includes("whole line"))).toBe(true);
  });
});

describe("Guard 5 — local-analysis-files (design §4.1)", () => {
  it("reports zero violations for the real repo (both files untracked and gitignored)", async () => {
    const violations = await runLocalAnalysisFilesGuard(repoRoot);
    expect(violations).toEqual([]);
  });

  it("goes red on a temp git repo where a local-only analysis file is committed and not gitignored", async () => {
    const dir = makeTempDir("guard5-fixture-");
    initTempGitRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
    writeFileSync(path.join(dir, "JENKINS_REPLACEMENT_AKILI_CONTEXT.md"), "local analysis, never published\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "test fixture"], { cwd: dir });

    const violations = await runLocalAnalysisFilesGuard(dir);
    expect(violations.some((v) => v.message.includes("is tracked by git"))).toBe(true);
    expect(violations.some((v) => v.message.includes("does not list"))).toBe(true);
  });

  it("goes red when .gitignore only MENTIONS the filename in a comment (not a whole, real entry)", async () => {
    const dir = makeTempDir("guard5-gitignore-substring-");
    initTempGitRepo(dir);
    writeFileSync(
      path.join(dir, ".gitignore"),
      "# JENKINS_REPLACEMENT_AKILI_CONTEXT.md is kept out intentionally\nnode_modules/\n",
      "utf8",
    );

    const violations = await runLocalAnalysisFilesGuard(dir);
    expect(
      violations.some(
        (v) => v.file === ".gitignore" && v.message.includes('"JENKINS_REPLACEMENT_AKILI_CONTEXT.md"'),
      ),
    ).toBe(true);
  });
});

describe("Guard 6 — extensibility-fixture (NFR-08)", () => {
  it("validates the fictitious second definition (atlas-sync) with no code changes", async () => {
    const violations = await runExtensibilityFixtureGuard(repoRoot);
    expect(violations).toEqual([]);
  });

  it("goes red when the fictitious definition is broken (environment=prod)", async () => {
    const dir = makeTempDir("guard6-fixture-");
    const realFixturePath = path.join(
      repoRoot,
      "executor",
      "test",
      "fixtures",
      "nfr08-second-definition",
      "deployment.yaml",
    );
    const brokenText = readFileSync(realFixturePath, "utf8").replace("environment: dev", "environment: prod");
    const brokenPath = path.join(dir, "deployment.yaml");
    writeFileSync(brokenPath, brokenText, "utf8");

    const violations = await runExtensibilityFixtureGuard(repoRoot, { deploymentYamlPath: brokenPath });
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("Guard 4 — publication-policy covers .github/workflows (N-19)", () => {
  it("tolerates a repo without a .github/workflows directory", async () => {
    const dir = makeTempDir("guard4-no-workflows-");
    initTempGitRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), ".local/\n", "utf8");
    expect(await runPublicationPolicyGuard(dir)).toEqual([]);
  });

  it("goes red on an account-ID-shaped literal in a workflow file", async () => {
    const dir = makeTempDir("guard4-workflow-leak-");
    initTempGitRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), ".local/\n", "utf8");
    mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      path.join(dir, ".github", "workflows", "deploy-request.reusable.yml"),
      `role-to-assume: arn:aws:iam::${ACCOUNT_ID_SHAPED}:role/x\n`,
      "utf8",
    );
    const violations = await runPublicationPolicyGuard(dir);
    expect(
      violations.some(
        (v) => v.file === ".github/workflows/deploy-request.reusable.yml" && v.message.includes("aws-account-id"),
      ),
    ).toBe(true);
  });
});

describe("Guard 7 — action-pinning (FR-22, DD-29)", () => {
  function runOn(yamlText: string | undefined) {
    const dir = makeTempDir("guard7-fixture-");
    if (yamlText !== undefined) {
      mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(path.join(dir, ".github", "workflows", "deploy-request.reusable.yml"), yamlText, "utf8");
    }
    return runActionPinningGuard(dir);
  }
  const stepWorkflow = (uses: string) =>
    `on: workflow_call\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: x\n        uses: ${uses}\n`;

  it("reports zero violations for the real repository (workflow absent or compliant)", async () => {
    expect(await runActionPinningGuard(repoRoot)).toEqual([]);
  });

  it("passes with a note when no reusable workflow exists", async () => {
    expect(await runOn(undefined)).toEqual([]);
  });

  it.each([
    ["a tag (@v4)", "actions/checkout@v4"],
    ["@main", "actions/checkout@main"],
    ["@master", "actions/checkout@master"],
    ["a branch name (@release/1.x)", "actions/checkout@release/1.x"],
    ["a 7-char short SHA", "actions/checkout@abcdef0"],
    ["an unpinned ref (no @)", "actions/checkout"],
    ["a docker tag", "docker://alpine:3.20"],
    ["a docker short digest", "docker://alpine@sha256:abcdef"],
    ["an upper-case 40-hex ref", `actions/checkout@${SHA.toUpperCase()}`],
  ])("goes red on %s", async (_label, uses) => {
    const violations = await runOn(stepWorkflow(uses));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      guard: "action-pinning",
      file: ".github/workflows/deploy-request.reusable.yml",
      line: 7,
    });
  });

  it("goes red on a quoted mutable ref and on a job-level reusable-workflow call by tag", async () => {
    const violations = await runOn(
      `on: workflow_call\njobs:\n  call:\n    uses: "org/repo/.github/workflows/w.yml@v1"\n  other:\n    steps:\n      - uses: 'actions/checkout@v4'\n`,
    );
    expect(violations.map((v) => v.line)).toEqual([4, 7]);
  });

  it("goes red on unparseable YAML", async () => {
    const violations = await runOn("jobs: [unclosed\n");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("not parseable");
  });

  it.each([
    ["a full SHA with a trailing version comment", `actions/checkout@${SHA} # v4.1.0`],
    ["a full SHA, quoted", `"actions/checkout@${SHA}"`],
    ["a sub-path action pinned by SHA", `org/repo/sub/dir@${SHA}`],
    ["a docker digest", `docker://alpine@sha256:${SHA}${SHA.slice(0, 24)}`],
    ["a local action", "./local-action"],
  ])("passes %s", async (_label, uses) => {
    expect(await runOn(stepWorkflow(uses))).toEqual([]);
  });

  it("passes a job-level reusable workflow call pinned by SHA and ignores 'uses:' text in run scripts and comments", async () => {
    const violations = await runOn(
      [
        "on: workflow_call",
        "jobs:",
        "  call:",
        `    uses: org/repo/.github/workflows/w.yml@${SHA} # v1.2.3`,
        "  s:",
        "    steps:",
        "      # uses: actions/checkout@v4",
        "      - run: |",
        "          echo 'uses: actions/checkout@v4'",
        "",
      ].join("\n"),
    );
    expect(violations).toEqual([]);
  });
});

describe("Guard 7 — action-pinning hardening (N-19 attempt 2)", () => {
  function workflowDir(fileName: string, text: string): string {
    const dir = makeTempDir("guard7-hardening-");
    mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(dir, ".github", "workflows", fileName), text, "utf8");
    return dir;
  }
  const bad = (uses: string, key = "uses") =>
    `on: workflow_call\njobs:\n  b:\n    steps:\n      - ${key}: ${uses}\n`;

  it("goes red on a parent-relative local path (../x); only ./ is exempt", async () => {
    const violations = await runActionPinningGuard(workflowDir("w.reusable.yml", bad("../evil")));
    expect(violations).toHaveLength(1);
  });

  it("goes red on a case-variant key (Uses:)", async () => {
    const violations = await runActionPinningGuard(workflowDir("w.reusable.yml", bad("actions/checkout@v4", "Uses")));
    expect(violations).toHaveLength(1);
  });

  it("scans *.reusable.yaml as well as *.reusable.yml", async () => {
    const violations = await runActionPinningGuard(workflowDir("w.reusable.yaml", bad("actions/checkout@v4")));
    expect(violations.map((v) => v.file)).toEqual([".github/workflows/w.reusable.yaml"]);
  });

  it("strict mode fails when no reusable workflow is present; default passes", async () => {
    const dir = makeTempDir("guard7-strict-");
    expect(await runActionPinningGuard(dir)).toEqual([]);
    const violations = await runActionPinningGuard(dir, { requireWorkflow: true });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("strict");
  });
});
