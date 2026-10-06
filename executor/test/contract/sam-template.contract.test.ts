// @akili-spec changes/cicd-executor-poc design DD-24, DD-25, DD-14, §5.1, §11, §12; gate-b-plan §5, §12
//
// Static contract test for infra/sam/template.yaml (Gate B / B0). The template is parsed as
// YAML with CloudFormation short-form tags resolved to long form; nothing is sent to AWS.
// It pins the security-relevant shape: exact-match OIDC trust, least-privilege roles, the
// queue Allow/Deny policy, the table schema (compared with the code that uses it), the
// reconcile schedule payload and the publication policy.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidateFunction } from "ajv";
import { buildCreateTableInput, GSI2_NAME, TTL_ATTR } from "../../src/adapters/dynamodb-state-store/table-schema.js";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import {
  asArray,
  loadSamTemplate,
  parseCfnYaml,
  resourcesOfType,
  rolePolicyStatements,
  roleTrustStatements,
  samConfigExamplePath,
  samParametersExamplePath,
  samTemplatePath,
  type CfnResource,
  type CfnTemplate,
  type Json,
  type PolicyStatement,
} from "./support/cfn-template.js";
import { eventSchemaPath } from "./support/schema-paths.js";

const OIDC = "token.actions.githubusercontent.com";
const ROLE_NAMES = ["CiRole", "ExecutorRole", "OperatorRole", "SchedulerRole"] as const;
const getAttArn = (logicalId: string): Json => ({ "Fn::GetAtt": [logicalId, "Arn"] });
const key = (v: Json): string => JSON.stringify(v);

let template: CfnTemplate;
const role = (name: string): CfnResource => template.Resources[name]!;
const actionsOf = (statements: PolicyStatement[]): string[] => statements.flatMap((s) => asArray(s.Action));

beforeAll(() => {
  template = loadSamTemplate();
});

describe("template parsing", () => {
  it("parses short-form intrinsics into long form", () => {
    const doc = parseCfnYaml(
      [
        "A: !Ref X",
        "B: !GetAtt Y.Arn",
        "C: !Sub 'a-${X}'",
        "D: !If [Cond, !Ref X, !Ref 'AWS::NoValue']",
        "E: !Join ['', [a, !Ref X]]",
      ].join("\n"),
    ) as unknown as Record<string, Json>;
    expect(doc).toEqual({
      A: { Ref: "X" },
      B: { "Fn::GetAtt": ["Y", "Arn"] },
      C: { "Fn::Sub": "a-${X}" },
      D: { "Fn::If": ["Cond", { Ref: "X" }, { Ref: "AWS::NoValue" }] },
      E: { "Fn::Join": ["", ["a", { Ref: "X" }]] },
    });
  });

  it("declares the SAM transform", () => {
    expect(template.Transform).toBe("AWS::Serverless-2016-10-31");
  });
});

