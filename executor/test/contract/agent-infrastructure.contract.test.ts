// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §11, §12, §14, AP-1, AP-2, AP-5, AP-6 (E4)
//
// Static contract test for the agent infrastructure (E4). Nothing is sent to AWS. It covers:
//   - the platform stack's sqs-agent additions (infra/sam/template.yaml with EnableAgentTransport=true): they appear
//     only behind that switch and change no existing resource, ExecutorRole included (its grants live in the queue
//     policies, owner decision 2026-10-13);
//   - infra/sam/agent-stack.yaml (one per agent, role modes and the shared-iam-user mode),
//     infra/sam/agent-shared-identity.yaml (the stage's shared agent user) and infra/sam/target-script-role.yaml;
//   - consistency with the code that uses them: queue names (agent record schema, Executor send permission), the
//     Executor and agent configuration formats, the agent's receive visibility, the S3 key layout and the tags the
//     results queue policy relies on.
// What IAM, SQS and S3 really do with these policies is verified in AWS at E5.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  asArray,
  embeddedVarsOutsideSub,
  loadSamTemplate,
  parseCfnYaml,
  resourcesOfType,
  rolePolicyStatements,
  roleTrustStatements,
  samTemplatePath,
  subWithoutVariable,
  unguardedEmptyDefaultRefs,
  withConditions,
  type CfnResource,
  type CfnTemplate,
  type Json,
  type PolicyStatement,
} from "./support/cfn-template.js";
import { ownCommandQueueName } from "../../src/agent/config.js";
import { repoRoot } from "./support/schema-paths.js";

const samDir = path.dirname(samTemplatePath);
const agentStackPath = path.join(samDir, "agent-stack.yaml");
const scriptRolePath = path.join(samDir, "target-script-role.yaml");
const sharedIdentityPath = path.join(samDir, "agent-shared-identity.yaml");
const getAtt = (id: string, attr = "Arn"): Json => ({ "Fn::GetAtt": [id, attr] });
const key = (v: unknown): string => JSON.stringify(v);

let raw: CfnTemplate;
let off: CfnTemplate;
let on: CfnTemplate;
let agent: CfnTemplate;
let script: CfnTemplate;
let shared: CfnTemplate;

beforeAll(() => {
  raw = loadSamTemplate();
  off = withConditions(raw, { AgentTransport: false });
  on = withConditions(raw, { AgentTransport: true });
  agent = parseCfnYaml(readFileSync(agentStackPath, "utf8"));
  script = parseCfnYaml(readFileSync(scriptRolePath, "utf8"));
  shared = parseCfnYaml(readFileSync(sharedIdentityPath, "utf8"));
});

const statementsOf = (t: CfnTemplate, roleId: string): PolicyStatement[] => rolePolicyStatements(t.Resources[roleId]!);
const policyStatements = (r: CfnResource): PolicyStatement[] => (r.Properties.PolicyDocument as unknown as { Statement: PolicyStatement[] }).Statement;
const pattern = (t: CfnTemplate, name: string): RegExp => new RegExp(t.Parameters[name]!.AllowedPattern as string);

/** Fills an Fn::Sub template string with sample values (names and ARNs as CloudFormation would produce them). */
function sub(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`no sample value for \${${name}}`);
    return v;
  });
}
// AWS's documentation account id; the queue URL shape is what the agent record schema checks.
const FAKE_SQS_QUEUE_BASE = "https://sqs.us-east-1.amazonaws.com/123456789012/";
const SAMPLE = { "AWS::Partition": "aws", "AWS::Region": "us-east-1", "AWS::AccountId": "123456789012", Stage: "dev", AgentId: "example-server-dev" };

const AGENT_RESOURCES = [
  "AgentLogBucket",
  "AgentLogBucketPolicy",
  "AgentLogReadPolicy",
  "AgentResultsDlq",
  "AgentResultsDlqNotEmptyAlarm",
  "AgentResultsOldestMessageAgeAlarm",
  "AgentResultsQueue",
  "AgentResultsQueuePolicy",
];
const AGENT_OUTPUTS = ["AgentLogBucketName", "AgentLogReadPolicyArn", "AgentResultsDlqUrl", "AgentResultsQueueArn", "AgentResultsQueueUrl"];

