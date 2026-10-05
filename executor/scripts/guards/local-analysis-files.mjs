// @akili-spec changes/cicd-executor-poc design §4.1 (publication policy)
//
// Guard 5: the two local-only analysis files
// (JENKINS_REPLACEMENT_AKILI_CONTEXT.md, JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md)
// must never be tracked, never be staged, and must always be listed in
// .gitignore. This guard never reads their contents (only `git ls-files`,
// `git diff --cached --name-only` and the .gitignore text are consulted).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gitignoreHasExactEntry } from "./lib/gitignore.mjs";

const LOCAL_ONLY_FILES = [
  "JENKINS_REPLACEMENT_AKILI_CONTEXT.md",
  "JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md",
];

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

export async function runLocalAnalysisFilesGuard(repoRoot) {
  const violations = [];

  const tracked = new Set(
    git(repoRoot, ["ls-files"])
      .split(/\r?\n/)
      .filter(Boolean),
  );
  const staged = new Set(
    git(repoRoot, ["diff", "--cached", "--name-only"])
      .split(/\r?\n/)
      .filter(Boolean),
  );
  const gitignoreText = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");

  for (const fileName of LOCAL_ONLY_FILES) {
    if (tracked.has(fileName)) {
      violations.push({
        guard: "local-analysis-files",
        file: fileName,
        message: "is tracked by git (git ls-files) — local-only analysis files must never be committed (design §4.1)",
      });
    }
    if (staged.has(fileName)) {
      violations.push({
        guard: "local-analysis-files",
        file: fileName,
        message: "is staged (git diff --cached --name-only) — local-only analysis files must never be committed (design §4.1)",
      });
    }
    if (!gitignoreHasExactEntry(gitignoreText, fileName)) {
      violations.push({
        guard: "local-analysis-files",
        file: ".gitignore",
        message: `does not list "${fileName}" as a whole gitignore line (design §4.1 requires it to stay local-only)`,
      });
    }
  }

  return violations;
}
