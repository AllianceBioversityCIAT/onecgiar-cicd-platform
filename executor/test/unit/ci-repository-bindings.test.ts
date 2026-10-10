// @akili-spec changes/cicd-executor-poc owner decision D2 (2026-10-10, multi-repository CI); design DD-23, DD-25
//
// Multi-repository CI: one CI role per GitHub repository, declared to the Executor as optional
// `CICD_CI_REPOSITORY_BINDINGS` (`<repositoryId>=<LOGICAL_REF>`, comma separated). Each reference resolves at
// startup to that role's ID; the sender authorizer then accepts DEPLOY_REQUESTED from a bound role only for its
// own repository_id. The shared CI role (`CICD_CI_PRINCIPAL_REF`) is unchanged. All IDs are fake.
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/composition/config.js";
import { resolvePlatformConfig, UnresolvedReferenceError } from "../../src/application/platform-config/index.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";
import { validEnv } from "../support/composition-fixtures.js";

describe("CICD_CI_REPOSITORY_BINDINGS configuration", () => {
  it("is optional: absent or empty means no repository-bound role (existing behavior)", () => {
    expect(loadConfig(validEnv()).principalRefs.ciRepositoryBindingRefs).toEqual([]);
    expect(loadConfig(validEnv({ CICD_CI_REPOSITORY_BINDINGS: " " })).principalRefs.ciRepositoryBindingRefs).toEqual([]);
  });

  it("parses one or several `<repositoryId>=<LOGICAL_REF>` entries, tolerating spaces", () => {
    const config = loadConfig(validEnv({ CICD_CI_REPOSITORY_BINDINGS: "520000001=<CI_ROLE_REPO_A>, 520000002 = <CI_ROLE_REPO_B>" }));
    expect(config.principalRefs.ciRepositoryBindingRefs).toEqual([
      { repositoryId: "520000001", principalRef: "<CI_ROLE_REPO_A>" },
      { repositoryId: "520000002", principalRef: "<CI_ROLE_REPO_B>" },
    ]);
  });

  it.each([
    ["no separator", "520000001"],
    ["non-numeric repository id", "repo-a=<CI_ROLE_REPO_A>"],
    ["literal value instead of a logical reference (DD-23)", "520000001=AROAFAKEEXAMPLE0101"],
    ["empty entry", "520000001=<CI_ROLE_REPO_A>,,"],
    ["duplicate repository id", "520000001=<CI_ROLE_REPO_A>,520000001=<CI_ROLE_REPO_B>"],
    ["duplicate reference", "520000001=<CI_ROLE_REPO_A>,520000002=<CI_ROLE_REPO_A>"],
    ["shared CI role reference reused", "520000001=<CI_PRINCIPAL_REF>"],
  ])("refuses %s", (_label, value) => {
    expect(() => loadConfig(validEnv({ CICD_CI_REPOSITORY_BINDINGS: value }))).toThrowError(ConfigError);
    try {
      loadConfig(validEnv({ CICD_CI_REPOSITORY_BINDINGS: value }));
    } catch (e) {
      expect(String(e)).toContain("CICD_CI_REPOSITORY_BINDINGS");
    }
  });
});