describe("parameters", () => {
  it("PinnedWorkflowSha accepts exactly 40 lowercase hex characters", () => {
    const pattern = new RegExp(template.Parameters.PinnedWorkflowSha!.AllowedPattern!);
    expect(pattern.test("a".repeat(40))).toBe(true);
    expect(pattern.test("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    for (const bad of ["a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), "v1.0.0", "main", `${"a".repeat(40)}\n`, ""]) {
      expect(pattern.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("GitHub numeric IDs accept digits only", () => {
    for (const name of ["GitHubRepositoryId", "GitHubRepositoryOwnerId"]) {
      const pattern = new RegExp(template.Parameters[name]!.AllowedPattern!);
      expect(pattern.test("12345")).toBe(true);
      expect(pattern.test("12a45")).toBe(false);
      expect(pattern.test("*")).toBe(false);
    }
  });

  it("parameters that flow into the trust policy or the secret ARN reject wildcard characters", () => {
    for (const name of ["GitHubOidcSub", "GitHubEnvironment", "PlatformWorkflowRepository", "SecretIdPrefix"]) {
      const pattern = new RegExp(template.Parameters[name]!.AllowedPattern!);
      expect(pattern.test("a*b"), `${name} *`).toBe(false);
      expect(pattern.test("a?b"), `${name} ?`).toBe(false);
    }
  });

  it("SecretIdPrefix must end with a slash", () => {
    const pattern = new RegExp(template.Parameters.SecretIdPrefix!.AllowedPattern!);
    expect(pattern.test("cicd-poc/dev/")).toBe(true);
    expect(pattern.test("cicd-poc/dev")).toBe(false);
  });

  it("a rule fails the stack when no ECR repository is selected", () => {
    const rule = template.Rules?.EcrRepositorySelected as unknown as { Assertions: { Assert: Json }[] };
    expect(key(rule.Assertions[0]!.Assert)).toBe(
      key({
        "Fn::Or": [
          { "Fn::Not": [{ "Fn::Equals": [{ Ref: "CiEcrRepositoryArn" }, ""] }] },
          { "Fn::Equals": [{ Ref: "CreateProbeEcrRepository" }, "true"] },
        ],
      }),
    );
  });

  it("the schedule is disabled and PITR is off by default", () => {
    expect(template.Parameters.ReconcileScheduleState!.Default).toBe("DISABLED");
    expect(template.Parameters.EnablePointInTimeRecovery!.Default).toBe("false");
  });
});

describe("CiRole OIDC trust (DD-24, FR-25)", () => {
  const trustCondition = (): Record<string, Record<string, Json>> => {
    const statements = roleTrustStatements(role("CiRole"));
    expect(statements).toHaveLength(1);
    expect(statements[0]!.Action).toBe("sts:AssumeRoleWithWebIdentity");
    return statements[0]!.Condition!;
  };

  it("every condition operator is StringEquals", () => {
    expect(Object.keys(trustCondition())).toEqual(["StringEquals"]);
  });

  it("binds exactly the six expected claims", () => {
    expect(Object.keys(trustCondition().StringEquals!).sort()).toEqual(
      ["aud", "environment", "job_workflow_ref", "repository_id", "repository_owner_id", "sub"].map((c) => `${OIDC}:${c}`).sort(),
    );
  });

  it("binds each claim to the intended value", () => {
    const c = trustCondition().StringEquals!;
    expect(c[`${OIDC}:aud`]).toBe("sts.amazonaws.com");
    expect(c[`${OIDC}:repository_id`]).toEqual({ Ref: "GitHubRepositoryId" });
    expect(c[`${OIDC}:repository_owner_id`]).toEqual({ Ref: "GitHubRepositoryOwnerId" });
    expect(c[`${OIDC}:environment`]).toEqual({ Ref: "GitHubEnvironment" });
    expect(c[`${OIDC}:sub`]).toEqual({ Ref: "GitHubOidcSub" });
  });

  it("pins job_workflow_ref to the reusable workflow at the pinned SHA", () => {
    const value = trustCondition().StringEquals![`${OIDC}:job_workflow_ref`] as { "Fn::Sub": string };
    expect(value["Fn::Sub"]).toBe("${PlatformWorkflowRepository}/.github/workflows/deploy-request.reusable.yml@${PinnedWorkflowSha}");
    expect(value["Fn::Sub"].endsWith("@${PinnedWorkflowSha}")).toBe(true);
  });

  it("no trust value uses wildcards or set operators", () => {
    const text = JSON.stringify(roleTrustStatements(role("CiRole")));
    expect(text).not.toMatch(/StringLike|ForAnyValue|ForAllValues|IfExists|StringNotEquals/);
    for (const value of Object.values(trustCondition().StringEquals!)) {
      const literal = typeof value === "string" ? value : "Fn::Sub" in (value as object) ? (value as { "Fn::Sub": string })["Fn::Sub"] : "";
      expect(literal).not.toMatch(/[*?]/);
    }
  });

  it("federates from the created provider or the supplied one, with a 1 hour session", () => {
    const principal = roleTrustStatements(role("CiRole"))[0]!.Principal as { Federated: Json };
    expect(principal.Federated).toEqual({
      "Fn::If": ["CreateOidcProvider", { Ref: "GitHubOidcProvider" }, { Ref: "ExistingGitHubOidcProviderArn" }],
    });
    expect(role("CiRole").Properties.MaxSessionDuration).toBe(3600);
  });

  it("the OIDC provider is conditional, uses the sts audience and is retained", () => {
    const provider = template.Resources.GitHubOidcProvider!;
    expect(provider.Condition).toBe("CreateOidcProvider");
    expect(provider.Properties.Url).toBe("https://token.actions.githubusercontent.com");
    expect(provider.Properties.ClientIdList).toEqual(["sts.amazonaws.com"]);
    expect(provider.DeletionPolicy).toBe("Retain");
    expect(provider.UpdateReplacePolicy).toBe("Retain");
  });
});

describe("IAM least privilege", () => {
  const allStatements = (): { role: string; statement: PolicyStatement }[] =>
    resourcesOfType(template, "AWS::IAM::Role").flatMap(([name, r]) =>
      rolePolicyStatements(r).map((statement) => ({ role: name, statement })),
    );

  it("no role carries an explicit RoleName (CAPABILITY_IAM suffices)", () => {
    for (const [name, r] of resourcesOfType(template, "AWS::IAM::Role")) {
      expect(r.Properties.RoleName, name).toBeUndefined();
    }
  });

  it("no Action is a wildcard anywhere in the template", () => {
    const offenders: string[] = [];
    const walk = (node: Json, where: string): void => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${where}[${i}]`));
      else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "Action" || k === "NotAction") {
            for (const a of asArray(v as string | string[])) if (a === "*" || a.endsWith(":*")) offenders.push(`${where}.${k}=${a}`);
            if (k === "NotAction") offenders.push(`${where}.NotAction`);
          }
          walk(v, `${where}.${k}`);
        }
      }
    };
    walk(template.Resources as unknown as Json, "Resources");
    expect(offenders).toEqual([]);
  });

  it("Resource '*' only for ecr:GetAuthorizationToken alone and the namespaced PutMetricData", () => {
    const wildcard = allStatements().filter(({ statement }) => asArray(statement.Resource as string | string[]).includes("*"));
    const summary = wildcard.map(({ role: r, statement }) => ({
      role: r,
      actions: asArray(statement.Action),
      condition: statement.Condition ? key(statement.Condition as Json) : null,
    }));
    expect(summary).toEqual([
      { role: "CiRole", actions: ["ecr:GetAuthorizationToken"], condition: null },
      {
        role: "ExecutorRole",
        actions: ["cloudwatch:PutMetricData"],
        condition: key({ StringEquals: { "cloudwatch:namespace": "CicdExecutor" } }),
      },
    ]);
  });

  it("ExecutorRole has no ecr, s3, lambda, codebuild, iam or sts action", () => {
    const services = new Set(actionsOf(rolePolicyStatements(role("ExecutorRole"))).map((a) => a.split(":")[0]));
    for (const forbidden of ["ecr", "s3", "lambda", "codebuild", "iam", "sts"]) {
      expect(services.has(forbidden), forbidden).toBe(false);
    }
    expect([...services].sort()).toEqual(["cloudwatch", "dynamodb", "logs", "secretsmanager", "sqs"]);
  });

  it("ExecutorRole reads secrets only under the SecretIdPrefix", () => {
    const secrets = rolePolicyStatements(role("ExecutorRole")).filter((s) => asArray(s.Action).some((a) => a.startsWith("secretsmanager:")));
    expect(secrets).toHaveLength(1);
    expect(asArray(secrets[0]!.Action).sort()).toEqual(["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]);
    expect(secrets[0]!.Resource).toEqual({
      "Fn::Sub": "arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretIdPrefix}*",
    });
  });

  it("ExecutorRole SQS actions are the four the Executor issues, on the queue only", () => {
    const sqs = rolePolicyStatements(role("ExecutorRole")).filter((s) => asArray(s.Action).some((a) => a.startsWith("sqs:")));
    expect(sqs).toHaveLength(1);
    expect(asArray(sqs[0]!.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage", "sqs:SendMessage"]);
    expect(sqs[0]!.Resource).toEqual(getAttArn("DeployQueue"));
  });

  it("ExecutorRole DynamoDB: item actions on the table, Query only on the GSI2 index", () => {
    const statements = rolePolicyStatements(role("ExecutorRole")).filter((s) => asArray(s.Action).some((a) => a.startsWith("dynamodb:")));
    const items = statements.find((s) => !asArray(s.Action).includes("dynamodb:Query"))!;
    expect(asArray(items.Action).sort()).toEqual([
      "dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
    ]);
    expect(items.Resource).toEqual(getAttArn("ExecutionsTable"));
    const query = statements.find((s) => asArray(s.Action).includes("dynamodb:Query"))!;
    expect(query.Action).toBe("dynamodb:Query");
    expect(query.Resource).toEqual({ "Fn::Sub": `\${ExecutionsTable.Arn}/index/${GSI2_NAME}` });
  });

  it("ExecutorRole is assumable only by the configured principal", () => {
    const trust = roleTrustStatements(role("ExecutorRole"));
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Action).toBe("sts:AssumeRole");
    expect(trust[0]!.Principal).toEqual({ AWS: { Ref: "ExecutorTrustedPrincipalArn" } });
    expect(trust[0]!.Condition).toBeUndefined();
  });

  it("CiRole actions are exactly the allowed set", () => {
    const statements = rolePolicyStatements(role("CiRole"));
    const byResource = statements.map((s) => ({ actions: asArray(s.Action).sort(), resource: key(s.Resource as Json) }));
    expect(byResource).toEqual([
      { actions: ["ecr:GetAuthorizationToken"], resource: key("*") },
      {
        actions: ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"],
        resource: key({
          "Fn::If": ["CreateProbeRepository", { "Fn::GetAtt": ["ProbeEcrRepository", "Arn"] }, { Ref: "CiEcrRepositoryArn" }],
        }),
      },
      { actions: ["sqs:GetQueueUrl", "sqs:SendMessage"], resource: key(getAttArn("DeployQueue")) },
    ]);
  });

  it("OperatorRole and SchedulerRole may only send to the queue", () => {
    for (const name of ["OperatorRole", "SchedulerRole"]) {
      const statements = rolePolicyStatements(role(name));
      expect(statements, name).toHaveLength(1);
      expect(statements[0]!.Action, name).toBe("sqs:SendMessage");
      expect(statements[0]!.Resource, name).toEqual(getAttArn("DeployQueue"));
    }
  });

  it("SchedulerRole trust is the Scheduler service scoped to this account and schedule", () => {
    const [trust] = roleTrustStatements(role("SchedulerRole"));
    expect(trust!.Principal).toEqual({ Service: "scheduler.amazonaws.com" });
    expect(trust!.Condition).toEqual({
      StringEquals: {
        "aws:SourceAccount": { Ref: "AWS::AccountId" },
        "aws:SourceArn": {
          "Fn::Sub": "arn:${AWS::Partition}:scheduler:${AWS::Region}:${AWS::AccountId}:schedule/default/cicd-reconcile-${Stage}",
        },
      },
    });
  });
});

describe("deploy queue (DD-14, DD-25)", () => {
  it("queue settings", () => {
    const q = template.Resources.DeployQueue!.Properties;
    const d = template.Resources.DeployDlq!.Properties;
    expect(q.VisibilityTimeout).toBe(120);
    expect(q.MessageRetentionPeriod).toBe(4 * 24 * 3600);
    expect(d.MessageRetentionPeriod).toBe(14 * 24 * 3600);
    expect(q.SqsManagedSseEnabled).toBe(true);
    expect(d.SqsManagedSseEnabled).toBe(true);
    expect(q.RedrivePolicy).toEqual({ deadLetterTargetArn: getAttArn("DeployDlq"), maxReceiveCount: 5 });
  });

  const statements = (): PolicyStatement[] =>
    (template.Resources.DeployQueuePolicy!.Properties.PolicyDocument as unknown as { Statement: PolicyStatement[] }).Statement;
  const expectedRoles = ROLE_NAMES.map((n) => key(getAttArn(n))).sort();

  it("the policy is attached to the deploy queue", () => {
    expect(template.Resources.DeployQueuePolicy!.Properties.Queues).toEqual([{ Ref: "DeployQueue" }]);
  });

  it("allows SendMessage to exactly the four platform roles", () => {
    const allow = statements().filter((s) => s.Effect === "Allow" && asArray(s.Action).includes("sqs:SendMessage"));
    expect(allow).toHaveLength(1);
    expect(allow[0]!.Action).toBe("sqs:SendMessage");
    expect(asArray((allow[0]!.Principal as { AWS: Json[] }).AWS).map(key).sort()).toEqual(expectedRoles);
  });

  it("allows receive, delete and visibility changes only to the Executor role", () => {
    const consume = statements().filter((s) => s.Effect === "Allow" && !asArray(s.Action).includes("sqs:SendMessage"));
    expect(consume).toHaveLength(1);
    expect(asArray(consume[0]!.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"]);
    expect(consume[0]!.Principal).toEqual({ AWS: getAttArn("ExecutorRole") });
  });

  it("explicitly denies SendMessage to every principal outside the four roles", () => {
    const deny = statements().filter((s) => s.Effect === "Deny");
    expect(deny).toHaveLength(1);
    expect(deny[0]!.Principal).toBe("*");
    expect(deny[0]!.Action).toBe("sqs:SendMessage");
    expect(Object.keys(deny[0]!.Condition!)).toEqual(["ArnNotEquals"]);
    expect(Object.keys(deny[0]!.Condition!.ArnNotEquals!)).toEqual(["aws:PrincipalArn"]);
    expect(asArray(deny[0]!.Condition!.ArnNotEquals!["aws:PrincipalArn"] as Json[]).map(key).sort()).toEqual(expectedRoles);
  });
});

describe("executions table (design §5.1) matches the code", () => {
  const code = buildCreateTableInput("unused");
  const props = (): Record<string, Json> => template.Resources.ExecutionsTable!.Properties;

  it("billing, attribute definitions, key schema and GSI2 equal the adapter's table schema", () => {
    expect(props().BillingMode).toBe(code.BillingMode);
    const sortByName = (xs: { AttributeName?: string }[]) => [...xs].sort((a, b) => a.AttributeName!.localeCompare(b.AttributeName!));
    expect(sortByName(props().AttributeDefinitions as never)).toEqual(sortByName(code.AttributeDefinitions as never));
    expect(props().KeySchema).toEqual(code.KeySchema);
    expect(props().GlobalSecondaryIndexes).toEqual(code.GlobalSecondaryIndexes);
  });

  it("TTL is enabled on the attribute the code writes", () => {
    expect(props().TimeToLiveSpecification).toEqual({ AttributeName: TTL_ATTR, Enabled: true });
  });

  it("point-in-time recovery follows the parameter", () => {
    expect(props().PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: { Ref: "EnablePointInTimeRecovery" } });
  });
});

describe("reconcile schedule (DD-13)", () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    validate = createAjv().compile(readJsonSchema(eventSchemaPath));
  });

  const target = (): Record<string, Json> => template.Resources.ReconcileSchedule!.Properties.Target as Record<string, Json>;

  it("runs every 5 minutes with no flexible window, state from the parameter", () => {
    const p = template.Resources.ReconcileSchedule!.Properties;
    expect(p.ScheduleExpression).toBe("rate(5 minutes)");
    expect(p.FlexibleTimeWindow).toEqual({ Mode: "OFF" });
    expect(p.State).toEqual({ Ref: "ReconcileScheduleState" });
  });

  it("targets the deploy queue with the scheduler role", () => {
    expect(target().Arn).toEqual(getAttArn("DeployQueue"));
    expect(target().RoleArn).toEqual(getAttArn("SchedulerRole"));
  });

  const substitute = (executionId: string): Record<string, unknown> =>
    JSON.parse(
      (target().Input as string)
        .replace("<aws.scheduler.execution-id>", executionId)
        .replace("<aws.scheduler.scheduled-time>", "2026-10-06T12:00:00Z"),
    ) as Record<string, unknown>;

  it("uses the Scheduler context attributes for eventId and timestamp", () => {
    const raw = target().Input as string;
    expect(raw).toContain("<aws.scheduler.execution-id>");
    expect(raw).toContain("<aws.scheduler.scheduled-time>");
    expect(substitute("x").eventType).toBe("RECONCILE_TICK");
  });

  it("every field of the Input other than eventId is valid (a UUID is substituted ONLY to isolate eventId)", () => {
    const sample = substitute("8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f2");
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
  });

  it("spec gap G-8: the Scheduler execution id is not a UUID, so the tick is rejected by the current schema", () => {
    // d32c5kddcf5bb8c3 is the documented real-format Scheduler execution id.
    const sample = substitute("d32c5kddcf5bb8c3");
    expect(validate(sample)).toBe(false);
    expect((validate.errors ?? []).some((e) => e.instancePath === "/eventId" && e.keyword === "format")).toBe(true);
  });

  it("the schedule defaults to DISABLED until G-8 is resolved", () => {
    expect(template.Parameters.ReconcileScheduleState!.Default).toBe("DISABLED");
  });
});

describe("alarms (design §12, FR-17)", () => {
  const alarms = (): Record<string, Record<string, Json>> =>
    Object.fromEntries(resourcesOfType(template, "AWS::CloudWatch::Alarm").map(([n, r]) => [n, r.Properties]));

  it("there are exactly five alarms with the expected metrics", () => {
    const summary = Object.values(alarms())
      .map((p) => `${p.Namespace}/${p.MetricName}`)
      .sort();
    expect(summary).toEqual([
      "AWS/SQS/ApproximateAgeOfOldestMessage",
      "AWS/SQS/ApproximateNumberOfMessagesVisible",
      "CicdExecutor/ExecutionsPastDeadline",
      "CicdExecutor/ExecutorHeartbeat",
      "CicdExecutor/RejectedRequests",
    ]);
  });

  it("thresholds match the design", () => {
    const a = alarms();
    expect(a.DlqNotEmptyAlarm).toMatchObject({ Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
    expect(a.DlqNotEmptyAlarm!.Dimensions).toEqual([{ Name: "QueueName", Value: { "Fn::GetAtt": ["DeployDlq", "QueueName"] } }]);
    expect(a.OldestMessageAgeAlarm).toMatchObject({ Threshold: 600, ComparisonOperator: "GreaterThanThreshold" });
    expect(a.OldestMessageAgeAlarm!.Dimensions).toEqual([{ Name: "QueueName", Value: { "Fn::GetAtt": ["DeployQueue", "QueueName"] } }]);
    expect(a.ExecutionsPastDeadlineAlarm).toMatchObject({ Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
  });

  it("the heartbeat alarm is dimensionless and breaches on missing data after 5 minutes", () => {
    const hb = alarms().ExecutorHeartbeatMissingAlarm!;
    expect(hb.Dimensions).toBeUndefined();
    expect(hb.TreatMissingData).toBe("breaching");
    expect((hb.Period as number) * (hb.EvaluationPeriods as number)).toBe(300);
    expect(hb.ComparisonOperator).toBe("LessThanThreshold");
  });

  it("the rejected-sender alarm is scoped to reason=UNAUTHORIZED_SENDER", () => {
    const rs = alarms().RejectedSenderAlarm!;
    expect(rs.Dimensions).toEqual([{ Name: "reason", Value: "UNAUTHORIZED_SENDER" }]);
    expect(rs).toMatchObject({ Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
  });

  it("alarm actions exist only when an SNS topic is supplied", () => {
    for (const [name, p] of Object.entries(alarms())) {
      expect(p.AlarmActions, name).toEqual({
        "Fn::If": ["HasAlarmTopic", [{ Ref: "AlarmTopicArn" }], { Ref: "AWS::NoValue" }],
      });
    }
  });
});

describe("tags, deletion policies and ECR", () => {
  const UNTAGGABLE = new Set(["AWS::Scheduler::Schedule", "AWS::SQS::QueuePolicy"]);
  const STATEFUL = new Set([
    "AWS::SQS::Queue", "AWS::DynamoDB::Table", "AWS::Logs::LogGroup", "AWS::ECR::Repository", "AWS::IAM::OIDCProvider",
  ]);

  it("every taggable resource carries Project=cicd-poc", () => {
    for (const [name, r] of Object.entries(template.Resources)) {
      if (UNTAGGABLE.has(r.Type)) continue;
      expect(r.Properties.Tags, name).toContainEqual({ Key: "Project", Value: "cicd-poc" });
    }
  });

  it("every stateful resource sets DeletionPolicy and UpdateReplacePolicy explicitly", () => {
    const stateful = Object.entries(template.Resources).filter(([, r]) => STATEFUL.has(r.Type));
    expect(stateful.map(([n]) => n).sort()).toEqual(
      ["DeployDlq", "DeployQueue", "ExecutionsTable", "ExecutorLogGroup", "GitHubOidcProvider", "ProbeEcrRepository"].sort(),
    );
    for (const [name, r] of stateful) {
      const expected = r.Type === "AWS::IAM::OIDCProvider" ? "Retain" : "Delete";
      expect(r.DeletionPolicy, name).toBe(expected);
      expect(r.UpdateReplacePolicy, name).toBe(expected);
    }
  });

  it("the probe repository is conditional, immutable, scanned and emptied on delete", () => {
    const repo = template.Resources.ProbeEcrRepository!;
    expect(repo.Condition).toBe("CreateProbeRepository");
    expect(repo.Properties.ImageTagMutability).toBe("IMMUTABLE");
    expect(repo.Properties.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
    expect(repo.Properties.EmptyOnDelete).toBe(true);
  });

  it("log group retention is 30 days", () => {
    expect(template.Resources.ExecutorLogGroup!.Properties.RetentionInDays).toBe(30);
  });

  it("every documented output exists", () => {
    expect(Object.keys(template.Outputs).sort()).toEqual(
      [
        "CiEcrRepositoryArn", "CiRoleArn", "DeployDlqUrl", "DeployQueueArn", "DeployQueueName", "DeployQueueUrl",
        "ExecutionsTableName", "ExecutorLogGroupName", "ExecutorRoleArn", "OidcProviderArn", "OperatorRoleArn", "SchedulerRoleArn",
        "CiRoleId", "ExecutorRoleId", "OperatorRoleId", "SchedulerRoleId",
      ].sort(),
    );
    for (const [name, o] of Object.entries(template.Outputs)) expect(o.Description, name).toBeTruthy();
  });
});

describe("publication policy (design §4.1, DD-23)", () => {
  const files = [samTemplatePath, samParametersExamplePath, samConfigExamplePath];

  it("no 12-digit number, IPv4 address or account-bearing ARN literal in the template or the examples", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} 12-digit`).not.toMatch(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/);
      expect(text, `${file} ipv4`).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(text, `${file} arn`).not.toMatch(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d+:/);
    }
  });

  it("the examples use placeholders and the expected stack name", () => {
    const params = JSON.parse(readFileSync(samParametersExamplePath, "utf8")) as { ParameterKey: string; ParameterValue: string }[];
    const names = Object.keys(template.Parameters).sort();
    expect(params.map((p) => p.ParameterKey).sort()).toEqual(names);
    const toml = readFileSync(samConfigExamplePath, "utf8");
    expect(toml).toContain('stack_name = "cicd-poc-dev"');
    expect(toml).toContain('capabilities = "CAPABILITY_IAM"');
    expect(toml).toContain("confirm_changeset = true");
    expect(toml).toContain('region = "<AWS_REGION>"');
  });
});
