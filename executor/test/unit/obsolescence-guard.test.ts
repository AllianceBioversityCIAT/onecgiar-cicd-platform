// @akili-spec changes/cicd-executor-poc requirements NFR-01; design §15
//
// N-01: negative tests for guard 8 (obsolescence). Every mutation happens in
// a TEMP directory, never in the real repository tree.
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "../contract/support/schema-paths.js";
import {
  OBSOLESCENCE_ENTRIES,
  listPendingObsolescence,
  runObsolescenceGuard,
  type ObsolescenceEntry,
} from "../../scripts/guards/obsolescence.mjs";

const tempDirs: string[] = [];

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "obsolescence-guard-"));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

const DELETED_ENTRIES: ObsolescenceEntry[] = [
  { path: "executor/src/adapters/git-cli-client", status: "DELETED" },
  { path: "executor/src/ports/git-client.ts", status: "DELETED" },
];

describe("obsolescence guard (N-01)", () => {
  it("passes on a tree where DELETED paths are gone and unimported", async () => {
    const root = makeTree({ "executor/src/main/index.ts": 'import { x } from "../ports/clock.js";\nexport { x };\n' });
    expect(await runObsolescenceGuard(root, DELETED_ENTRIES)).toEqual([]);
  });

  it("fails when a DELETED directory path still exists", async () => {
    const root = makeTree({ "executor/src/adapters/git-cli-client/index.ts": "export {};\n" });
    const violations = await runObsolescenceGuard(root, DELETED_ENTRIES);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("executor/src/adapters/git-cli-client");
    expect(violations[0]?.message).toContain("still exists");
  });

  it("fails when a DELETED file path still exists", async () => {
    const root = makeTree({ "executor/src/ports/git-client.ts": "export {};\n" });
    const violations = await runObsolescenceGuard(root, DELETED_ENTRIES);
    expect(violations.map((v) => v.file)).toEqual(["executor/src/ports/git-client.ts"]);
  });

  it("fails when a surviving file imports a DELETED path that no longer exists (existence-only checks would miss this)", async () => {
    const root = makeTree({
      "executor/src/main/index.ts": 'import { GitCliClient } from "../adapters/git-cli-client/index.js";\nexport { GitCliClient };\n',
    });
    const violations = await runObsolescenceGuard(root, DELETED_ENTRIES);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: "executor/src/main/index.ts", line: 1 });
    expect(violations[0]?.message).toContain("imports DELETED path");
  });

  it("fails on a barrel re-export of a DELETED port and on tests importing it", async () => {
    const root = makeTree({
      "executor/src/ports/index.ts": 'export type { GitClient } from "./git-client.js";\n',
      "executor/test/unit/x.test.ts": ["const m = await imp", 'ort("../../src/ports/git-client.js");\nvoid m;\n'].join(""),
    });
    const violations = await runObsolescenceGuard(root, DELETED_ENTRIES);
    expect(violations.map((v) => v.file).sort()).toEqual(["executor/src/ports/index.ts", "executor/test/unit/x.test.ts"]);
  });

  it.each(["vi.doMock", "vi.importMock", "vi.mock"])("fails when %s targets a DELETED path", async (call) => {
    // Specifier assembled at runtime so this file never carries a literal one of its own.
    const specifier = ["../../src/ports/git-", "client.js"].join("");
    const root = makeTree({ "executor/test/unit/y.test.ts": `${call}("${specifier}");\n` });
    const violations = await runObsolescenceGuard(root, DELETED_ENTRIES);
    expect(violations.map((v) => v.file)).toEqual(["executor/test/unit/y.test.ts"]);
  });

  it("scans executor/scripts for importers and no longer scans the stale scripts/ingress roots", async () => {
    const importer = ["import x from ", `"${["../../src/ports/git-", "client.js"].join("")}";\n`].join("");
    const scanned = makeTree({ "executor/scripts/guards/x.mjs": importer });
    const hits = await runObsolescenceGuard(scanned, DELETED_ENTRIES);
    expect(hits.map((v) => v.file)).toEqual(["executor/scripts/guards/x.mjs"]);
    const stale = makeTree({ "scripts/x.mjs": importer, "ingress/x.mjs": importer });
    expect(await runObsolescenceGuard(stale, DELETED_ENTRIES)).toEqual([]);
  });

  it("fails when a DELETED symbol-level entry still appears in its file", async () => {
    const root = makeTree({ "executor/src/domain/lock-policy/index.ts": "export function evaluateSupersede() {}\n" });
    const entries: ObsolescenceEntry[] = [
      { path: "executor/src/domain/lock-policy/index.ts", symbol: "evaluateSupersede", status: "DELETED" },
    ];
    const violations = await runObsolescenceGuard(root, entries);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("evaluateSupersede");
  });

  it("does not fail on PENDING entries, even when present and imported, and lists them with owners", async () => {
    const root = makeTree({
      "executor/src/domain/planner/index.ts": "export {};\n",
      "executor/src/main/index.ts": 'import "../domain/planner/index.js";\n',
    });
    const entries: ObsolescenceEntry[] = [{ path: "executor/src/domain/planner", status: "PENDING", owner: "N-04" }];
    expect(await runObsolescenceGuard(root, entries)).toEqual([]);
    expect(listPendingObsolescence(root, entries)).toEqual([
      { path: "executor/src/domain/planner", symbol: undefined, owner: "N-04", present: true },
    ]);
  });

  it("every PENDING entry in the real manifest names an owner task", () => {
    for (const entry of OBSOLESCENCE_ENTRIES.filter((e) => e.status === "PENDING")) {
      expect(entry.owner, entry.path).toMatch(/^N-\d+$/);
    }
  });

  it("passes on the real repository tree", async () => {
    expect(await runObsolescenceGuard(repoRoot)).toEqual([]);
  });
});
