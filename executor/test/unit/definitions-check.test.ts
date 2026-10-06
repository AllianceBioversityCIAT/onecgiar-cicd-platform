// @akili-spec changes/cicd-executor-poc design §6.2, DD-19
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDefinitionsCheck } from "../../src/tools/definitions-check/index.js";
import { repoRoot } from "../contract/support/schema-paths.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function copyDefinitions(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "defs-check-"));
  temps.push(dir);
  cpSync(path.join(repoRoot, "deployment-definitions"), path.join(dir, "deployment-definitions"), { recursive: true });
  return dir;
}

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDefinitionsCheck(argv, { out: (l) => out.push(l), err: (l) => err.push(l), fallbackRoot: repoRoot });
  return { code, out, err };
}

describe("definitions:check", () => {
  it("passes (exit 0) on a valid copy of the committed definitions, using the repository schemas", async () => {
    const r = await run(["--root", copyDefinitions()]);
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.startsWith("OK "))).toBe(true);
    expect(r.out.some((l) => l.startsWith("FAIL "))).toBe(false);
  });

  it("fails (exit 1) naming the file and the reason when a required field is removed", async () => {
    const dir = copyDefinitions();
    const prmsDir = path.join(dir, "deployment-definitions", "prms");
    const file = path.join(prmsDir, readdirSync(prmsDir)[0]!);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^deployScript:.*$/m, ""));
    const r = await run(["--root", dir]);
    expect(r.code).toBe(1);
    const text = r.out.join("\n");
    expect(text).toMatch(/^FAIL /m);
    expect(text).toContain(path.join("deployment-definitions", "prms"));
    expect(text).toContain("deployScript");
  });

  it("fails (exit 1) naming the registry file when the target registry is invalid", async () => {
    const dir = copyDefinitions();
    writeFileSync(path.join(dir, "deployment-definitions", "targets", "dev.yaml"), "not-a-target: 1\n");
    const r = await run(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toContain(path.join("deployment-definitions", "targets", "dev.yaml"));
  });

  it("returns 2 when --root is missing", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("--root");
  });

  it("returns 2 when --root does not exist", async () => {
    const r = await run(["--root", path.join(tmpdir(), "definitely-not-here-xyz")]);
    expect(r.code).toBe(2);
  });
  it("fails (exit 1) on an unparsable YAML file next to a valid one, naming the file and never echoing its content", async () => {
    const dir = copyDefinitions();
    writeFileSync(path.join(dir, "deployment-definitions", "prms", "broken.yaml"), "key: [unclosed\n  sentinel-content-xyz: {\n");
    const r = await run(["--root", dir]);
    expect(r.code).toBe(1);
    const text = r.out.join("\n");
    expect(text).toContain(path.join("deployment-definitions", "prms", "broken.yaml"));
    expect(text).toMatch(/YAML parse error/);
    expect(text).not.toContain("sentinel-content-xyz");
    expect(text).toContain("OK ");
  });

  it("fails (exit 1) on a parsed file that declares no deploymentId and is not the registry", async () => {
    const dir = copyDefinitions();
    writeFileSync(path.join(dir, "deployment-definitions", "prms", "stray.yaml"), "foo: bar\n");
    const r = await run(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toContain(path.join("deployment-definitions", "prms", "stray.yaml"));
  });

  it("names BOTH files when two deployments share the same invalid targetRef (no cross-file dedupe)", async () => {
    const dir = copyDefinitions();
    const first = path.join(dir, "deployment-definitions", "prms", "reporting-dev.yaml");
    const second = path.join(dir, "deployment-definitions", "prms", "second.yaml");
    const text = readFileSync(first, "utf8");
    writeFileSync(first, text.replace(/^targetRef:.*$/m, "targetRef: unknown-target"));
    writeFileSync(second, text.replace(/^targetRef:.*$/m, "targetRef: unknown-target").replace(/^deploymentId:.*$/m, "deploymentId: second-dev"));
    const r = await run(["--root", dir]);
    expect(r.code).toBe(1);
    const output = r.out.join("\n");
    expect(output).toContain(`${path.join("deployment-definitions", "prms", "reporting-dev.yaml")}: targetRef`);
    expect(output).toContain(`${path.join("deployment-definitions", "prms", "second.yaml")}: targetRef`);
    expect(output).not.toContain("OK second-dev");
  });

  it("fails (exit 1) when there are zero deployments", async () => {
    const dir = copyDefinitions();
    rmSync(path.join(dir, "deployment-definitions", "prms"), { recursive: true });
    const r = await run(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("no deployment definitions");
  });

  it("prints a NOTE when schemas/ is taken from the repository fallback, and not when the root has its own", async () => {
    const dir = copyDefinitions();
    expect((await run(["--root", dir])).out.join("\n")).toContain("NOTE:");
    cpSync(path.join(repoRoot, "schemas"), path.join(dir, "schemas"), { recursive: true });
    const r = await run(["--root", dir]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).not.toContain("NOTE:");
  });

  it("prints a target-registry load error once, not once per deployment", async () => {
    const dir = copyDefinitions();
    rmSync(path.join(dir, "deployment-definitions", "targets", "dev.yaml"));
    const prmsDir = path.join(dir, "deployment-definitions", "prms");
    const original = path.join(prmsDir, readdirSync(prmsDir)[0]!);
    const content = readFileSync(original, "utf8");
    const id = /^deploymentId:\s*(\S+)/m.exec(content)![1]!;
    writeFileSync(path.join(prmsDir, "second.yaml"), content.replace(id, `${id}-second`));
    const r = await run(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.out.filter((l) => l.includes("target registry not found"))).toHaveLength(1);
  });
});
