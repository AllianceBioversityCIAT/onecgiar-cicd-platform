<!-- @akili-spec changes/cicd-executor-poc architecture-change-04 §11, §12, §14, §19 (E5), §24 -->
# 11. Agent transport on AWS (AC-04 E5): central resources, change sets, cleanup

**Answer first.**
- **No compute.** E5 creates **no compute of any kind** (owner decision, 2026-10-13). The agent runs on an existing
  TEST server the owner chooses and administers: [12-agent-test-server.md](12-agent-test-server.md).
- **What AWS holds.** Only the central communication resources of AC-04 (SQS, IAM, the log bucket). Each step below
  needs the owner's **explicit authorization**; nothing here has been executed.
- **Every procedure keeps the existing parameters of `cicd-poc-dev` exactly.** In particular `AdditionalCiRoleArns`,
  whose loss would break the GitHub Actions flow (see "Critical finding").

## 1. Central AWS resources that still need authorization

| # | Item | Type of operation | Creates or changes |
|---|---|---|---|
| R | Read-only queries R1–R6 (§3) | Read | Nothing |
| A0 | Platform change set with `EnableAgentTransport=false` | Change set (proposal) | Nothing; must show **no change** |
| A1 | Platform change set with `EnableAgentTransport=true`, reviewed | Change set (proposal) | Nothing until executed |
| A1-X | Execute A1 | Stack update | Results FIFO queue + DLQ + policy, log bucket + policy, read-only log policy, 2 alarms. `ExecutorRole` is not modified (its grant is in the results queue policy) |
| U | Shared agent identity, once per stage ([13](13-agent-shared-identity.md) §6) | Stack create | IAM user `cicd-agents`, its access key, secret `cicd/agents/credentials` |
| G | Agent stack for the TEST server's `<AGENT_ID>` (§5), change set then execution | Stack create | Command FIFO queue + DLQ + policy, 2 alarms; in a role mode also the agent role and its identity binding |
| I-B | Mode B only: associate the agent stack's instance profile with the TEST instance | EC2 association | The instance's IAM profile (only if it has none) |
| I-C | Mode C only: one Roles Anywhere trust anchor from the owner's self-managed CA | Roles Anywhere | A trust anchor (no AWS Private CA) |
| X | Cleanup (§7) | Stack delete or update | Removes G; optionally reverts A1 |

**Not needed for E5:**
- no compute;
- no registry change;
- no change to the central Executor, its configuration or its restart;
- no script role;
- no GitHub change.

The Executor-driven test (`CICD_AGENT_*` plus an Executor restart) is a later, separate authorization.

## 2. Local evidence (done, no AWS)

