// @akili-spec changes/cicd-executor-poc design DD-24, DD-25; owner decision D2 (2026-10-10, multi-repository CI)
//
// Static contract test for infra/sam/ci-repository-role.yaml (one CI role per repository). Nothing is sent to
// AWS. It pins: the same exact-match OIDC trust as the main stack's CiRole (so a new repository never gets a
// weaker trust), least privilege, the optional ECR push, the outputs the runbook uses and the publication policy.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  asArray,
  loadSamTemplate,
  parseCfnYaml,
  rolePolicyStatements,
  roleTrustStatements,
  samTemplatePath,
  unguardedEmptyDefaultRefs,
  type CfnTemplate,
  type Json,
  type PolicyStatement,
} from "./support/cfn-template.js";

const OIDC = "token.actions.githubusercontent.com";
const rolePath = path.join(path.dirname(samTemplatePath), "ci-repository-role.yaml");
let template: CfnTemplate;
let main: CfnTemplate;

beforeAll(() => {
  template = parseCfnYaml(readFileSync(rolePath, "utf8"));
  main = loadSamTemplate();
});

const trust = (): PolicyStatement => {
  const statements = roleTrustStatements(template.Resources.RepositoryCiRole!);
  expect(statements).toHaveLength(1);
  return statements[0]!;
};

