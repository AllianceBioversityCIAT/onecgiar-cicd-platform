// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §15 (obsolescence list), AC-01
//
// Guard 8 (N-01): every design §15 DELETE path is tracked here as either
//   - DELETED: the path must not exist and nothing under executor/src,
//     executor/test, ingress or scripts may import it (a guard that only
//     checked existence would let a re-added import slip through), or
//   - PENDING: the path still has importers; it is listed with the task that
//     owns its removal. PENDING entries are printed but never fail the guard
//     (task N-22 requires the PENDING list to be empty before closing Gate A).
// Entries may be a whole path (file or directory) or, with `symbol`, a single
// exported symbol inside a file (symbol-level entries are text-matched).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Roots (relative to the repo root) scanned for importers of DELETED paths. */
const SCAN_ROOTS = ["executor/src", "executor/test", "ingress", "scripts"];
const SOURCE_EXTENSIONS = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);

/** @typedef {{ path: string, status: "DELETED" | "PENDING", owner?: string, symbol?: string, reason?: string }} ObsolescenceEntry */

/** @type {ObsolescenceEntry[]} */
export const OBSOLESCENCE_ENTRIES = [
  // DELETED now (no surviving importer)
  { path: "ingress/github-webhook", status: "DELETED" },
  { path: "executor/src/adapters/git-cli-client", status: "DELETED" },
  { path: "executor/src/adapters/s3-artifact-store", status: "DELETED" },
  { path: "executor/src/adapters/zip-packager", status: "DELETED" },
  { path: "executor/src/adapters/handlers/lambda", status: "DELETED" },
  { path: "executor/src/adapters/handlers/codebuild", status: "DELETED" },
  { path: "executor/src/adapters/handlers/notify", status: "DELETED" },
  { path: "executor/src/ports/artifact-store.ts", status: "DELETED" },
  { path: "executor/src/ports/git-client.ts", status: "DELETED" },
  { path: "executor/src/application/step-dispatcher", status: "DELETED" },
  // PENDING (still imported; owner task removes them)
  { path: "executor/src/domain/planner", status: "PENDING", owner: "N-04" },
  { path: "executor/test/unit/planner.test.ts", status: "PENDING", owner: "N-04" },
  { path: "schemas/pipeline.schema.json", status: "PENDING", owner: "N-03" },
  { path: "pipeline-definitions", status: "PENDING", owner: "N-03" },
  { path: "executor/test/contract/pipeline-schema.contract.test.ts", status: "PENDING", owner: "N-03" },
  { path: "executor/test/unit/definition-service.substitution.test.ts", status: "PENDING", owner: "N-03" },
  { path: "executor/src/domain/events/index.ts", symbol: "normalizeLambdaDestinationsRecord", status: "PENDING", owner: "N-05" },
  { path: "executor/src/domain/events/index.ts", symbol: "normalizeCodeBuildStateChangeEvent", status: "PENDING", owner: "N-05" },
  { path: "executor/test/unit/event-normalizers.test.ts", status: "PENDING", owner: "N-05" },
  { path: "executor/test/fixtures/aws", status: "PENDING", owner: "N-05" },
  { path: "executor/src/domain/lock-policy/index.ts", symbol: "evaluateSupersede", status: "PENDING", owner: "N-07" },
  { path: "executor/src/adapters/dynamodb-state-store/step-repository.ts", status: "PENDING", owner: "N-08" },
  { path: "executor/src/adapters/dynamodb-state-store/step-attempt-lookup.ts", status: "PENDING", owner: "N-08" },
  { path: "executor/src/adapters/dynamodb-state-store/instance-lease-repository.ts", status: "PENDING", owner: "N-08" },
  { path: "executor/test/integration/step-repository.transition.int.test.ts", status: "PENDING", owner: "N-08" },
  { path: "executor/src/ports/step-handler.ts", status: "PENDING", owner: "N-12" },
];

const stripExtension = (p) => p.replace(/\.(?:d\.)?(?:ts|mts|cts|tsx|js|mjs|cjs)$/, "");
const toPosix = (p) => p.split(path.sep).join("/");

function* walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else if (SOURCE_EXTENSIONS.test(name)) yield full;
  }
}

const SPECIFIER = /(?:\bfrom|\bimport|\brequire|\bmock|\bimportActual)\s*\(?\s*["']([^"']+)["']/g;

/** True when `resolved` (repo-relative, extensionless) lies at or under the entry path. */
function isUnderEntry(resolved, entryPath) {
  const entry = stripExtension(entryPath);
  return resolved === entry || resolved.startsWith(`${entry}/`);
}

function collectImporters(repoRoot, deletedEntries) {
  const pathEntries = deletedEntries.filter((e) => !e.symbol);
  const hits = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(repoRoot, root))) {
      const rel = toPosix(path.relative(repoRoot, file));
      // A file inside a deleted path is not a "surviving importer".
      if (pathEntries.some((e) => isUnderEntry(stripExtension(rel), e.path))) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, index) => {
        for (const match of text.matchAll(SPECIFIER)) {
          const specifier = match[1];
          if (!specifier.startsWith(".")) continue;
          const resolved = stripExtension(toPosix(path.relative(repoRoot, path.resolve(path.dirname(file), specifier))));
          for (const entry of pathEntries) {
            if (isUnderEntry(resolved, entry.path)) hits.push({ file: rel, line: index + 1, entry });
          }
        }
      });
    }
  }
  return hits;
}

/**
 * @param {string} repoRoot
 * @param {ObsolescenceEntry[]} [entries]
 */
export async function runObsolescenceGuard(repoRoot, entries = OBSOLESCENCE_ENTRIES) {
  const violations = [];
  const deleted = entries.filter((e) => e.status === "DELETED");

  for (const entry of deleted) {
    const abs = path.join(repoRoot, entry.path);
    if (entry.symbol) {
      if (existsSync(abs) && new RegExp(`\\b${entry.symbol}\\b`).test(readFileSync(abs, "utf8"))) {
        violations.push({
          guard: "obsolescence",
          file: entry.path,
          message: `symbol "${entry.symbol}" is marked DELETED (design §15) but still appears in this file`,
        });
      }
    } else if (existsSync(abs) || existsSync(`${abs}.ts`)) {
      violations.push({
        guard: "obsolescence",
        file: entry.path,
        message: "is marked DELETED (design §15, AC-01) but still exists",
      });
    }
  }

  for (const hit of collectImporters(repoRoot, deleted)) {
    violations.push({
      guard: "obsolescence",
      file: hit.file,
      line: hit.line,
      message: `imports DELETED path "${hit.entry.path}" (design §15, AC-01)`,
    });
  }
  return violations;
}

/**
 * PENDING entries (informational, never a violation): what is still tracked,
 * with the owner task that must remove it.
 * @param {string} repoRoot
 * @param {ObsolescenceEntry[]} [entries]
 */
export function listPendingObsolescence(repoRoot, entries = OBSOLESCENCE_ENTRIES) {
  return entries
    .filter((e) => e.status === "PENDING")
    .map((e) => ({
      path: e.path,
      symbol: e.symbol,
      owner: e.owner ?? "UNOWNED",
      present: existsSync(path.join(repoRoot, e.path)),
    }));
}