| Check | Result |
|---|---|
| `template.yaml`, switch off, vs deployed (`bf5d9df`) | Resources, outputs, conditions **identical**; 3 parameters added with defaults; none removed or changed |
| Switch on vs deployed | **Add** 8: `AgentResultsQueue`, `AgentResultsDlq`, `AgentResultsQueuePolicy`, `AgentLogBucket`, `AgentLogBucketPolicy`, `AgentLogReadPolicy`, `AgentResultsDlqNotEmptyAlarm`, `AgentResultsOldestMessageAgeAlarm`. **Modify**: none (the Executor's grants are in the queue policies). **Remove**: none |
| Tables, deploy queue and policy, `CiRole`, OIDC provider, schedule, existing alarms | Unchanged with the switch on or off (contract test) |
| SSH transport, GitHub Actions, Executor restart | Not affected; no restart needed |
| `sam validate --lint` | 5/5 templates |

**Critical finding (corrected 2026-10-13).** `executor/.local/gate-b/samconfig.toml` (2026-10-08) is stale: it predates
change set B (2026-10-10) and has no `AdditionalCiRoleArns`. Checked in the SAM CLI 1.151.0 source
(`samcli/commands/deploy/deploy_context.py`, `merge_parameters`):
- `sam deploy` sends `UsePreviousValue` for every template parameter missing from `parameter_overrides`. A missing
  `AdditionalCiRoleArns` therefore keeps its current value; it does **not** fall back to the template default.
- The real risk of a stale file is the opposite: every parameter it **does** list overwrites the deployed value with an
  old one.
- SAM rejects an empty override written as `Key=`. An empty value must be written as `Key=""` (escaped in TOML), which
  SAM reads as an empty string.

Every deploy config of E5 is therefore built from R2, with every current parameter written explicitly
(`AdditionalCiRoleArns` included), and A0 proves it.

## 3. Read-only queries (R)

```powershell
$P = "<AWS_PROFILE_ADMIN>"; $R = "<AWS_REGION>"; $S = "cicd-poc-dev"
New-Item -ItemType Directory -Force executor/.local/e5 | Out-Null          # ignored by Git (.local/)
aws sts get-caller-identity --profile $P --query Account --output text      # R1: must print <AWS_ACCOUNT_ID>
aws cloudformation describe-stacks --stack-name $S --region $R --profile $P --query "Stacks[0].{Status:StackStatus,Parameters:Parameters,Tags:Tags,Capabilities:Capabilities,Outputs:Outputs}" --output json > executor/.local/e5/stack-before.json   # R2
aws cloudformation get-template --stack-name $S --region $R --profile $P --template-stage Original --query TemplateBody --output text > executor/.local/e5/deployed-template.yaml   # R3
aws cloudformation list-change-sets --stack-name $S --region $R --profile $P --output table   # R4: none pending
aws cloudformation list-stack-resources --stack-name $S --region $R --profile $P --output json > executor/.local/e5/resources-before.json   # R5
$Q = aws cloudformation describe-stacks --stack-name $S --region $R --profile $P --query "Stacks[0].Outputs[?OutputKey=='DeployQueueUrl'].OutputValue" --output text
aws sqs get-queue-attributes --queue-url $Q --attribute-names Policy --region $R --profile $P --output json > executor/.local/e5/deploy-queue-policy-before.json   # R6
```

**Stop if:**
- the account differs;
- the status is not `*_COMPLETE`;
- a change set is pending;
- R3 differs in content from `git show bf5d9df:infra/sam/template.yaml`.

R2 also gives `ExecutorRoleArn` and `ExecutorRoleId`, which the TEST server configuration needs.

## 4. Platform change sets A0 and A1

1. Create `executor/.local/e5/samconfig-a0.toml` and `samconfig-a1.toml` from the Gate B config.
   - `parameter_overrides` = **every** parameter of R2 with its current value (`AdditionalCiRoleArns` included), plus
     `AgentResultsRetentionSeconds=345600` and `AgentLogRetentionDays=90`. Empty values as `Key=""` (see "Critical
     finding").
   - `EnableAgentTransport=false` in A0, `true` in A1.
   - A0 is automated by a local script (not versioned: it names the account) that checks the account, region and
     parameters, creates the change set without executing it, keeps the evidence and deletes it.
   - Keep `tags = "Project=ONECGIAR-CICD-Platform"` and `capabilities = "CAPABILITY_IAM"`.
2. A0, which must print `No changes to deploy`:

   ```powershell
   sam deploy --template-file infra/sam/template.yaml --config-file "$PWD\executor\.local\e5\samconfig-a0.toml" --profile $P --no-execute-changeset
   ```

   Any listed change means a parameter value is wrong: stop.
3. A1:

   ```powershell
   sam deploy --template-file infra/sam/template.yaml --config-file "$PWD\executor\.local\e5\samconfig-a1.toml" --profile $P --no-execute-changeset
   aws cloudformation describe-change-set --change-set-name <CHANGE_SET_ARN> --region $R --profile $P --query "Changes[].ResourceChange.{Action:Action,Id:LogicalResourceId,Type:ResourceType,Replacement:Replacement,Scope:join(',',Scope)}" --output table
   aws cloudformation describe-change-set --change-set-name <CHANGE_SET_ARN> --region $R --profile $P --output json > executor/.local/e5/change-set-a1.json
   ```

**Expected A1:** the 8 `Add` of §2. Nothing else: no `Modify`, `ExecutorRole` included.

**Stop on any of these:**
- a `Remove`;
- a `Replacement` that is `True` or `Conditional`;
- any other `Modify`, above all `DeployQueue`, `DeployQueuePolicy`, `CiRole`, the tables, the OIDC provider, the
  schedule or the probe repository;
- `Metadata`-only changes (`SamResourceId`);
- a bucket name that already exists.

**Cancel without executing:** `aws cloudformation delete-change-set --change-set-name <CHANGE_SET_ARN> --region $R --profile $P`.
It only removes the proposal.

**Execute (A1-X, separate approval):** `aws cloudformation execute-change-set --change-set-name <CHANGE_SET_ARN> --region $R --profile $P`.

**After A1-X:**
- the stack is `UPDATE_COMPLETE`, with the 5 new outputs;
- R6 repeated is **identical**;
- the Executor role's policy is identical to before;
- the bucket has its public-access block and encryption;
- the results queue attributes are FIFO, with deduplication, retention and redrive.

The running Executor is neither restarted nor affected.

## 5. Agent stack for the TEST server (G)

**Owner decision (2026-10-13):** `IdentityMode=shared-iam-user` with `SharedAgentUserArn` (output of step U); the
command, expected change set and server setup are in [13](13-agent-shared-identity.md) §6. The modes below remain
for later use.

The identity mode comes from data D3 of [12](12-agent-test-server.md); see its §6.1 for the trade-offs. The target and
prefix are those of the no-op catalog.

The `<…Arn>` and `<…Name>` values are outputs of `cicd-poc-dev` after A1-X: repeat the R2 query.

```powershell
aws cloudformation deploy --region $R --profile $P --template-file infra/sam/agent-stack.yaml `
  --stack-name cicd-agent-dev-<AGENT_ID> --capabilities CAPABILITY_IAM --no-execute-changeset `
  --tags Project=ONECGIAR-CICD-Platform `
  --parameter-overrides Stage=dev AgentId=<AGENT_ID> ExecutorRoleArn=<ExecutorRoleArn> `
    ResultsQueueArn=<AgentResultsQueueArn> `
    "TargetLogArns=arn:aws:s3:::<AgentLogBucketName>/logs/cicd-pilot/test/pilot-noop-test/*" `
    IdentityMode=<MODE> <MODE_PARAMETER>
```

| Mode (12 §6.1) | `IdentityMode` | `<MODE_PARAMETER>` | Expected change set |
|---|---|---|---|
| A, existing instance role | `ec2-instance-role` | `InstanceRoleArn=<INSTANCE_ROLE_ARN>` (from D3) | Add `CommandDlq`, `CommandQueue`, `CommandQueuePolicy`, `AgentRole`, `CommandDlqNotEmptyAlarm`, `CommandBacklogAlarm` |
| B, new instance profile | `ec2-instance-profile` | (none) | The same + `AgentInstanceProfile`; then I-B: `aws ec2 associate-iam-instance-profile --instance-id <INSTANCE_ID> --iam-instance-profile Name=<InstanceProfileName>` |
| C, Roles Anywhere | `roles-anywhere` | `RolesAnywhereTrustAnchorArn=<TRUST_ANCHOR_ARN>` (I-C first) | The same + `AgentRolesAnywhereProfile` |
| D, owner-issued session (pilot only) | `ec2-instance-role` | `InstanceRoleArn=<OWNER_ROLE_ARN>` | Same as A; the trust names the owner's role. Delete the stack after the test |

Review with `describe-change-set` (only `Add`, nothing else), then execute it after approval. For a new stack the
change set leaves an empty stack in `REVIEW_IN_PROGRESS`. If the change set is rejected, delete the change set and
then that empty stack (`delete-stack`); this touches nothing else.

**Outputs for the TEST server:**

| Output | Where it goes |
|---|---|
| `CommandQueueUrl` | `agent.json` |
| `AgentRoleArn` | AWS config (modes A and C), or `assume-role` (mode D) |
| `AgentRoleId` | Expected `SenderId` prefix of the agent's events |

**I-C, self-managed CA (owner's workstation, no AWS Private CA).** Create an offline CA key and certificate with
OpenSSL. Only its certificate is uploaded:

```powershell
aws rolesanywhere create-trust-anchor --name cicd-agents-dev --enabled --source "sourceType=CERTIFICATE_BUNDLE,sourceData={x509CertificateData=<CA_CERT_PEM>}" --region $R --profile $P
```

Sign the server's request (12 §6.1) with `CA:FALSE`, `keyUsage=digitalSignature` and CN = `<AGENT_ID>`.

## 6. Reviews

### 6.1 SQS (consistent with E1–E3)

| Setting | Commands | Results | Code that relies on it |
|---|---|---|---|
| Type, deduplication | FIFO; `commandId`, queries `commandId:q<n>`; no content-based | FIFO; `commandId:seq` | E2 dispatcher, E3 sink; 5-minute window |
| `MessageGroupId` | `targetId` | `executionId` (heartbeats `agent#<agentId>`) | E1 `fifo` helpers |
| Visibility timeout | 120 s (+60 s at a time while waiting for a slot) | 120 s (extended by the consumer) | E3 adapter; E2 consumer default |
| Long polling | 20 s | 20 s | Both consumers |
| Retention | 4 days | 4 days | Queries continue up to 48, then the operator |
| DLQ | 5 receives, 14 days, alarm | 5 receives, 14 days, alarm | Poison messages are not acknowledged |
| Senders | Executor role only (explicit deny) | Roles tagged `CicdAgentStage=<Stage>` only | The agent checks `SenderId`; the Executor maps it to the registered agent role. A wrongly tagged role still cannot impersonate an agent |
| Consumers | The agent role only | The Executor role only | During the TEST pilot the owner reads results under the Executor role |

| Situation | Behavior |
|---|---|
| Agent disconnected | Commands wait in SQS for 4 days; the backlog alarm fires after 15 min. With the Executor: re-send, queries after `notAfter`, X16 held at the hard deadline; on return every rule applies |
| Past `notAfter` | `NOT_STARTED EXPIRED`, never run |
| Received, failure before confirming | Before `ACCEPTED`: visible again after 120 s. After `ACCEPTED`: `NOT_STARTED ABANDONED`. After `STARTING`: the still-running script is stopped on restart, then `LOST` |
| Duplicate | SQS drops it inside 5 minutes. Later, the journal re-sends the last event and nothing runs again |
| In a DLQ | Evidence only, never redriven: the command queue accepts no sender but the Executor. Queries resolve it (`NEVER_SEEN` or hold) |
| Unknown outcome | `LOST` or timeout gives X16 with the lock held (AP-3), released only by the operator or by verified never-started evidence |

### 6.2 S3

| Requirement | Template | TEST pilot check (12) |
|---|---|---|
| Block Public Access, no ACLs | All four flags, `BucketOwnerEnforced` | Stage 7 |
| SSE-S3 | Default `AES256`; other uploads denied | `head-object` gives `AES256` (stage 7); T12 |
| HTTPS only | Deny when `aws:SecureTransport=false` | T11 |
| Write per target | `TargetLogArns` only; the pattern rejects anything broader | T12 (mode D) |
| Team read | `AgentLogReadPolicy`, read-only on `logs/` | Optional attachment |
| 90 days (DEV) | `AgentLogRetentionDays=90` on `logs/` | `get-bucket-lifecycle-configuration` |
| Upload failure, partial logs | Retried 24 h, then `FAILED` with the local copy kept; partial output uploaded after `LOST` | T7 |

### 6.3 Alarms

| Alarm | Works immediately | During the TEST pilot |
|---|---|---|
| Results DLQ not empty | Yes (SQS) | Informative |
| Results oldest message age | Yes (SQS) | **Fires** whenever events are not read within 10 min: the Executor does not consume them in this pilot. Read with `Read-Results` (12 §6), no alarm action |
| Command DLQ not empty, command backlog | Yes (SQS) | The backlog alarm is useful (T5 stops the agent) |
| Stale agent, holds | **Not defined**: they need Executor metrics (E7) | — |

Four alarms cost about USD 0.40/month; there is no alarm action (`AlarmTopicArn` empty) during the pilot.

## 7. Cleanup (X)

1. Remove the agent from the TEST server (12 §10).
2. Delete the agent stack: `aws cloudformation delete-stack --stack-name cicd-agent-dev-<AGENT_ID> --region $R --profile $P`.
   For mode B, disassociate the instance profile first. For mode C, keep or delete the trust anchor.
3. Platform: keep the transport for E6, or revert with a change set built like A0 but against the post-A1 state
   (`EnableAgentTransport=false`). It must show 8 `Remove` only. The log bucket is
   **retained**: empty and delete it by hand before enabling the switch again, otherwise the bucket name collides.

## 8. Costs (us-east-1 list prices; confirm with the AWS Pricing Calculator)

| Item | TEST pilot: 1 agent on an existing server, a few days | Later: 5+ agents, monthly |
|---|---|---|
| Compute | **0** (existing server) | 0 (existing servers) |
| SQS | Tens of thousands of requests: inside the always-free first million per month | Up to about 1 M requests: USD 0–1 |
| S3 | Kilobytes: under USD 0.01 | About 1 GB at 90 days: under USD 0.10 |
| CloudWatch alarms | 4: about USD 0.40/month, prorated | 2 + 2 per agent: about USD 1.20 |
| Data transfer | In-region from EC2: 0. From outside AWS: inbound free, responses a few KB (well inside the 100 GB/month free outbound tier) | About 0 |
| Credentials | Modes A, B, D: 0. Mode C with a self-managed CA: 0 | 0 (no AWS Private CA) |
| **Total** | **Under USD 1** | **About USD 1–3 / month** |

## 9. Open decisions

1. Authorize, as separate steps: R; then A0 and A1 (create, review, delete or keep); then A1-X; then G (and I-B or
   I-C if needed).
2. The TEST server, and its identity mode after D3 (A recommended on EC2 with a profile; otherwise D first, C later).
3. Commit of the E5 documents and `infra/agent/pilot/` (needed to package `noop-deploy.sh` from a commit).
4. Later: the Executor-driven test (agent settings plus an Executor restart).
5. IMDSv2 with hop limit 1 on shared EC2 servers before agents are installed there.
6. Per-environment log retention within a platform stage (object tags) when STAGING and PROD are onboarded.
