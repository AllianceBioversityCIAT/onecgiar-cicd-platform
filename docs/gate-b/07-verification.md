<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §3 (B1 to B5), §6; design §5.1, §12; adapters/dynamodb-state-store/keys.ts -->
# 07. Verification and expected evidence (B1 to B5)

**Answer first.** You read state with `aws dynamodb get-item`/`query` (key shapes below),
queue health with `aws sqs get-queue-attributes`, and alarm state with `aws cloudwatch
describe-alarms`. The Executor log is the console of the workstation run (not CloudWatch). For the
poison-message test you must send as the **operator role**: the queue policy denies
`SendMessage` to everyone else, admins included.

Use `--profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>` on read commands (omitted below for brevity; add them). `<EXECUTIONS_TABLE_NAME>`, `<DEPLOY_QUEUE_URL>`, `<DLQ_URL>` are stack outputs ([01](01-aws-sam.md)).

## Reading DynamoDB state

### Key shapes (from `executor/src/adapters/dynamodb-state-store/keys.ts`)

| Item | `pk` | `sk` |
|---|---|---|
| Execution | `EXEC#<EXECUTION_ID>` | `META` |
| Dedupe (gives the execution id) | `DEDUPE#<DEPLOYMENT_ID>#<REQUEST_ID>` | `DEDUPE` |
| Rejection | `REJECT#<DEPLOYMENT_ID>#<REQUEST_ID>` (or `REJECT#MSG#<SQS_MESSAGE_ID>` when the body was unusable) | `META` |
| Deploy window | `WINDOW#<LOCK_KEY>` | `WINDOW` |
| Per-deployment sequence | `DEPLOYMENT#<DEPLOYMENT_ID>` | `SEQ` |
| Target state (`lastDeployed`, `highestAccepted`, `unresolved[]`) | `TARGET#<LOCK_KEY>` | `STATE` |
| Distributed lock | `LOCK#<LOCK_KEY>` | `LOCK` |
| Event mark | `EXEC#<EXECUTION_ID>` | `EVT#<EVENT_KEY>` |

`<REQUEST_ID>` is `<RUN_ID>-<RUN_ATTEMPT>` of the GitHub run (the request id equals `ci.runId-ci.runAttempt`).

### Commands (Git Bash syntax)

```bash
aws dynamodb get-item --table-name <EXECUTIONS_TABLE_NAME> --consistent-read --key '{"pk":{"S":"DEDUPE#<DEPLOYMENT_ID>#<REQUEST_ID>"},"sk":{"S":"DEDUPE"}}'
aws dynamodb get-item --table-name <EXECUTIONS_TABLE_NAME> --consistent-read --key '{"pk":{"S":"EXEC#<EXECUTION_ID>"},"sk":{"S":"META"}}'
aws dynamodb query --table-name <EXECUTIONS_TABLE_NAME> --index-name GSI2 --key-condition-expression "activeStatus = :s" --expression-attribute-values '{":s":{"S":"EXECUTION"}}'
```

The first returns the `executionId`. The third lists non-terminal executions (use `"WINDOW"` for open windows). Executions have no secondary index by deployment, so to list them in this small PoC table:

```bash
aws dynamodb scan --table-name <EXECUTIONS_TABLE_NAME> --filter-expression "begins_with(pk, :p) AND sk = :m" --expression-attribute-values '{":p":{"S":"EXEC#"},":m":{"S":"META"}}' --projection-expression "executionId, deploymentId, #s, requestId, senderRef" --expression-attribute-names '{"#s":"status"}'
```

### Commands (PowerShell 5.1)

PowerShell 5.1 mangles embedded double quotes passed to native programs. Put the JSON in a file and pass `file://`:

```powershell
function Get-CicdItem([string]$Pk, [string]$Sk) {
  $f = Join-Path $PWD "executor/.local/key.json"
  [System.IO.File]::WriteAllText($f, ('{"pk":{"S":"' + $Pk + '"},"sk":{"S":"' + $Sk + '"}}'), (New-Object System.Text.UTF8Encoding $false))
  aws dynamodb get-item --table-name <EXECUTIONS_TABLE_NAME> --consistent-read --key "file://executor/.local/key.json" --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
}
Get-CicdItem "EXEC#<EXECUTION_ID>" "META"
```

