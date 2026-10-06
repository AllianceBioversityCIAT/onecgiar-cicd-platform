<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §6, §11; infra/sam/template.yaml -->
# 01. AWS foundation with SAM (checkpoints A, B, C, D)

**Answer first.** You review the template (A), validate it (B), review the validation result
(C), and only then deploy (D). Each checkpoint is its own section with its own commands. Never
combine validation and deployment in one command block. If anything fails at B or C, Gate B
pauses: share the output with Claude and do not deploy.

Run everything from the repository root. Use your admin profile for AWS commands:
`--profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>`.

## Before you start: the parameter values

| Parameter (stack) | Where the value comes from |
|---|---|
| `GitHubRepositoryId`, `GitHubRepositoryOwnerId` | Numeric ids, read-only lookup in [03](03-github.md) |
| `GitHubEnvironment` | Your chosen Environment name `<GITHUB_ENVIRONMENT>` (created later in 03; the name must match exactly) |
| `PlatformWorkflowRepository` | `<GITHUB_ORG>/<PLATFORM_REPO>` |
| `PinnedWorkflowSha` | Full 40-hex commit SHA of the platform repository that contains the reusable workflow. It must equal the SHA in the caller workflow. Never a tag or branch |
| `GitHubOidcSub` | The default environment-form `sub`: `repo:<GITHUB_ORG>/<APP_REPO>:environment:<GITHUB_ENVIRONMENT>`. Confirm the real value at B2 (P-G10, see 03) |
| `ExistingGitHubOidcProviderArn` | **Leave it out (default empty) only if no GitHub OIDC provider exists in the account.** Add it to `parameter_overrides` when one exists, and **always after a failed first create or a teardown**: the stack retains the provider it created (`DeletionPolicy: Retain`), so a redeploy that tries to create it again fails because the account already holds one for that URL. An account holds one provider per URL. If one exists, pass its ARN `arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`. Find it with `aws iam list-open-id-connect-providers --profile <AWS_PROFILE_ADMIN>` (the ARN ending `oidc-provider/token.actions.githubusercontent.com`) |
| `CiEcrRepositoryArn` / `CreateProbeEcrRepository` | Either your own repository ARN, or `CreateProbeEcrRepository=true` (creates `cicd-poc-dev-probe`, immutable tags). One repository only (known limitation) |
| `ExecutorTrustedPrincipalArn`, `OperatorTrustedPrincipalArn` | IAM user or role ARNs **in the same account** that you will assume from (documented, not enforced). The Executor profile in [05](05-run-executor-node22.md) must run as the principal you put here. If you use an SSO permission-set role, the assumed-role session ARN differs from the role ARN; if an assume-role is denied later, share the error before changing anything |
| `SecretIdPrefix` | e.g. `cicd-poc/dev/` (must end with `/`). Must equal the Executor setting `CICD_SECRET_ID_PREFIX` ([02](02-secrets.md)) |
| `ReconcileScheduleState` | **`DISABLED`. Do not change it.** Blocked until spec gap G-8 is decided (the Scheduler event id is not a UUID, so every tick would be rejected and land in the DLQ) |
| `AlarmTopicArn`, `EnablePointInTimeRecovery` | Optional |

Reference: [`../../infra/sam/parameters.example.json`](../../infra/sam/parameters.example.json) lists every parameter.

### Create your local samconfig (kept out of Git)

`infra/sam/samconfig.toml` is **not** covered by `.gitignore`, so do not create it there. The `.local/` directory is ignored at any depth. Use:

```powershell
New-Item -ItemType Directory -Force executor/.local/gate-b | Out-Null
Copy-Item infra/sam/samconfig.example.toml executor/.local/gate-b/samconfig.toml
git check-ignore -v executor/.local/gate-b/samconfig.toml
```

Expected: the last command prints a line naming the `.local/` rule of `.gitignore`.

**Stop if** `git check-ignore` prints nothing. Do not continue; the file would be committable.

Edit the copy and replace every `<PLACEHOLDER>`. Keep it consistent with the parameter table above.

## Checkpoint A. Review the template and parameters

Open [`../../infra/sam/template.yaml`](../../infra/sam/template.yaml) and your `samconfig.toml`. Nothing is run. Look at:

