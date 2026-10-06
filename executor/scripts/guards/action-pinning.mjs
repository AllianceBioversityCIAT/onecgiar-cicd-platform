// @akili-spec changes/cicd-executor-poc requirements FR-22, FR-25, NFR-01, NFR-02; design DD-29, DD-24
//
// Guard 7 (N-19): every `uses:` inside the trusted reusable workflow
// (.github/workflows/*.reusable.yml or .yaml) must be immutable (owner security rule,
// 2026-10-06):
//   (a) `owner/repo[/path]@<40-hex commit SHA>` — a trailing `# vX.Y.Z`
//       comment is allowed and encouraged, never required;
//   (b) `docker://<image>@sha256:<64-hex>` — digest-pinned;
//   (c) a local `./…` path (the only exemption).
// Tags (including `@v4`), branches and short SHAs are mutable and rejected.
// `uses:` is checked at step level and at job level (a job-level `uses:`
// calls another reusable workflow, which is equally trusted code).
//
// The workflow is parsed as YAML (so a `uses:` word inside a `run:` script or
// a comment is not mistaken for a reference). If the directory or no
// `*.reusable.y{a,}ml` exists the guard PASSES with a note (N-21 creates the workflow).
// STRICT mode (N-22 / CI): env CICD_REQUIRE_REUSABLE_WORKFLOW=1, `--require-workflow`
// on run-all.mjs, or `{ requireWorkflow: true }` makes an absent workflow a violation.
// `uses` keys match case-insensitively (fail closed).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LineCounter, isPair, isScalar, parseDocument, visit } from "yaml";
import { mask } from "./lib/report.mjs";

const ACTION_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_REF = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
// DD-29: `./` is the ONLY local exemption; `../` could escape the trusted checkout.
const LOCAL_REF = /^\.\//;

/** @returns {string | undefined} a reason when the reference is not immutable, else undefined. */
export function classifyUses(value) {
  if (typeof value !== "string") return "`uses:` must be a plain string";
  const ref = value.trim();
  if (LOCAL_REF.test(ref)) return undefined;
  if (ref.startsWith("docker://")) {
    return DOCKER_REF.test(ref) ? undefined : "docker:// reference is not pinned by `@sha256:<64-hex>` digest";
  }
  if (ACTION_REF.test(ref)) return undefined;
  return "reference is not pinned by a full 40-hex commit SHA (tags such as @v4, branches and short SHAs are mutable)";
}

/**
 * @param {string} repoRoot
 * @param {{ workflowsDir?: string, requireWorkflow?: boolean }} [overrides]
 * @returns {Promise<Array<{guard: string, file: string, line?: number, message: string}>> & { notes?: string[] }}
 */
export async function runActionPinningGuard(repoRoot, overrides = {}) {
  const workflowsDir = overrides.workflowsDir ?? path.join(repoRoot, ".github", "workflows");
  const files = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((n) => /\.reusable\.ya?ml$/.test(n)).sort()
    : [];
  const violations = [];
  if (files.length === 0) {
    const strict = overrides.requireWorkflow ?? process.env.CICD_REQUIRE_REUSABLE_WORKFLOW === "1";
    if (strict) {
      violations.push({
        guard: "action-pinning",
        file: ".github/workflows",
        message: "no *.reusable.yml or *.reusable.yaml found, but strict mode requires the trusted workflow (N-22, DD-29)",
      });
      return violations;
    }
    // Informational only; run-all prints it. N-22 requires the workflow to exist.
    console.log("      action-pinning: no reusable workflow found under .github/workflows (N-21 creates it; N-22 requires it).");
    return violations;
  }

  for (const name of files) {
    const rel = path.relative(repoRoot, path.join(workflowsDir, name)).split(path.sep).join("/");
    const lineCounter = new LineCounter();
    const doc = parseDocument(readFileSync(path.join(workflowsDir, name), "utf8"), { lineCounter });
    if (doc.errors.length > 0) {
      violations.push({
        guard: "action-pinning",
        file: rel,
        message: `workflow is not parseable YAML (${doc.errors[0].message.split("\n")[0]}); cannot verify action pinning`,
      });
      continue;
    }
    visit(doc, {
      Pair(_key, pair) {
        if (!isPair(pair) || !isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value.toLowerCase() !== "uses") return;
        // Only mapping entries named `uses` (a step or a job); other `uses` keys are not references.
        const value = isScalar(pair.value) ? pair.value.value : undefined;
        const reason = classifyUses(value);
        if (reason === undefined) return;
        const offset = pair.key.range?.[0] ?? 0;
        violations.push({
          guard: "action-pinning",
          file: rel,
          line: lineCounter.linePos(offset).line,
          message: `\`uses:\` ${typeof value === "string" ? mask(value) : "(non-string)"}: ${reason} (DD-29)`,
        });
      },
    });
  }
  return violations;
}