Expected: an `Item` with `status`, `deploymentId`, `requestId`, `senderRef`, `commitSha`, `artifacts`, `order`, `ci` and timestamps (the fields are described in [`../runbook.md`](../runbook.md), "Reconstructing an execution"). An empty response means the key is wrong.

## Queue, DLQ and alarms

```powershell
aws sqs get-queue-attributes --queue-url <DEPLOY_QUEUE_URL> --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
aws sqs get-queue-attributes --queue-url <DLQ_URL> --attribute-names ApproximateNumberOfMessages --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
aws cloudwatch describe-alarms --alarm-name-prefix cicd-dev- --query "MetricAlarms[].[AlarmName,StateValue]" --output table --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected with an idle healthy Executor: all queue counts 0; `dlq-not-empty` and `oldest-message-age` `OK`. The three EMF-based alarms are not meaningful in the workstation run ([05](05-run-executor-node22.md), section 8). Slack: the root message and its thread show the execution timeline with the GitHub run link. The log group `/cicd/executor/<STAGE>` exists but receives nothing unless you ship the logs yourself.

## Operator profile (needed for B3 poison message and B5 windows)

`SendMessage` on the queue is denied to every principal except the four platform roles, so even admins cannot send. Assume the operator role through a profile. Add to `~/.aws/config`:

```ini
[profile <OPERATOR_PROFILE_NAME>]
role_arn = <OPERATOR_ROLE_ARN>
source_profile = <AWS_PROFILE_ADMIN>
region = <AWS_REGION>
```

`<OPERATOR_ROLE_ARN>` is the stack output `OperatorRoleArn`; the source profile must run as the stack's `OperatorTrustedPrincipalArn`. Check:

```powershell
aws sts get-caller-identity --profile <OPERATOR_PROFILE_NAME>
```

Expected: an `assumed-role/<OPERATOR_ROLE_NAME>/...` ARN. Equivalent explicit form: `aws sts assume-role --role-arn <OPERATOR_ROLE_ARN> --role-session-name gate-b-operator --profile <AWS_PROFILE_ADMIN>` returns temporary credentials; prefer the profile so no credential is copied by hand.

## B1. AWS foundation

| Evidence | How | Expected |
|---|---|---|
| Stack outputs | [01](01-aws-sam.md) | `CREATE_COMPLETE`, 16 outputs |
| Secrets exist | `describe-secret` per ref ([02](02-secrets.md)) | All present |
| Startup | Executor console ([05](05-run-executor-node22.md)) | `executor started` with the right `deployments` count; no refusal |
| Heartbeat | Console heartbeat lines; the healthcheck file's timestamp | Updated about every minute. The CloudWatch heartbeat metric has **no data** in this run (EMF not shipped); do not treat the alarm state as a failure |
| Scheduler-originated `RECONCILE_TICK` consumed | **Checkpoint.** Only when the Executor is running ([05](05-run-executor-node22.md)) and you decide to enable the schedule. In your local `executor/.local/gate-b/samconfig.toml`, change `ReconcileScheduleState=DISABLED` to `ReconcileScheduleState=ENABLED` in `parameter_overrides` (keep every other value), then run the checkpoint D deploy command of [01](01-aws-sam.md) unchanged. The changeset must show only `Modify` on `ReconcileSchedule`; answer `n` otherwise. Wait at least 5 minutes. To stop ticks, set it back to `DISABLED` in the same file and redeploy the same way | Executor console shows the line `RECONCILE_TICK consumed` (with a generated `correlationId`) about every 5 minutes; `aws scheduler get-schedule --name cicd-reconcile-dev --query State --output text` prints `ENABLED`; the DLQ stays empty. G-8 is resolved: the tick carries no `eventId` |
| Negative: the Executor role cannot read an application secret | `aws secretsmanager get-secret-value --secret-id <APPLICATION_SECRET_NAME> --profile <EXECUTOR_PROFILE_NAME>` and `aws ecr describe-repositories --profile <EXECUTOR_PROFILE_NAME>` | `AccessDeniedException` for both |

## B2. GitHub OIDC to SQS to the local Executor

| Evidence | How | Expected |
|---|---|---|
| Public-safe workflow log | [03](03-github.md), section 8 | No credential-like value; the role ARN and account id are expected (G-10); masking of the registry host and queue URL is hygiene only |
| Request accepted | Executor console, then the dedupe and execution `get-item` | The log shows the message acknowledged; the execution exists and `status` first `QUEUED` |
| Sender identity (P-A4) | `senderRef` on the execution item | The CI role id (stack output `CiRoleId`), without a session suffix (the Executor stores the role-id part only); record the observed form |
| Window closed outcome | Execution item (target registry has `deployWindowPolicy: required` and no window is open) | `status` `FAILED` with `DEPLOY_WINDOW_CLOSED`; no SSH connection was made |
| Pinned premises | [03](03-github.md), sections 4 and 7 | P-A4, P-G10, P-G11, P-G14, G-3, G-4, P-A3 each recorded as observed, with the real claim strings sanitized |
| Negatives | [03](03-github.md), section 9 | `pull_request`, `pull_request_target`, `workflow_run` never reach `push-and-send` and never obtain credentials |
| Negative: wrong sender | "Wrong sender" below | A schema-valid `DEPLOY_REQUESTED` sent by the operator role is `REJECTED` with `UNAUTHORIZED_SENDER` |

## B3. State, dedupe, locks

Common setup: the target has `deployWindowPolicy: required` and **no window open**, so each accepted request ends `FAILED (DEPLOY_WINDOW_CLOSED)` quickly, with no SSH. **Stop if** the definition says `not-required` or a window is open: do not trigger any workflow ([04](04-definitions-and-target.md)). Ordering still applies.

| Test | Steps | Expected evidence |
|---|---|---|
| Re-run of the same run | In GitHub, **Re-run all jobs** on a finished run | A GitHub re-run increments the run attempt, so the request id is `<RUN_ID>-<NEXT_ATTEMPT>`: a **new** dedupe key and a new execution with the **same** `runNumber` (equal order is not older). It is not `SUPERSEDED`. A true duplicate (the same request id delivered twice) is logged as `duplicate DEPLOY_REQUESTED ignored` and creates no second execution; you cannot force it from outside (the queue accepts requests only from the CI role). Record what you observe |
| Older build after a newer one | Run the workflow twice (run N, then run N+1) and wait until N+1 is accepted; then **Re-run all jobs** on run N | The re-run of N has a lower order than `highestAccepted` on `TARGET#<LOCK_KEY>`: its execution is `SUPERSEDED`. Read the target state item to see `highestAccepted` |
| Reconciler activity | Requires the schedule enabled as in the checkpoint above | `RECONCILE_TICK consumed` lines appear and the reconciler acts on overdue executions; record what you observe. If you did not enable the schedule, record as not executed |
| Poison message to the DLQ | Below | Message lands in the DLQ after 5 receives; the DLQ alarm fires |