// ---------------------------------------------------------------------------------------------------- platform stack
describe("platform stack: the agent transport is opt-in and changes nothing else", () => {
  it("EnableAgentTransport defaults to false; off, no agent resource, output or Executor statement exists", () => {
    expect(raw.Parameters.EnableAgentTransport).toMatchObject({ Default: "false", AllowedValues: ["true", "false"] });
    expect(raw.Conditions.AgentTransport).toEqual({ "Fn::Equals": [{ Ref: "EnableAgentTransport" }, "true"] });
    for (const name of AGENT_RESOURCES) expect(off.Resources[name], name).toBeUndefined();
    for (const name of AGENT_OUTPUTS) expect(off.Outputs[name], name).toBeUndefined();
    expect(statementsOf(off, "ExecutorRole").map((s) => s.Sid)).not.toContain("AgentCommandSend");
    expect(statementsOf(off, "ExecutorRole").map((s) => s.Sid)).not.toContain("AgentResultsConsume");
  });

  it("every agent resource and output carries the AgentTransport condition", () => {
    const added = Object.keys(raw.Resources).filter((n) => !(n in off.Resources));
    expect(added.sort()).toEqual(AGENT_RESOURCES);
    for (const name of AGENT_RESOURCES) expect(raw.Resources[name]!.Condition, name).toBe("AgentTransport");
    for (const name of AGENT_OUTPUTS) expect((raw.Outputs[name] as { Condition?: string }).Condition, name).toBe("AgentTransport");
  });

  it("on, every pre-existing resource is identical, ExecutorRole included (deploy queue and its policy, roles, tables, schedule, alarms)", () => {
    for (const [name, resource] of Object.entries(off.Resources)) expect(key(on.Resources[name]), name).toBe(key(resource));
    expect(key(raw.Resources.ExecutorRole)).not.toContain("AgentTransport");
  });

  it("the Executor's agent grants live in the queue policies: consume the results queue here, send to command queues in agent-stack.yaml", () => {
    const allow = policyStatements(on.Resources.AgentResultsQueuePolicy!).find((s) => s.Sid === "AllowExecutorConsume")!;
    expect(allow).toMatchObject({ Effect: "Allow", Principal: { AWS: getAtt("ExecutorRole") }, Resource: getAtt("AgentResultsQueue") });
    expect(asArray(allow.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"]);
    const send = policyStatements(agent.Resources.CommandQueuePolicy!).find((s) => s.Sid === "AllowExecutorSend")!;
    expect(send).toMatchObject({ Effect: "Allow", Principal: { AWS: { Ref: "ExecutorRoleArn" } }, Action: "sqs:SendMessage", Resource: getAtt("CommandQueue") });
  });
});

describe("platform stack: results queue (AP-1, §11.4)", () => {
  it("is FIFO with sender-set deduplication, long polling, the configured retention, SSE and a FIFO DLQ after 5 receives", () => {
    const q = on.Resources.AgentResultsQueue!.Properties;
    expect(q).toMatchObject({
      QueueName: { "Fn::Sub": "cicd-agent-results-${Stage}.fifo" },
      FifoQueue: true,
      ContentBasedDeduplication: false,
      ReceiveMessageWaitTimeSeconds: 20,
      MessageRetentionPeriod: { Ref: "AgentResultsRetentionSeconds" },
      SqsManagedSseEnabled: true,
      RedrivePolicy: { deadLetterTargetArn: getAtt("AgentResultsDlq"), maxReceiveCount: 5 },
    });
    expect(on.Resources.AgentResultsDlq!.Properties).toMatchObject({ QueueName: { "Fn::Sub": "cicd-agent-results-${Stage}-dlq.fifo" }, FifoQueue: true, MessageRetentionPeriod: 1209600 });
    expect(raw.Parameters.AgentResultsRetentionSeconds).toMatchObject({ Type: "Number", Default: 345600 });
  });

  it("only agent identities of this stage (tag CicdAgentStage) may send and only the Executor role may consume", () => {
    const statements = policyStatements(on.Resources.AgentResultsQueuePolicy!);
    expect(statements.filter((s) => s.Effect !== "Deny").map((s) => s.Sid)).toEqual(["AllowExecutorConsume"]);
    expect(statements.filter((s) => s.Effect === "Deny").every((s) => s.Principal === "*")).toBe(true);
    const send = statements.find((s) => s.Sid === "DenySendFromNonAgents")!;
    expect(send.Action).toBe("sqs:SendMessage");
    expect(send.Condition).toEqual({ StringNotEquals: { "aws:PrincipalTag/CicdAgentStage": { Ref: "Stage" } } });
    const consume = statements.find((s) => s.Sid === "DenyConsumeFromNonExecutor")!;
    expect(asArray(consume.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"]);
    expect(consume.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": getAtt("ExecutorRole") } });
  });

  it("the queue URL and name fit the Executor setting and the agent stack's ResultsQueueArn parameter", () => {
    const name = sub("cicd-agent-results-${Stage}.fifo", SAMPLE);
    const url = `${FAKE_SQS_QUEUE_BASE}${name}`;
    expect(/^https:\/\/\S+\.fifo$/.test(url)).toBe(true); // composition/config.ts CICD_AGENT_RESULTS_QUEUE_URL
    expect(pattern(agent, "ResultsQueueArn").test(`arn:aws:sqs:us-east-1:123456789012:${name}`)).toBe(true);
  });
});

describe("platform stack: log bucket (AP-6, §12)", () => {
  it("is private: every Block Public Access flag, owner-enforced ownership (no ACLs), no website, retained on delete", () => {
    const b = on.Resources.AgentLogBucket!;
    expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(b.Properties.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] });
    for (const p of ["AccessControl", "WebsiteConfiguration", "CorsConfiguration"]) expect(b.Properties[p], p).toBeUndefined();
    expect(b.DeletionPolicy).toBe("Retain");
    expect(b.UpdateReplacePolicy).toBe("Retain");
  });

  it("encrypts with SSE-S3 only (no customer-managed KMS) and refuses uploads that are not SSE-S3", () => {
    expect(on.Resources.AgentLogBucket!.Properties.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
    });
    expect(readFileSync(samTemplatePath, "utf8")).not.toMatch(/aws:kms|KMSMasterKeyID|AWS::KMS::/);
    const deny = policyStatements(on.Resources.AgentLogBucketPolicy!).find((s) => s.Sid === "DenyUploadsNotSseS3")!;
    expect(deny).toMatchObject({ Effect: "Deny", Principal: "*", Action: "s3:PutObject", Condition: { StringNotEquals: { "s3:x-amz-server-side-encryption": "AES256" } } });
  });

  it("refuses any request without TLS, on the bucket and its objects; the bucket policy grants nothing", () => {
    const statements = policyStatements(on.Resources.AgentLogBucketPolicy!);
    expect(statements.every((s) => s.Effect === "Deny")).toBe(true);
    const tls = statements.find((s) => s.Sid === "DenyInsecureTransport")!;
    expect(tls).toMatchObject({ Principal: "*", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } });
    expect(tls.Resource).toEqual([getAtt("AgentLogBucket"), { "Fn::Sub": "${AgentLogBucket.Arn}/*" }]);
  });

  it("expires logs/ after AgentLogRetentionDays (default 90, AP-6) and aborts incomplete uploads", () => {
    const rules = (on.Resources.AgentLogBucket!.Properties.LifecycleConfiguration as { Rules: Record<string, Json>[] }).Rules;
    expect(rules).toContainEqual({ Id: "expire-agent-logs", Status: "Enabled", Prefix: "logs/", ExpirationInDays: { Ref: "AgentLogRetentionDays" } });
    expect(rules).toContainEqual({ Id: "abort-incomplete-uploads", Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } });
    expect(raw.Parameters.AgentLogRetentionDays).toMatchObject({ Type: "Number", Default: 90 });
  });

  it("the bucket name fits S3 and the Executor setting CICD_AGENT_LOG_BUCKET", () => {
    const name = sub((on.Resources.AgentLogBucket!.Properties.BucketName as { "Fn::Sub": string })["Fn::Sub"], { ...SAMPLE, Stage: "abcdefghijklmnop" });
    expect(name.length).toBeLessThanOrEqual(63);
    expect(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)).toBe(true);
  });

  it("the read policy is read-only on logs/ (GetObject, ListBucket under logs/); nobody but an agent writes", () => {
    const statements = policyStatements(on.Resources.AgentLogReadPolicy!);
    expect(statements.flatMap((s) => asArray(s.Action)).sort()).toEqual(["s3:GetObject", "s3:ListBucket"]);
    expect(statements.find((s) => s.Sid === "ReadAgentLogs")!.Resource).toEqual({ "Fn::Sub": "${AgentLogBucket.Arn}/logs/*" });
    expect(statements.find((s) => s.Sid === "ListAgentLogs")!.Condition).toEqual({ StringLike: { "s3:prefix": "logs/*" } });
    const writers = Object.entries(on.Resources).filter(([, r]) => key(r).includes('"s3:PutObject"') && r.Type !== "AWS::S3::BucketPolicy");
    expect(writers).toEqual([]);
  });
});

