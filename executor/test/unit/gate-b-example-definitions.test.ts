// @akili-spec changes/cicd-executor-poc design §6.2, DD-23
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDefinitionsCheck } from "../../src/tools/definitions-check/index.js";
import { repoRoot } from "../contract/support/schema-paths.js";

const exampleRoot = path.join(repoRoot, "docs", "gate-b", "examples", "definitions");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe("Gate B example definitions", () => {
  it("passes definitions:check (exit 0) as shipped", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDefinitionsCheck(["--root", exampleRoot], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      fallbackRoot: repoRoot,
    });
    expect({ code, out, err }).toMatchObject({ code: 0 });
    expect(out.some((l) => l.startsWith("FAIL "))).toBe(false);
  });

  it("contains no real identifiers and no project-specific names (publication policy)", () => {
    const files = walk(exampleRoot);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(exampleRoot, file);
      expect(text, `${rel}: 12-digit number`).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
      expect(text, `${rel}: IPv4`).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(text, `${rel}: amazonaws.com host`).not.toMatch(/amazonaws\.com/i);
      expect(text, `${rel}: project name`).not.toMatch(/prms|marlo|aiccra|tanzania|jenkins/i);
    }
  });

  it("documents every <EXAMPLE_*> ref used by the YAML files in the README", () => {
    const readme = readFileSync(path.join(exampleRoot, "README.md"), "utf8");
    const refs = new Set<string>();
    for (const file of walk(exampleRoot).filter((f) => f.endsWith(".yaml"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/<EXAMPLE_[A-Z0-9_]+>/g)) refs.add(m[0]);
    }
    expect(refs.size).toBeGreaterThan(10);
    for (const ref of refs) expect(readme, ref).toContain(ref);
  });
});