### Wrong sender (negative; send as the operator role)

The operator role may enqueue, but it has no right to request a deploy: a `DEPLOY_REQUESTED` from it must be rejected. Create a schema-valid body with obviously fake values (the unit name and `deploymentId` must be your real ones so the rejection is about the sender):

```powershell
[System.IO.File]::WriteAllText((Join-Path $PWD "executor/.local/wrong-sender.json"), '{"specVersion":1,"eventType":"DEPLOY_REQUESTED","requestId":"900000001-1","deploymentId":"<DEPLOYMENT_ID>","commitSha":"0000000000000000000000000000000000000000","artifacts":{"<UNIT>":"sha256:0000000000000000000000000000000000000000000000000000000000000000"},"ci":{"repository":"<GITHUB_ORG>/<APP_REPO>","workflowRef":"<WORKFLOW_REF>","runId":"900000001","runAttempt":1,"runNumber":1}}', (New-Object System.Text.UTF8Encoding $false))
aws sqs send-message --queue-url <DEPLOY_QUEUE_URL> --message-body file://executor/.local/wrong-sender.json --profile <OPERATOR_PROFILE_NAME> --region <AWS_REGION>
```

Expected: a `MessageId`. Then read the rejection item (key shape `REJECT#<DEPLOYMENT_ID>#<REQUEST_ID>`, sort key `META`, from `keys.ts`):

```powershell
Get-CicdItem "REJECT#<DEPLOYMENT_ID>#900000001-1" "META"
```