describe("platform stack: alarms, outputs and template hygiene", () => {
  it("adds a DLQ-not-empty and an oldest-message alarm on the results queue, wired to the optional topic", () => {
    expect(on.Resources.AgentResultsDlqNotEmptyAlarm!.Properties).toMatchObject({ MetricName: "ApproximateNumberOfMessagesVisible", Threshold: 0, Dimensions: [{ Name: "QueueName", Value: getAtt("AgentResultsDlq", "QueueName") }] });
    expect(on.Resources.AgentResultsOldestMessageAgeAlarm!.Properties).toMatchObject({ MetricName: "ApproximateAgeOfOldestMessage", Threshold: 600, Dimensions: [{ Name: "QueueName", Value: getAtt("AgentResultsQueue", "QueueName") }] });
  });

  it("outputs what the Executor configuration and the agent stacks need", () => {
    expect(on.Outputs.AgentResultsQueueUrl!.Value).toEqual({ Ref: "AgentResultsQueue" });
    expect(on.Outputs.AgentResultsQueueArn!.Value).toEqual(getAtt("AgentResultsQueue"));
    expect(on.Outputs.AgentLogBucketName!.Value).toEqual({ Ref: "AgentLogBucket" });
    expect(on.Outputs.AgentLogReadPolicyArn!.Value).toEqual({ Ref: "AgentLogReadPolicy" });
  });

  it("the full template passes the lint-style checks (E1029, W1020, W1030) and has no wildcard Action outside a Deny", () => {
    expect(embeddedVarsOutsideSub(raw as unknown as Json)).toEqual([]);
    expect(subWithoutVariable(raw.Resources as unknown as Json)).toEqual([]);
    expect(unguardedEmptyDefaultRefs(raw)).toEqual([]);
    expect(wildcardAllowActions(raw)).toEqual([]);
  });

  it("every new taggable resource carries the Project and Stage tags", () => {
    for (const name of ["AgentResultsQueue", "AgentResultsDlq", "AgentLogBucket"]) {
      expect(on.Resources[name]!.Properties.Tags, name).toEqual(expect.arrayContaining([{ Key: "Project", Value: "ONECGIAR-CICD-Platform" }, { Key: "Stage", Value: { Ref: "Stage" } }]));
    }
  });
});

