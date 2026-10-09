// @akili-spec changes/cicd-executor-poc architecture-change-03 G-D1, G-D2, G-D7; design §6.5; tasks G-1, G-2
// The deploy plan is technology-neutral: the target's `scriptArguments` decides
// between no argument and the standard vector, artifacts are optional, and the
// version check distinguishes "script succeeded" from "version verified".
import { describe, expect, it } from "vitest";
import type { ExecutionItem, TargetSnapshot } from "../../src/adapters/dynamodb-state-store/types.js";
import { buildRemoteCommand } from "../../src/adapters/ssh-deployer/index.js";
import { deployPlanOf } from "../../src/application/deploy-coordinator/index.js";
import { snapshotOf } from "../../src/application/execution-service/index.js";
import { versionCheckOf } from "../../src/domain/version-check/index.js";
import type { TargetRecord } from "../../src/ports/target-registry.js";

const COMMIT = "a".repeat(40);
const DIGEST_A = `sha256:${"1".repeat(64)}`;
const DIGEST_B = `sha256:${"2".repeat(64)}`;

function snapshot(over: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    version: 1,
    project: "example",
    environment: "dev",
    host: "target.example.internal",
    user: "deploy",
    hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
    credentialRef: "cicd-poc/dev/example-app-dev/ssh",
    deployScript: "/opt/cicd/scripts/deploy-example-dev.sh",
    deployWindowPolicy: "not-required",
    sourceRepositoryId: "123456789",
    ...over,
  } as TargetSnapshot;
}

function execution(over: Partial<ExecutionItem> = {}, snap: Partial<TargetSnapshot> = {}): ExecutionItem {
  return {
    executionId: "example-app-dev-7",
    targetId: "example-app-dev",
    commitSha: COMMIT,
    artifacts: { server: DIGEST_A, client: DIGEST_B },
    targetSnapshot: snapshot(snap),
    ...over,
  } as ExecutionItem;
}

describe("deploy plan by scriptArguments (AC-03 G-D1, G-D2)", () => {
  it("none: the script runs with NO argument, and the remote command is the quoted script path alone", () => {
    const plan = deployPlanOf(execution({}, { scriptArguments: "none" }));
    expect(plan.scriptArgs(7)).toEqual([]);
    expect(buildRemoteCommand(plan.scriptPath, plan.scriptArgs(7))).toBe("'/opt/cicd/scripts/deploy-example-dev.sh'");
  });

  it("standard (explicit) keeps the §6.5 vector with one --artifact per artifact, sorted", () => {
    expect(deployPlanOf(execution({}, { scriptArguments: "standard" })).scriptArgs(7)).toEqual([
      "--target-id", "example-app-dev", "--execution-id", "example-app-dev-7", "--fencing-token", "7", "--commit-sha", COMMIT,
      "--artifact", `client=${DIGEST_B}`, "--artifact", `server=${DIGEST_A}`,
    ]);
  });

  it("a snapshot without the field (executions accepted before AC-03) is standard", () => {
    expect(deployPlanOf(execution()).scriptArgs(3).slice(0, 2)).toEqual(["--target-id", "example-app-dev"]);
  });

  it("standard without artifacts (a non-image platform): only the identity and version arguments", () => {
    expect(deployPlanOf(execution({ artifacts: {} })).scriptArgs(7)).toEqual([
      "--target-id", "example-app-dev", "--execution-id", "example-app-dev-7", "--fencing-token", "7", "--commit-sha", COMMIT,
    ]);
  });
});

describe("snapshot records the effective argument mode (AC-03 G-D1)", () => {
  const target = (over: Partial<TargetRecord> = {}): TargetRecord =>
    ({ ...snapshot(), targetId: "example-app-dev", schemaVersion: 1, updatedAt: "2026-10-08T12:00:00Z", updatedBy: "admin", ...over }) as TargetRecord;

  it("copies none and standard, and records standard when the record has no field", () => {
    expect(snapshotOf(target({ scriptArguments: "none" })).scriptArguments).toBe("none");
    expect(snapshotOf(target({ scriptArguments: "standard" })).scriptArguments).toBe("standard");
    expect(snapshotOf(target()).scriptArguments).toBe("standard");
  });
});

describe("version check: requested vs verified (AC-03 G-D7)", () => {
  const item = (mode: "standard" | "none" = "standard", artifacts: Record<string, string> = { server: DIGEST_A, client: DIGEST_B }) =>
    execution({ artifacts }, { scriptArguments: mode });

  it("VERIFIED when the script reports the requested commit", () => {
    expect(versionCheckOf(item(), { status: "SUCCESS", deployedCommit: COMMIT })).toEqual({ versionCheck: "VERIFIED", versionGuaranteed: true });
  });

  it("VERIFIED when every requested digest appears in deployedImages (bare or as <repository>@<digest>)", () => {
    const result = { status: "SUCCESS", deployedImages: { "app-server": `registry.example.invalid/app@${DIGEST_A}`, "app-client": DIGEST_B } };
    expect(versionCheckOf(item(), result)).toEqual({ versionCheck: "VERIFIED", versionGuaranteed: true });
  });

  it("MISMATCH when the reported commit differs, or a requested digest is not deployed", () => {
    expect(versionCheckOf(item(), { status: "SUCCESS", deployedCommit: "f".repeat(40) }).versionCheck).toBe("MISMATCH");
    expect(versionCheckOf(item(), { status: "SUCCESS", deployedImages: { "app-server": `r/app@${DIGEST_A}` } }).versionCheck).toBe("MISMATCH");
  });

  it("a matching commit never hides a missing digest", () => {
    expect(versionCheckOf(item(), { status: "SUCCESS", deployedCommit: COMMIT, deployedImages: { x: `r/x@${DIGEST_A}` } }).versionCheck).toBe("MISMATCH");
  });

  it("NOT_REPORTED without CICD_RESULT or without comparable fields", () => {
    expect(versionCheckOf(item(), undefined).versionCheck).toBe("NOT_REPORTED");
    expect(versionCheckOf(item(), { status: "SUCCESS" }).versionCheck).toBe("NOT_REPORTED");
    expect(versionCheckOf(item("standard", {}), { status: "SUCCESS", deployedImages: { x: "anything" } }).versionCheck).toBe("NOT_REPORTED");
  });

  it("none mode is never guaranteed, even when the script reports the requested commit", () => {
    expect(versionCheckOf(item("none"), { status: "SUCCESS", deployedCommit: COMMIT })).toEqual({ versionCheck: "VERIFIED", versionGuaranteed: false });
    expect(versionCheckOf(item("none"), undefined)).toEqual({ versionCheck: "NOT_REPORTED", versionGuaranteed: false });
  });
});