Expected: an `Item` whose reason is `UNAUTHORIZED_SENDER` and whose `senderRef` is the operator role id (stack output `OperatorRoleId`), without a session suffix. No execution exists for it (`DEDUPE#<DEPLOYMENT_ID>#900000001-1` returns nothing). Executor console: the `message acknowledged` line for that message id (the Executor has no dedicated log line for a rejected deploy request; the evidence is the rejection item and the platform Slack notification `Request rejected: UNAUTHORIZED_SENDER (sender ref ...)`). The `RejectedRequests{reason=UNAUTHORIZED_SENDER}` metric is emitted as EMF to stdout only, so its alarm has **no data** on the workstation ([05](05-run-executor-node22.md), section 8): do not wait for it.

If the item is missing, check that `<DEPLOYMENT_ID>` and `<UNIT>` match your definition; the sender is checked first, so an unknown `<DEPLOYMENT_ID>` sent from the operator role is also rejected as `UNAUTHORIZED_SENDER` — the item key then uses whatever ids you sent (record what you see).

### Poison message (send as the operator role)

```powershell
[System.IO.File]::WriteAllText((Join-Path $PWD "executor/.local/poison.json"), '{"specVersion":1,"eventType":"POISON_TEST_UNKNOWN"}', (New-Object System.Text.UTF8Encoding $false))
aws sqs send-message --queue-url <DEPLOY_QUEUE_URL> --message-body file://executor/.local/poison.json --profile <OPERATOR_PROFILE_NAME> --region <AWS_REGION>
```

Expected: JSON with a `MessageId`. If you send it with your admin profile instead, you get `AccessDenied` (the explicit queue-policy Deny): that is correct and is itself useful evidence.

Executor console: a warning `unroutable message left for the dead-letter queue` with the reason `UNKNOWN_EVENT_TYPE`, repeated each time the message is redelivered (every 120 seconds, the visibility timeout). After the fifth receive SQS moves it to the DLQ (about 10 to 12 minutes). Then:

```powershell
aws sqs get-queue-attributes --queue-url <DLQ_URL> --attribute-names ApproximateNumberOfMessages --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
aws cloudwatch describe-alarms --alarm-names cicd-dev-dlq-not-empty --query "MetricAlarms[0].StateValue" --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: the DLQ count is 1, and the alarm becomes `ALARM` within a few minutes (evaluation is per minute).

Cleanup: inspect and purge the DLQ message so the alarm clears (`aws sqs purge-queue --queue-url <DLQ_URL>`; purge works once per 60 seconds). Never edit a poison message and redrive it.

## B4. SSH (non-destructive)

Run [06](06-target-validation.md). Evidence: preflight fingerprint match and strict login exit 0; `target-probe.sh` `PROBE_OK` with `flock_contention=busy`; `executor-ssh-probe` `probe OK` with the verified checksum and parsed `CICD_RESULT`; the deliberate mismatch rejected with `HOST_KEY_MISMATCH`.

## B5. One controlled deployment (optional; needs OD-Q5)

Do not start until OD-Q5 is decided and [06](06-target-validation.md) section 5 holds.

1. Fill the real deployment definition for one unit of your choice ([04](04-definitions-and-target.md)), restart the Executor.
2. If the target requires a deploy window, open one as the operator. The CLI is a Node program; on Windows run it with the portable Node and the operator profile for this process only:

   ```powershell
   $env:AWS_PROFILE = "<OPERATOR_PROFILE_NAME>"; $env:AWS_REGION = "<AWS_REGION>"; $env:CICD_QUEUE_URL = "<DEPLOY_QUEUE_URL>"
   & executor/.local/node22/node.exe executor/dist/src/operator-cli/main.js open --lock-key "<LOCK_KEY>" --opened-by "<OPERATOR_NAME>" --disabled <EXTERNAL_JOB_ID> --hours 1 --dry-run
   ```

   `--dry-run` prints the event and sends nothing. Remove `--dry-run` to send. The `--disabled` list must cover every external deployer of the target (coverage rule). Close with the `close` command (`--lock-key`, `--closed-by`). Clear the three variables afterwards.
3. Trigger the workflow ([03](03-github.md), section 8).

Expected evidence: execution `SUCCEEDED`; the Slack thread shows the timeline; `TARGET#<LOCK_KEY>` / `STATE` shows `lastDeployed` for the digest you pushed (written under the fencing token). Optional: force a health failure and observe the previous image restored (rollback), recorded in the same item and the Slack thread.

If the execution ends `UNKNOWN_TARGET_STATE`, follow [`../runbook.md`](../runbook.md) section 12.2; do not retry by hand.