/** Allow statements whose Action is "*" or "<service>:*" (Deny statements may use wildcards: they only take away). */
function wildcardAllowActions(t: CfnTemplate): string[] {
  const offenders: string[] = [];
  const walk = (node: Json, where: string): void => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${where}[${i}]`));
    else if (node !== null && typeof node === "object") {
      if (node.Effect !== "Deny" && ("Action" in node || "NotAction" in node)) {
        if ("NotAction" in node) offenders.push(`${where}.NotAction`);
        for (const a of asArray((node.Action ?? []) as string | string[])) if (a === "*" || a.endsWith(":*")) offenders.push(`${where}.Action=${a}`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
    }
  };
  walk(t.Resources as unknown as Json, "Resources");
  return offenders;
}

/** Statements whose Resource is "*" (or contains it). */
function starResources(statements: PolicyStatement[]): string[] {
  return statements.filter((s) => asArray(s.Resource as string | string[]).includes("*")).flatMap((s) => asArray(s.Action));
}

// ---------------------------------------------------------------------------------------------------- agent stack
describe("agent-stack.yaml: resources and command queue (§6, §11.4, AP-1)", () => {
  it("creates only the command queue, its DLQ and policy, the agent role, its identity binding and two alarms", () => {
    expect(Object.entries(agent.Resources).map(([n, r]) => `${n}:${r.Type}`).sort()).toEqual(
      [
        "AgentInstanceProfile:AWS::IAM::InstanceProfile",
        "AgentRole:AWS::IAM::Role",
        "AgentRolesAnywhereProfile:AWS::RolesAnywhere::Profile",
        "CommandBacklogAlarm:AWS::CloudWatch::Alarm",
        "CommandDlq:AWS::SQS::Queue",
        "CommandDlqNotEmptyAlarm:AWS::CloudWatch::Alarm",
        "CommandQueue:AWS::SQS::Queue",
        "CommandQueuePolicy:AWS::SQS::QueuePolicy",
      ].sort(),
    );
  });

  it("the command queue is FIFO with Executor-set deduplication, long polling, the agent's visibility timeout, SSE and a FIFO DLQ", () => {
    const q = agent.Resources.CommandQueue!.Properties;
    expect(q).toMatchObject({
      QueueName: { "Fn::Sub": "cicd-agent-${Stage}-${AgentId}-cmd.fifo" },
      FifoQueue: true,
      ContentBasedDeduplication: false,
      ReceiveMessageWaitTimeSeconds: 20,
      MessageRetentionPeriod: { Ref: "CommandRetentionSeconds" },
      SqsManagedSseEnabled: true,
      RedrivePolicy: { deadLetterTargetArn: getAtt("CommandDlq"), maxReceiveCount: { Ref: "CommandMaxReceiveCount" } },
    });
    // The agent's ReceiveMessage uses the same visibility timeout (src/agent/adapters.ts).
    const adapter = readFileSync(path.join(repoRoot, "executor", "src", "agent", "adapters.ts"), "utf8");
    expect(adapter).toContain(`VisibilityTimeout: ${String(q.VisibilityTimeout)},`);
    expect(agent.Resources.CommandDlq!.Properties).toMatchObject({ QueueName: { "Fn::Sub": "cicd-agent-${Stage}-${AgentId}-dlq.fifo" }, FifoQueue: true });
  });

  it("queue names fit SQS (80 characters), the agent record schema and the Executor's send permission, and the DLQ never matches it", () => {
    const longest = { ...SAMPLE, Stage: "a".repeat(16), AgentId: "b".repeat(40) };
    const cmd = sub("cicd-agent-${Stage}-${AgentId}-cmd.fifo", longest);
    const dlq = sub("cicd-agent-${Stage}-${AgentId}-dlq.fifo", longest);
    expect(cmd.length).toBeLessThanOrEqual(80);
    expect(dlq.length).toBeLessThanOrEqual(80);
    const schema = JSON.parse(readFileSync(path.join(repoRoot, "schemas", "agent-record.schema.json"), "utf8")) as { properties: { commandQueueUrl: { pattern: string } } };
    const url = `${FAKE_SQS_QUEUE_BASE}${sub("cicd-agent-${Stage}-${AgentId}-cmd.fifo", SAMPLE)}`;
    expect(new RegExp(schema.properties.commandQueueUrl.pattern).test(url)).toBe(true);
    const sendPermission = new RegExp(`^${"cicd-agent-dev-*-cmd.fifo".replace(/[.]/g, "\\.").replace("*", ".*")}$`);
    expect(sendPermission.test(sub("cicd-agent-${Stage}-${AgentId}-cmd.fifo", SAMPLE))).toBe(true);
    expect(sendPermission.test(sub("cicd-agent-${Stage}-${AgentId}-dlq.fifo", SAMPLE))).toBe(false);
    expect(sendPermission.test(sub("cicd-agent-results-${Stage}.fifo", SAMPLE))).toBe(false);
  });

  it("only the Executor role may send and only this agent's identity (its role, or the shared agent user) may consume", () => {
    const statements = policyStatements(agent.Resources.CommandQueuePolicy!);
    expect(statements.filter((s) => s.Effect !== "Deny").map((s) => s.Sid)).toEqual(["AllowExecutorSend"]);
    expect(statements.filter((s) => s.Effect === "Deny").every((s) => s.Principal === "*")).toBe(true);
    expect(statements.find((s) => s.Sid === "DenySendFromNonExecutor")).toMatchObject({ Action: "sqs:SendMessage", Condition: { ArnNotEquals: { "aws:PrincipalArn": { Ref: "ExecutorRoleArn" } } } });
    const consume = statements.find((s) => s.Sid === "DenyConsumeFromNonAgent")!;
    expect(asArray(consume.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"]);
    expect(consume.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": { "Fn::If": ["UseSharedUser", { Ref: "SharedAgentUserArn" }, getAtt("AgentRole")] } } });
  });
});

describe("agent-stack.yaml: agent role (§11.2) and identity (§11.1, AP-5)", () => {
  const statements = (): PolicyStatement[] => statementsOf(agent, "AgentRole").map((s) => ((s as unknown as { "Fn::If"?: Json[] })["Fn::If"]?.[1] ?? s) as PolicyStatement);

  it("grants exactly the agent's own calls", () => {
    const byId = Object.fromEntries(statements().map((s) => [s.Sid, s]));
    expect(Object.keys(byId).sort()).toEqual(["AssumeTargetScriptRoles", "OwnCommandQueue", "PutTargetLogs", "SendResults"]);
    expect(asArray(byId.OwnCommandQueue!.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]);
    expect(byId.OwnCommandQueue!.Resource).toEqual(getAtt("CommandQueue"));
    expect(byId.SendResults).toMatchObject({ Action: "sqs:SendMessage", Resource: { Ref: "ResultsQueueArn" } });
    expect(byId.PutTargetLogs).toMatchObject({ Action: "s3:PutObject", Resource: { "Fn::Split": [",", { Ref: "TargetLogArns" }] } });
    expect(byId.AssumeTargetScriptRoles).toMatchObject({ Action: "sts:AssumeRole", Resource: { "Fn::Split": [",", { Ref: "ScriptRoleArns" }] } });
    expect(starResources(statements())).toEqual([]);
    expect(wildcardAllowActions(agent)).toEqual([]);
  });

  it("the script-role statement exists only when ScriptRoleArns is given", () => {
    const conditional = statementsOf(agent, "AgentRole").find((s) => ((s as unknown as Record<string, Json[]>)["Fn::If"] ?? [])[0] === "HasScriptRoles") as unknown as { "Fn::If": Json[] };
    expect(conditional["Fn::If"][0]).toBe("HasScriptRoles");
    expect(conditional["Fn::If"][2]).toEqual({ Ref: "AWS::NoValue" });
  });

  it("TargetLogArns accepts per-target prefixes of the AC-04 key layout and nothing broader", () => {
    const ok = pattern(agent, "TargetLogArns");
    const one = "arn:aws:s3:::cicd-agent-logs-dev-123456789012-us-east-1/logs/prms/dev/prms-reporting-dev/*";
    expect(ok.test(one)).toBe(true);
    expect(ok.test(`${one},${one.replace("prms-reporting-dev", "prms-api-dev")}`)).toBe(true);
    for (const bad of [
      "arn:aws:s3:::cicd-agent-logs-dev-123456789012-us-east-1/logs/*",
      "arn:aws:s3:::cicd-agent-logs-dev-123456789012-us-east-1/*",
      "arn:aws:s3:::cicd-agent-logs-dev-123456789012-us-east-1/logs/prms/dev/*",
      `${one}, ${one}`,
    ]) {
      expect(ok.test(bad), bad).toBe(false);
    }
    // The key prefix the Executor puts in every command (application/agent-transport) starts with exactly this layout.
    const transport = readFileSync(path.join(repoRoot, "executor", "src", "application", "agent-transport", "index.ts"), "utf8");
    expect(transport).toContain("keyPrefix: `logs/${s.project}/${s.environment}/${item.targetId}/${item.executionId}/${dispatchToken}/`");
  });

  it("is tagged CicdAgentStage=<Stage>, the tag the platform's results queue policy requires", () => {
    expect(agent.Resources.AgentRole!.Properties.Tags).toContainEqual({ Key: "CicdAgentStage", Value: { Ref: "Stage" } });
    const platformCondition = policyStatements(on.Resources.AgentResultsQueuePolicy!).find((s) => s.Sid === "DenySendFromNonAgents")!.Condition!;
    expect(Object.keys(platformCondition.StringNotEquals!)).toEqual(["aws:PrincipalTag/CicdAgentStage"]);
  });

  it("trust has one statement per identity mode, each behind its own condition; Roles Anywhere is bound to the trust anchor and the certificate CN", () => {
    const trust = roleTrustStatements(agent.Resources.AgentRole!) as unknown as { "Fn::If": [string, PolicyStatement, Json] }[];
    expect(trust.map((t) => t["Fn::If"][0])).toEqual(["UseInstanceProfile", "UseInstanceRole", "UseRolesAnywhere"]);
    for (const t of trust) expect(t["Fn::If"][2]).toEqual({ Ref: "AWS::NoValue" });
    const [ec2, chain, anywhere] = trust.map((t) => t["Fn::If"][1]);
    expect(ec2).toMatchObject({ Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" });
    expect(chain).toMatchObject({ Principal: { AWS: { Ref: "InstanceRoleArn" } }, Action: "sts:AssumeRole" });
    expect(anywhere).toMatchObject({
      Principal: { Service: "rolesanywhere.amazonaws.com" },
      Condition: { ArnEquals: { "aws:SourceArn": { Ref: "RolesAnywhereTrustAnchorArn" } }, StringEquals: { "aws:PrincipalTag/x509Subject/CN": { Ref: "AgentId" } } },
    });
    expect(key(trust)).not.toMatch(/:root|"\*"/);
  });

  it("Rules require InstanceRoleArn and RolesAnywhereTrustAnchorArn exactly in their own mode; the profile resources follow the mode", () => {
    expect(Object.keys(agent.Rules ?? {}).sort()).toEqual(["InstanceRoleMatchesMode", "RoleModeSettings", "SharedUserMatchesMode", "TrustAnchorMatchesMode"]);
    expect(agent.Parameters.IdentityMode!.AllowedValues).toEqual(["ec2-instance-profile", "ec2-instance-role", "roles-anywhere", "shared-iam-user"]);
    expect(agent.Parameters.IdentityMode!.Default).toBeUndefined();
    expect(agent.Resources.AgentInstanceProfile!.Condition).toBe("UseInstanceProfile");
    expect(agent.Resources.AgentRolesAnywhereProfile!.Condition).toBe("UseRolesAnywhere");
    expect(agent.Resources.AgentRolesAnywhereProfile!.Properties).toMatchObject({ RoleArns: [getAtt("AgentRole")], DurationSeconds: 3600, Enabled: true });
  });

  it("outputs the registry values (queue URL, role id) and the identity binding", () => {
    expect(agent.Outputs.CommandQueueUrl!.Value).toEqual({ Ref: "CommandQueue" });
    expect(agent.Outputs.AgentRoleId!.Value).toEqual(getAtt("AgentRole", "RoleId"));
    expect(agent.Outputs.AgentRoleArn!.Value).toEqual(getAtt("AgentRole"));
  });
});

// ---------------------------------------------------------------------------------------------------- script role
describe("target-script-role.yaml (§11.3, AP-2)", () => {
  it("one role, assumable only by the agent roles that serve the target", () => {
    expect(Object.values(script.Resources).map((r) => r.Type)).toEqual(["AWS::IAM::Role"]);
    const trust = roleTrustStatements(script.Resources.ScriptRole!);
    expect(trust).toEqual([{ Sid: "AgentsServingTheTarget", Effect: "Allow", Principal: { AWS: { "Fn::Split": [",", { Ref: "AgentRoleArns" }] } }, Action: "sts:AssumeRole" }]);
    expect(script.Parameters.AgentRoleArns!.Default).toBeUndefined();
  });

  it("grants only image pulls and secret reads on the listed resources, each only when listed", () => {
    const policies = script.Resources.ScriptRole!.Properties.Policies as unknown as { "Fn::If": [string, { PolicyDocument: { Statement: PolicyStatement[] } }, Json] }[];
    expect(policies.map((p) => p["Fn::If"][0])).toEqual(["HasEcrRepositories", "HasSecrets"]);
    const statements = policies.flatMap((p) => p["Fn::If"][1].PolicyDocument.Statement);
    expect(statements.flatMap((s) => asArray(s.Action)).sort()).toEqual(
      ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"].sort(),
    );
    expect(starResources(statements)).toEqual(["ecr:GetAuthorizationToken"]);
    expect(wildcardAllowActions(script)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------- all new files
describe("agent templates: hygiene and publication policy", () => {
  it("pass the lint-style checks (E1029, W1020, W1030)", () => {
    for (const t of [agent, script]) {
      expect(embeddedVarsOutsideSub(t as unknown as Json)).toEqual([]);
      expect(subWithoutVariable(t.Resources as unknown as Json)).toEqual([]);
      expect(unguardedEmptyDefaultRefs(t)).toEqual([]);
    }
  });

  it("name no IAM role explicitly and tag every taggable resource with Project", () => {
    for (const t of [agent, script]) {
      for (const [name, r] of resourcesOfType(t, "AWS::IAM::Role")) expect(r.Properties.RoleName, name).toBeUndefined();
      for (const [name, r] of Object.entries(t.Resources)) {
        if (["AWS::SQS::QueuePolicy", "AWS::IAM::InstanceProfile"].includes(r.Type)) continue;
        expect(r.Properties.Tags, name).toContainEqual({ Key: "Project", Value: "ONECGIAR-CICD-Platform" });
      }
    }
  });

  it("contain no 12-digit number, IPv4 address, static credential or host; only agent-shared-identity.yaml creates an IAM user or key", () => {
    for (const file of [samTemplatePath, agentStackPath, scriptRolePath, sharedIdentityPath]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/);
      expect(text, file).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(text, file).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
    for (const file of [samTemplatePath, agentStackPath, scriptRolePath]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/);
      expect(text, file).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(text, file).not.toMatch(/AKIA[0-9A-Z]{16}|AWS::IAM::AccessKey|AWS::IAM::User\b/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------- shared identity
// Owner decision (2026-10-13, amends AP-5): one IAM user per platform stage shared by every agent, its access key held
// in Secrets Manager and copied by the owner into each server's .env. Each agent still has its own command queue.
describe("agent-shared-identity.yaml: the stage's shared agent user", () => {
  const userStatements = (): PolicyStatement[] =>
    (shared.Resources.AgentsUser!.Properties.Policies as unknown as { PolicyDocument: { Statement: PolicyStatement[] } }[]).flatMap((p) => p.PolicyDocument.Statement);

  it("creates exactly the user, its access key and the secret; the user has no console password and no managed policy", () => {
    expect(Object.entries(shared.Resources).map(([n, r]) => `${n}:${r.Type}`).sort()).toEqual(
      ["AgentsAccessKey:AWS::IAM::AccessKey", "AgentsCredentialsSecret:AWS::SecretsManager::Secret", "AgentsUser:AWS::IAM::User"].sort(),
    );
    const user = shared.Resources.AgentsUser!.Properties;
    for (const p of ["LoginProfile", "ManagedPolicyArns", "Groups", "PermissionsBoundary"]) expect(user[p], p).toBeUndefined();
    expect(shared.Parameters.UserName!.Default).toBe("cicd-agents");
    expect(shared.Parameters.SecretName!.Default).toBe("cicd/agents/credentials");
  });

  it("grants exactly the agent's calls on this stage's agent queues and log prefix; nothing else", () => {
    const byId = Object.fromEntries(userStatements().map((s) => [s.Sid, s]));
    expect(Object.keys(byId).sort()).toEqual(["ConsumeAgentCommandQueues", "PutAgentLogs", "SendAgentResults"]);
    expect(userStatements().every((s) => s.Effect === "Allow" && s.Condition === undefined)).toBe(true);
    expect(asArray(byId.ConsumeAgentCommandQueues!.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"]);
    expect(byId.ConsumeAgentCommandQueues!.Resource).toEqual({ "Fn::Sub": "arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:cicd-agent-${Stage}-*-cmd.fifo" });
    expect(byId.SendAgentResults).toMatchObject({ Action: "sqs:SendMessage", Resource: { "Fn::Sub": "arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:cicd-agent-results-${Stage}.fifo" } });
    expect(byId.PutAgentLogs).toMatchObject({ Action: "s3:PutObject", Resource: { "Fn::Sub": "arn:${AWS::Partition}:s3:::cicd-agent-logs-${Stage}-${AWS::AccountId}-${AWS::Region}/logs/*" } });
    expect(starResources(userStatements())).toEqual([]);
    expect(wildcardAllowActions(shared)).toEqual([]);
    // The agent's own SQS and S3 calls are exactly these actions (src/agent/adapters.ts, main.ts).
    const adapter = ["adapters.ts", "main.ts"].map((f) => readFileSync(path.join(repoRoot, "executor", "src", "agent", f), "utf8")).join("\n");
    for (const call of ["ReceiveMessageCommand", "DeleteMessageCommand", "ChangeMessageVisibilityCommand", "SendMessageCommand", "PutObjectCommand"]) expect(adapter, call).toContain(call);
  });

  it("its resources are exactly the names the platform and agent stacks create, never a DLQ or another stage", () => {
    const arnName = (s: PolicyStatement): string => sub((s.Resource as { "Fn::Sub": string })["Fn::Sub"], SAMPLE);
    const byId = Object.fromEntries(userStatements().map((s) => [s.Sid, s]));
    const consume = new RegExp(`^${arnName(byId.ConsumeAgentCommandQueues!).replace(/[.]/g, "\\.").replace("*", "[a-z0-9-]+")}$`);
    const queueArn = (name: string): string => `arn:aws:sqs:us-east-1:123456789012:${name}`;
    expect(consume.test(queueArn(sub((agent.Resources.CommandQueue!.Properties.QueueName as { "Fn::Sub": string })["Fn::Sub"], SAMPLE)))).toBe(true);
    for (const other of [sub("cicd-agent-${Stage}-${AgentId}-dlq.fifo", SAMPLE), sub("cicd-agent-results-${Stage}.fifo", SAMPLE), "cicd-agent-prod-example-server-dev-cmd.fifo", "cicd-events-dev"]) {
      expect(consume.test(queueArn(other)), other).toBe(false);
    }
    expect(arnName(byId.SendAgentResults!)).toBe(queueArn(sub((on.Resources.AgentResultsQueue!.Properties.QueueName as { "Fn::Sub": string })["Fn::Sub"], SAMPLE)));
    expect(arnName(byId.PutAgentLogs!)).toBe(`arn:aws:s3:::${sub((on.Resources.AgentLogBucket!.Properties.BucketName as { "Fn::Sub": string })["Fn::Sub"], SAMPLE)}/logs/*`);
  });

  it("is tagged CicdAgentStage=<Stage>, the tag the results queue policy requires of every sender", () => {
    expect(shared.Resources.AgentsUser!.Properties.Tags).toContainEqual({ Key: "CicdAgentStage", Value: { Ref: "Stage" } });
    expect(shared.Resources.AgentsUser!.Properties.Tags).toContainEqual({ Key: "Project", Value: "ONECGIAR-CICD-Platform" });
  });

  it("the key goes straight into the secret (keys of the .env), rotates by KeySerial, and is never an output", () => {
    expect(shared.Resources.AgentsAccessKey!.Properties).toEqual({ UserName: { Ref: "AgentsUser" }, Serial: { Ref: "KeySerial" }, Status: "Active" });
    expect(shared.Resources.AgentsCredentialsSecret!.Properties.SecretString).toEqual({
      "Fn::Sub": '{"AWS_ACCESS_KEY_ID":"${AgentsAccessKey}","AWS_SECRET_ACCESS_KEY":"${AgentsAccessKey.SecretAccessKey}"}',
    });
    expect(shared.Resources.AgentsCredentialsSecret!.Properties.Name).toEqual({ Ref: "SecretName" });
    expect(key(shared.Outputs)).not.toMatch(/AgentsAccessKey|SecretAccessKey|SecretString/);
    expect(Object.keys(shared.Outputs).sort()).toEqual(["AgentsUserArn", "CredentialsSecretArn"]);
  });

  it("passes the lint-style checks (E1029, W1020, W1030)", () => {
    expect(embeddedVarsOutsideSub(shared as unknown as Json)).toEqual([]);
    expect(subWithoutVariable(shared.Resources as unknown as Json)).toEqual([]);
    expect(unguardedEmptyDefaultRefs(shared)).toEqual([]);
  });
});

describe("agent-stack.yaml: shared-iam-user mode", () => {
  const sharedMode = (): CfnTemplate => withConditions(agent, { UseSharedUser: true, UseAgentRole: false, UseInstanceProfile: false, UseInstanceRole: false, UseRolesAnywhere: false, HasScriptRoles: false, HasTargetLogs: false });
  const roleMode = (): CfnTemplate => withConditions(agent, { UseSharedUser: false, UseAgentRole: true, UseInstanceProfile: true, UseInstanceRole: false, UseRolesAnywhere: false, HasTargetLogs: true });

  it("creates only the command queue, its DLQ and policy and the two alarms: no agent role, no identity binding", () => {
    expect(Object.keys(sharedMode().Resources).sort()).toEqual(["CommandBacklogAlarm", "CommandDlq", "CommandDlqNotEmptyAlarm", "CommandQueue", "CommandQueuePolicy"]);
    expect(Object.keys(sharedMode().Outputs).sort()).toEqual(["CommandDlqUrl", "CommandQueueArn", "CommandQueueUrl"]);
    expect(agent.Resources.AgentRole!.Condition).toBe("UseAgentRole");
    expect(agent.Conditions.UseSharedUser).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "SharedAgentUserArn" }, ""] }] });
    expect(agent.Conditions.UseAgentRole).toEqual({ "Fn::Equals": [{ Ref: "SharedAgentUserArn" }, ""] });
    expect(agent.Conditions.HasTargetLogs).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "TargetLogArns" }, ""] }] });
  });

  it("the queue is consumed by the shared user in this mode and by the agent role otherwise; the Executor alone sends in both", () => {
    const consumer = (t: CfnTemplate): Json => policyStatements(t.Resources.CommandQueuePolicy!).find((s) => s.Sid === "DenyConsumeFromNonAgent")!.Condition!.ArnNotEquals!["aws:PrincipalArn"]!;
    expect(consumer(sharedMode())).toEqual({ Ref: "SharedAgentUserArn" });
    expect(consumer(roleMode())).toEqual(getAtt("AgentRole"));
    for (const t of [sharedMode(), roleMode()]) {
      const send = policyStatements(t.Resources.CommandQueuePolicy!).find((s) => s.Sid === "DenySendFromNonExecutor")!;
      expect(send.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": { Ref: "ExecutorRoleArn" } } });
    }
  });

  it("SharedAgentUserArn accepts an IAM user ARN only; Rules tie it, TargetLogArns and ScriptRoleArns to the mode", () => {
    const ok = pattern(agent, "SharedAgentUserArn");
    expect(ok.test("arn:aws:iam::123456789012:user/cicd-agents")).toBe(true);
    expect(ok.test("")).toBe(true);
    for (const bad of ["arn:aws:iam::123456789012:role/cicd-agents", "arn:aws:iam::123456789012:root", "cicd-agents"]) expect(ok.test(bad), bad).toBe(false);
    expect(agent.Parameters.TargetLogArns!.Default).toBe("");
    expect(key(agent.Rules!.SharedUserMatchesMode)).toContain('"Ref":"SharedAgentUserArn"');
    expect(key(agent.Rules!.RoleModeSettings)).toContain('"Ref":"ScriptRoleArns"');
    expect(key(agent.Rules!.RoleModeSettings)).toContain('"Ref":"TargetLogArns"');
  });

  it("the queue name is the one the agent insists on consuming (src/agent/config.ts)", () => {
    const name = sub((agent.Resources.CommandQueue!.Properties.QueueName as { "Fn::Sub": string })["Fn::Sub"], SAMPLE);
    expect(name).toBe(ownCommandQueueName(SAMPLE.Stage, SAMPLE.AgentId));
  });
});
