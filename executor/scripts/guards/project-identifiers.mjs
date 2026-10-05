// @akili-spec changes/cicd-executor-poc requirements NFR-01, NFR-08; design §4.2
//
// Guard 2: the Executor's own code must contain zero occurrences of a real
// project/application identifier (NFR-01: "contains no per-project or
// per-application code branches"). A pipeline's `project` value is DATA the
// Executor reads from a definition at runtime (DD-19); the moment a literal
// like `if (project === "prms")` appears in code, the Executor has started
// branching on a specific customer's identity instead of staying generic —
// the exact "another Jenkins" failure mode this guard exists to catch.
// Scope: `executor/src` (every line) and `deploy-scripts/**/*.sh` (CODE
// lines only — a shell comment mentioning a project name in prose, e.g.
// documenting what the script must stay generic ABOUT, is not itself a
// boundary violation; tasks.md's T-14 risk entry expects this coverage).
//
// Denylist provenance (read 2026-10-05 from
// docs/specs/changes/cicd-executor-poc/proposal.md, exact line numbers via
// `grep -n`): every entry is a project/application name the proposal cites
// by name. Two match MODES:
//
//   - "word": `\bTERM\b` anywhere on the line (case-insensitive). Used for
//     every DISTINCTIVE term (never an ordinary English/technical word), so
//     a bare mention anywhere — code, string, or comment — is still a hit.
//   - "quoted": TERM only when the ENTIRE contents of a quoted string is
//     exactly that term (`['"`]TERM['"`]`, case-insensitive) — i.e. a
//     "code-shaped token" like `project === 'risk'` or `pipelineId: "bi"`.
//     Used for the handful of terms that are ALSO ordinary English/
//     technical words (reviewer round-1 finding: excluding them outright is
//     not acceptable — the disqualifier is "the denylist must be the
//     projects cited in the proposal" — but matching them as bare words
//     would flag routine prose like "risk of a race condition",
//     "monitoring the state machine", or "bi-directional" with a very high
//     false-positive rate). Restricting the match to an exact quoted
//     literal keeps the real attack surface covered (a project id can only
//     ever reach the Executor as string DATA — see requirements FR-01, the
//     `semanticId` schema pattern) while prose stays unflagged.
//
//   - "prms" (word): proposal.md:75 ("CodeBuild `prms-reporting-dev`"),
//     proposal.md:300 ("project: prms-reporting").
//   - "prms-reporting" (word): proposal.md:300.
//   - "tanzania" (word): proposal.md:56,493 (TANZANIA dev against RDS).
//   - "aiccra" (word): proposal.md:387,788 (an AICCRA pipeline).
//   - "marlo" (word): proposal.md:786 (MARLO landing).
//   - "marlo-v2" (word): proposal.md:790 (MARLO-V2 dev-lambda).
//   - "ibd" (word): proposal.md:786 (RISK, TANZANIA, IBD, and MARLO landing).
//   - "ai-insights" (word): proposal.md:790 (IA ai-insights).
//   - "innovation-catalog" (word): proposal.md:791 ("sed over the source
//     (INNOVATION-CATALOG)").
//   - "clarisa" (word): proposal.md:491 ("Unconditional on the target
//     (ALLIANCE-INDICATORS, CLARISA v2)").
//   - "alliance-indicators" (word): proposal.md:491.
//   - "risk" (quoted): proposal.md:56 ("RISK does it via Lambda"),
//     493–494 ("RISK pattern" / "Via Lambda (RISK)"), 786 ("RISK, TANZANIA,
//     IBD..."), 875 ("...TANZANIA, RISK, PRMS reporting prod"). Reviewer
//     round-1 finding: excluding this bare word entirely let
//     `if (project === 'risk')` through undetected — fixed via quoted mode.
//   - "monitoring" (quoted): proposal.md:789 ("*branch-tip gating* with
//     `git rev-list` (MONITORING)"). Same reviewer finding/fix as "risk".
//   - "bi" (quoted): proposal.md:874 ("a static pipeline from
//     INNOVATION-CATALOG or BI"). Word mode is unusable for a 2-letter
//     token — `\bbi\b` matches inside "bi-directional"/"bi-weekly" because
//     a hyphen is a non-word character (a false boundary); quoted mode
//     requires the ENTIRE string literal to be exactly "bi", which prose
//     never produces.
//
// Deliberately EXCLUDED, with justification (narrowing — not a hidden real
// hit): "swarm" is also cited by the proposal (line 788, "two AICCRA and
// Swarm pipelines"; also "P7 Swarm" deploy-pattern rows and literal `docker
// swarm leave` commands elsewhere), but every one of those citations names
// the DEPLOYMENT TECHNOLOGY (Docker Swarm), never a project/application —
// unlike "risk"/"monitoring"/"bi" above, there is no proposal.md citation
// where "Swarm" stands for a customer project. A generic Docker Swarm
// reference in Executor code would be an infra/runtime concern, not
// per-project logic, so it stays out of this denylist.
const DENYLIST = [
  { term: "prms", mode: "word", citation: "proposal.md:75,300 (CodeBuild/project `prms-reporting(-dev)`)" },
  { term: "prms-reporting", mode: "word", citation: "proposal.md:300 (project: prms-reporting)" },
  { term: "tanzania", mode: "word", citation: "proposal.md:56,493 (TANZANIA dev against RDS)" },
  { term: "aiccra", mode: "word", citation: "proposal.md:387,788 (an AICCRA pipeline)" },
  { term: "marlo", mode: "word", citation: "proposal.md:786 (MARLO landing)" },
  { term: "marlo-v2", mode: "word", citation: "proposal.md:790 (MARLO-V2 dev-lambda)" },
  { term: "ibd", mode: "word", citation: "proposal.md:786 (RISK, TANZANIA, IBD, and MARLO landing)" },
  { term: "ai-insights", mode: "word", citation: "proposal.md:790 (IA ai-insights)" },
  { term: "innovation-catalog", mode: "word", citation: "proposal.md:791 (sed over the source (INNOVATION-CATALOG))" },
  {
    term: "clarisa",
    mode: "word",
    citation: "proposal.md:491 (Unconditional on the target (ALLIANCE-INDICATORS, CLARISA v2))",
  },
  { term: "alliance-indicators", mode: "word", citation: "proposal.md:491 (ALLIANCE-INDICATORS, CLARISA v2)" },
  { term: "risk", mode: "quoted", citation: "proposal.md:56,493,494,786,875 (RISK project/pattern)" },
  {
    term: "monitoring",
    mode: "quoted",
    citation: "proposal.md:789 (branch-tip gating with git rev-list (MONITORING))",
  },
  { term: "bi", mode: "quoted", citation: "proposal.md:874 (a static pipeline from INNOVATION-CATALOG or BI)" },
];

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern({ term, mode }) {
  const escaped = escapeRegExp(term);
  if (mode === "quoted") {
    // The ENTIRE quoted literal must be exactly TERM (backreference to the
    // SAME quote character on both sides) — a "code-shaped token", not a
    // substring inside ordinary prose.
    return new RegExp(`(['"\`])${escaped}\\1`, "i");
  }
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function listFilesRecursively(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Scans every file under `targetDir` for a denylisted project/application
 * identifier. Exported standalone (not just as the default-wired guard) so
 * boundary-guards.test.ts can point it at a temp fixture directory instead
 * of mutating the real repository tree.
 *
 * @param {string} targetDir
 * @param {readonly {term: string, mode?: "word"|"quoted", citation: string}[]} [denylist]
 * @param {{isCommentLine?: (line: string) => boolean, fileFilter?: (absPath: string) => boolean}} [options]
 *   `isCommentLine`: lines for which it returns true are SKIPPED (default:
 *   never skip — every line is scanned, matching executor/src's "anywhere,
 *   including comments" policy). `fileFilter`: only files for which it
 *   returns true (default: every file) are scanned — used to restrict the
 *   deploy-scripts/ pass to `*.sh` files.
 */
export function scanForProjectIdentifiers(targetDir, denylist = DENYLIST, options = {}) {
  const { isCommentLine = () => false, fileFilter = () => true } = options;
  const violations = [];
  const compiled = denylist.map((entry) => ({ ...entry, pattern: buildPattern(entry) }));

  for (const file of listFilesRecursively(targetDir)) {
    if (!fileFilter(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // binary or unreadable file: not a source-code hit
    }
    const lines = text.split(/\r?\n/);
    const relFile = path.relative(targetDir, file).split(path.sep).join("/");
    lines.forEach((lineText, index) => {
      if (isCommentLine(lineText)) return;
      for (const { term, mode, citation, pattern } of compiled) {
        if (pattern.test(lineText)) {
          const modeNote = mode === "quoted" ? " (as a quoted string literal)" : "";
          violations.push({
            guard: "project-identifiers",
            file: relFile,
            line: index + 1,
            message: `contains denylisted project/application identifier "${term}"${modeNote} (NFR-01; denylist provenance: ${citation})`,
          });
        }
      }
    });
  }
  return violations;
}

const isShellCommentLine = (line) => /^\s*#/.test(line);
const isShellScriptFile = (absPath) => absPath.endsWith(".sh");

export async function runProjectIdentifiersGuard(repoRoot) {
  const srcDir = path.join(repoRoot, "executor", "src");
  const srcViolations = scanForProjectIdentifiers(srcDir, DENYLIST).map((v) => ({
    ...v,
    file: `executor/src/${v.file}`,
  }));

  const deployScriptsDir = path.join(repoRoot, "deploy-scripts");
  const deployScriptViolations = scanForProjectIdentifiers(deployScriptsDir, DENYLIST, {
    isCommentLine: isShellCommentLine,
    fileFilter: isShellScriptFile,
  }).map((v) => ({ ...v, file: `deploy-scripts/${v.file}` }));

  return [...srcViolations, ...deployScriptViolations];
}

export { DENYLIST };