| # | Look at | What you must see |
|---|---|---|
| A1 | `CiRole` trust policy | Exactly six conditions, all `StringEquals`: `aud`, `repository_id`, `repository_owner_id`, `environment`, `job_workflow_ref` (pinned SHA) and `sub`. No `StringLike`, no wildcard |
| A2 | `DeployQueuePolicy` | An explicit `Deny` of `sqs:SendMessage` for every principal not in the four platform roles (`ArnNotEquals`). Note this denies admins too (see B3 poison message in [07](07-verification.md)) |
| A3 | `ExecutorRole` permissions | Queue consume and send, DynamoDB on the one table plus `GSI2`, `secretsmanager` only under your `SecretIdPrefix`, logs, and `PutMetricData` limited to the `CicdExecutor` namespace. **No** ECR, S3, Lambda, CodeBuild, IAM or application secrets |
| A4 | `CiRole` permissions | `ecr:GetAuthorizationToken` (accepted `*` exception), push actions on the one repository, `sqs:SendMessage` and `sqs:GetQueueUrl` on the deploy queue only |
| A5 | `DeletionPolicy` | `Delete` on queues, table, log group and the probe repository; `Retain` on the OIDC provider (so teardown never breaks other users of it) |
| A6 | `ReconcileSchedule` | `State` comes from `ReconcileScheduleState`, which is `DISABLED` |
| A7 | Tags | `Project: cicd-poc` on taggable resources |
| A8 | Your parameters | No typo in ids, SHA length 40, prefix ends with `/`, principals are in this account |

You are satisfied when A1 to A8 hold. If not, stop and ask Claude to correct the template (B0 returns).

## Checkpoint B. `sam validate --lint`

```powershell
sam validate --lint --template-file infra/sam/template.yaml --region <AWS_REGION>
```

Expected: exit code 0 and one line saying the template is a valid SAM template, with no lint
error or warning lines. If the CLI asks for credentials, add `--profile <AWS_PROFILE_ADMIN>`;
validation does not create or change anything.

**Stop if** the exit code is not 0, or any error or lint warning is printed. Do not deploy.
Share the full output; Gate B pauses and returns to B0 for correction. Until you report this
result, checkpoint B stays **NOT EXECUTED**.

## Checkpoint C. Review the validation result

1. Re-read the output of B. Confirm: exit code 0, no `E` (error) or `W` (warning) rule ids.
2. Tell Claude the result (share the output if anything was reported).

**Stop if** you are unsure about any line. Ask before step D.

## Checkpoint D. Deploy

Only after A, B and C are clean.

```powershell
sam deploy --template-file infra/sam/template.yaml --config-file "$PWD\executor\.local\gate-b\samconfig.toml" --profile <AWS_PROFILE_ADMIN>
```

Use an absolute `--config-file` path, as above, so SAM does not resolve it against the template directory.

Behavior and expected output:

| Aspect | Detail |
|---|---|
| IAM capability | `capabilities = "CAPABILITY_IAM"` in the config (the template creates IAM roles with generated names, so `CAPABILITY_NAMED_IAM` is not needed) |
| Extra managed stack | `resolve_s3 = true` makes SAM create one extra stack `aws-sam-cli-managed-default` with a staging bucket. See "Why `resolve_s3` stays" below |
| Changeset review | `confirm_changeset = true` stops and prints the changeset. Read it: all `Add`, no `Remove`/`Modify` on a first deploy. Answer `y` only if it matches the template |
| End state | Stack `cicd-poc-dev` reaches `CREATE_COMPLETE` |

**Alternative, guided:** `sam deploy --guided --template-file infra/sam/template.yaml --profile <AWS_PROFILE_ADMIN>` asks for every value and offers to save a config file. Answer **No** to unreviewed defaults, keep `CAPABILITY_IAM`, set the same parameters, and save the generated config as `executor/.local/gate-b/samconfig.toml` when it asks for the file name (not in the repository tree). Then verify: `git check-ignore -v executor/.local/gate-b/samconfig.toml` must print the `.local/` rule, and `git status` must show no new `samconfig.toml`. **Stop if** a `samconfig.toml` appeared elsewhere in the tree: move it under `executor/.local/gate-b/` before doing anything else.

