// @akili-spec changes/cicd-executor-poc gate-b-plan K-7 (D-5); requirements NFR-01
// Boundary: the owner probe tooling is never packaged into the Executor image and is never a production deploy script.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDockerfileBoundaryGuard } from "../../scripts/guards/dockerfile-boundary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "executor", "Dockerfile"), "utf8");

describe("owner probe tooling stays outside the Executor image", () => {
  it("no Dockerfile COPY/ADD reaches tools/ or the probe", () => {
    const sources = dockerfile
      .split("\n")
      .filter((l) => /^\s*(COPY|ADD)\b/i.test(l))
      .join("\n");
    expect(sources).not.toMatch(/\btools\b|gate-b|probe/i);
  });

  it("the Dockerfile boundary guard (guard 1) is clean", async () => {
    expect(await runDockerfileBoundaryGuard(repoRoot)).toEqual([]);
  });

  it("the probe lives under tools/gate-b/probe, not under deploy-scripts/ or deployment-definitions/", () => {
    expect(existsSync(path.join(repoRoot, "tools", "gate-b", "probe", "target-probe.sh"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "deploy-scripts", "target-probe.sh"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "deployment-definitions", "target-probe.sh"))).toBe(false);
  });

  it("neither probe script is in the production deployScript enum", () => {
    const schema = JSON.parse(readFileSync(path.join(repoRoot, "schemas", "deployment.schema.json"), "utf8")) as {
      properties: { deployScript: { enum: string[] } };
    };
    expect(schema.properties.deployScript.enum).toEqual(["deploy-container.sh"]);
  });
});