describe("resolvePlatformConfig: repository-bound CI roles", () => {
  const base = {
    "<CI_PRINCIPAL_REF>": "AROAFAKEEXAMPLE0001",
    "<EXECUTOR_PRINCIPAL_REF>": "AROAFAKEEXAMPLE0010",
    "<SCHEDULER_PRINCIPAL_REF>": "AROAFAKEEXAMPLE0011",
    "<OPERATOR_PRINCIPAL_REF>": "AROAFAKEEXAMPLE0012",
    "<SLACK_CHANNEL>": "C0FAKE",
    "<SLACK_TOKEN>": "fake-slack-token-value",
  };
  const refs = (bindings: readonly { repositoryId: string; principalRef: string }[]) => ({
    principalRefs: {
      ciPrincipalRef: "<CI_PRINCIPAL_REF>",
      executorPrincipalRef: "<EXECUTOR_PRINCIPAL_REF>",
      schedulerPrincipalRef: "<SCHEDULER_PRINCIPAL_REF>",
      operatorPrincipalRef: "<OPERATOR_PRINCIPAL_REF>",
      ciRepositoryBindingRefs: bindings,
    },
    platformSlack: { channelRef: "<SLACK_CHANNEL>", tokenRef: "<SLACK_TOKEN>" },
  });

  it("resolves each binding to its role ID", async () => {
    const provider = new FakeSecretProvider({ ...base, "<CI_ROLE_REPO_A>": "AROAFAKEEXAMPLE0101", "<CI_ROLE_REPO_B>": "AROAFAKEEXAMPLE0102" });
    const resolved = await resolvePlatformConfig(
      provider,
      refs([
        { repositoryId: "520000001", principalRef: "<CI_ROLE_REPO_A>" },
        { repositoryId: "520000002", principalRef: "<CI_ROLE_REPO_B>" },
      ]),
    );
    expect(resolved.principals.ciRepositoryBindings).toEqual([
      { repositoryId: "520000001", roleId: "AROAFAKEEXAMPLE0101" },
      { repositoryId: "520000002", roleId: "AROAFAKEEXAMPLE0102" },
    ]);
    expect(resolved.principals.ci).toBe("AROAFAKEEXAMPLE0001");
  });

  it("keeps an empty list when no binding is configured", async () => {
    const resolved = await resolvePlatformConfig(new FakeSecretProvider(base), refs([]));
    expect(resolved.principals.ciRepositoryBindings).toEqual([]);
  });

  it("fails startup naming only the reference when a binding does not resolve", async () => {
    await expect(resolvePlatformConfig(new FakeSecretProvider(base), refs([{ repositoryId: "520000001", principalRef: "<CI_ROLE_REPO_A>" }]))).rejects.toThrowError(
      UnresolvedReferenceError,
    );
  });

  it.each([
    ["the shared CI role", "AROAFAKEEXAMPLE0001"],
    ["the Executor role", "AROAFAKEEXAMPLE0010"],
    ["the Operator role", "AROAFAKEEXAMPLE0012"],
  ])("refuses a binding whose role ID is %s (ambiguous identity)", async (_label, roleId) => {
    const provider = new FakeSecretProvider({ ...base, "<CI_ROLE_REPO_A>": roleId });
    await expect(resolvePlatformConfig(provider, refs([{ repositoryId: "520000001", principalRef: "<CI_ROLE_REPO_A>" }]))).rejects.toThrowError(/role ID/);
  });

  it("refuses two bindings that resolve to the same role ID", async () => {
    const provider = new FakeSecretProvider({ ...base, "<CI_ROLE_REPO_A>": "AROAFAKEEXAMPLE0101", "<CI_ROLE_REPO_B>": "AROAFAKEEXAMPLE0101" });
    await expect(
      resolvePlatformConfig(
        provider,
        refs([
          { repositoryId: "520000001", principalRef: "<CI_ROLE_REPO_A>" },
          { repositoryId: "520000002", principalRef: "<CI_ROLE_REPO_B>" },
        ]),
      ),
    ).rejects.toThrowError(/role ID/);
  });

  it("never puts a role ID in the error message", async () => {
    const provider = new FakeSecretProvider({ ...base, "<CI_ROLE_REPO_A>": "AROAFAKEEXAMPLE0001" });
    await expect(resolvePlatformConfig(provider, refs([{ repositoryId: "520000001", principalRef: "<CI_ROLE_REPO_A>" }]))).rejects.toThrowError(
      expect.objectContaining({ message: expect.not.stringContaining("AROAFAKEEXAMPLE") }),
    );
  });
});