**Stop if** the stack ends in `ROLLBACK_COMPLETE`/`CREATE_FAILED`. Read the first failed event:

```powershell
aws cloudformation describe-stack-events --stack-name cicd-poc-dev --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION> --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output table
```

Known case: **IAM propagation.** If `DeployQueuePolicy` fails on first create with an invalid principal, wait about a minute and run the deploy again (a failed first create leaves the stack in `ROLLBACK_COMPLETE`; delete it with `aws cloudformation delete-stack --stack-name cicd-poc-dev --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>` first, then deploy again). **If the failed create had already made the OIDC provider, it is retained: before redeploying, set `ExistingGitHubOidcProviderArn` to its ARN** (`aws iam list-open-id-connect-providers --profile <AWS_PROFILE_ADMIN>`), or the second create fails because the provider exists. Other errors: share them.

### Record the stack outputs

```powershell
aws cloudformation describe-stacks --stack-name cicd-poc-dev --query "Stacks[0].Outputs" --output table --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: 16 rows, including `DeployQueueUrl`, `DeployQueueName`, `DeployQueueArn`, `DeployDlqUrl`, `ExecutionsTableName`, `CiRoleArn`, `ExecutorRoleArn`, `OperatorRoleArn`, `SchedulerRoleArn`, `CiRoleId`, `ExecutorRoleId`, `OperatorRoleId`, `SchedulerRoleId`, `OidcProviderArn`, `CiEcrRepositoryArn`, `ExecutorLogGroupName`.

| Output | Used for |
|---|---|
| `DeployQueueUrl`, `ExecutionsTableName` | `executor.env` ([05](05-run-executor-node22.md)) and the AWS CLI checks ([07](07-verification.md)) |
| `ExecutorRoleArn` | `role_arn` of the Executor profile ([05](05-run-executor-node22.md)) |
| `OperatorRoleArn` | `role_arn` of the operator profile ([07](07-verification.md)) |
| `CiRoleArn` | GitHub Environment **secret** `CICD_ROLE_ARN` ([03](03-github.md)) |
| `DeployQueueName` | GitHub Environment variable `CICD_DEPLOY_QUEUE_NAME` |
| `CiEcrRepositoryArn` | The repository **name** (last path segment) becomes `CICD_ECR_REPOSITORY` |
| `CiRoleId`, `ExecutorRoleId`, `OperatorRoleId`, `SchedulerRoleId` | Contents of the identifier secrets ([02](02-secrets.md)). Role IDs, not ARNs |

Keep the outputs in a local note under `executor/.local/` (never in Git).

### Inspect resources and detect drift

```powershell
aws cloudformation describe-stack-resources --stack-name cicd-poc-dev --query "StackResources[].[LogicalResourceId,ResourceType,ResourceStatus]" --output table --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
aws cloudformation detect-stack-drift --stack-name cicd-poc-dev --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: every resource `CREATE_COMPLETE`; the second command prints a `StackDriftDetectionId`. Then:

```powershell
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id <STACK_DRIFT_DETECTION_ID> --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: `DetectionStatus` `DETECTION_COMPLETE` and `StackDriftStatus` `IN_SYNC`. Repeat until the detection completes.

**Stop if** `StackDriftStatus` is `DRIFTED` right after creation. List details with `aws cloudformation describe-stack-resource-drifts --stack-name cicd-poc-dev --stack-resource-drift-status-filters MODIFIED DELETED --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>` and share them.

Also confirm the schedule is disabled:

```powershell
aws scheduler get-schedule --name cicd-reconcile-dev --query State --output text --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: `DISABLED`. **Do not enable it** (blocked until G-8 is decided).

## Why `resolve_s3` stays

`resolve_s3` is kept because it is unverified whether `sam deploy` works without a bucket; the template has no local artifacts, so a bucket looks unnecessary, but Claude could not test that without running SAM CLI. `infra/sam/samconfig.example.toml` therefore keeps `resolve_s3 = true`, accepting one extra stack (`aws-sam-cli-managed-default`) and its bucket. [08-teardown](08-teardown.md) removes both. If you prefer no extra stack, you may test removing `resolve_s3` and passing your own `--s3-bucket`; report what happens.