describe("ci-repository-role: OIDC trust (DD-24)", () => {
  it("defines exactly one IAM role and no stateful or extra resource", () => {
    expect(Object.entries(template.Resources).map(([id, r]) => `${id}:${r.Type}`)).toEqual(["RepositoryCiRole:AWS::IAM::Role"]);
  });

  it("is assumable only through AssumeRoleWithWebIdentity from the given OIDC provider", () => {
    const s = trust();
    expect(s.Effect).toBe("Allow");
    expect(s.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(s.Principal).toEqual({ Federated: { Ref: "GitHubOidcProviderArn" } });
  });

  it("uses only StringEquals, with the same eight keys as the main stack's CiRole", () => {
    const s = trust();
    expect(Object.keys(s.Condition!)).toEqual(["StringEquals"]);
    const mainTrust = roleTrustStatements(main.Resources.CiRole!)[0]!;
    expect(Object.keys(s.Condition!.StringEquals!).sort()).toEqual(Object.keys(mainTrust.Condition!.StringEquals!).sort());
    expect(Object.keys(s.Condition!.StringEquals!).sort()).toEqual(
      [`${OIDC}:aud`, `${OIDC}:environment`, `${OIDC}:job_workflow_ref`, `${OIDC}:ref`, `${OIDC}:repository_id`, `${OIDC}:repository_owner_id`, `${OIDC}:sub`, "sts:RoleSessionName"].sort(),
    );
  });

  it("binds every claim to its own parameter (no shared or literal values) and pins the reusable workflow by SHA", () => {
    const c = trust().Condition!.StringEquals! as Record<string, Json>;
    expect(c[`${OIDC}:aud`]).toBe("sts.amazonaws.com");
    expect(c[`${OIDC}:repository_id`]).toEqual({ Ref: "GitHubRepositoryId" });
    expect(c[`${OIDC}:repository_owner_id`]).toEqual({ Ref: "GitHubRepositoryOwnerId" });
    expect(c[`${OIDC}:environment`]).toEqual({ Ref: "GitHubEnvironment" });
    expect(c[`${OIDC}:sub`]).toEqual({ Ref: "GitHubOidcSub" });
    expect(c[`${OIDC}:ref`]).toEqual({ Ref: "GitHubBoundRef" });
    expect(c[`${OIDC}:job_workflow_ref`]).toEqual({ "Fn::Sub": "${PlatformWorkflowRepository}/.github/workflows/deploy-request.reusable.yml@${PinnedWorkflowSha}" });
    expect(c["sts:RoleSessionName"]).toBe("${token.actions.githubusercontent.com:repository_id}");
  });

  it("parameters reject wildcards and non-exact forms", () => {
    const p = template.Parameters;
    const ok = (name: string, value: string) => new RegExp(p[name]!.AllowedPattern as string).test(value);
    expect(ok("GitHubRepositoryId", "123")).toBe(true);
    expect(ok("GitHubRepositoryId", "*")).toBe(false);
    expect(ok("GitHubBoundRef", "refs/heads/feature/x")).toBe(true);
    expect(ok("GitHubBoundRef", "refs/heads/*")).toBe(false);
    expect(ok("GitHubBoundRef", "refs/tags/v1")).toBe(false);
    expect(ok("GitHubOidcSub", "repo:org/repo:environment:dev")).toBe(true);
    expect(ok("GitHubOidcSub", "repo:org/*:environment:dev")).toBe(false);
    expect(ok("GitHubOidcSub", "repo:org/repo:ref:refs/heads/main")).toBe(false);
    expect(ok("PinnedWorkflowSha", "a".repeat(40))).toBe(true);
    expect(ok("PinnedWorkflowSha", "main")).toBe(false);
    expect(ok("GitHubEnvironment", "env*")).toBe(false);
  });
});

describe("ci-repository-role: least privilege", () => {
  const statements = (): PolicyStatement[] => rolePolicyStatements(template.Resources.RepositoryCiRole!);

  it("grants only the registry token, the optional ECR push and the deploy request", () => {
    const s = statements();
    const sids = s.map((x) => (x as unknown as { "Fn::If"?: [string, { Sid: string }, Json] })["Fn::If"]?.[1].Sid ?? x.Sid);
    expect(sids).toEqual(["EcrAuthorizationToken", "EcrPushSelectedRepository", "SendDeployRequest"]);
  });

  it("the only wildcard resource is ecr:GetAuthorizationToken", () => {
    const token = statements().find((s) => s.Sid === "EcrAuthorizationToken")!;
    expect(token.Action).toBe("ecr:GetAuthorizationToken");
    expect(token.Resource).toBe("*");
    const send = statements().find((s) => s.Sid === "SendDeployRequest")!;
    expect(asArray(send.Action).sort()).toEqual(["sqs:GetQueueUrl", "sqs:SendMessage"]);
    expect(send.Resource).toEqual({ Ref: "DeployQueueArn" });
  });

  it("the ECR push is granted only when a repository ARN is given, on that repository only", () => {
    const conditional = statements().find((s) => (s as unknown as Record<string, Json>)["Fn::If"] !== undefined) as unknown as { "Fn::If": [string, PolicyStatement, Json] };
    expect(conditional["Fn::If"][0]).toBe("GrantEcrPush");
    expect(conditional["Fn::If"][1].Resource).toEqual({ Ref: "CiEcrRepositoryArn" });
    expect(conditional["Fn::If"][2]).toEqual({ Ref: "AWS::NoValue" });
    expect(template.Conditions!.GrantEcrPush).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "CiEcrRepositoryArn" }, ""] }] });
    expect(unguardedEmptyDefaultRefs(template)).toEqual([]);
  });

  it("never grants DynamoDB, Secrets Manager, IAM, EC2, SSM or queue consumption", () => {
    const text = JSON.stringify(template.Resources);
    for (const forbidden of ["dynamodb:", "secretsmanager:", "iam:", "ec2:", "ssm:", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sts:AssumeRole\""]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

describe("ci-repository-role: outputs and publication policy", () => {
  it("exports the role ARN (caller variable, queue policy) and the role ID (Executor binding)", () => {
    expect(template.Outputs!.RoleArn!.Value).toEqual({ "Fn::GetAtt": ["RepositoryCiRole", "Arn"] });
    expect(template.Outputs!.RoleId!.Value).toEqual({ "Fn::GetAtt": ["RepositoryCiRole", "RoleId"] });
  });

  it("contains no 12-digit number, IPv4 address or account-bearing ARN literal", () => {
    const text = readFileSync(rolePath, "utf8");
    expect(text).not.toMatch(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});
