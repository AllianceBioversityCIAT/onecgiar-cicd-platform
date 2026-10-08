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
| Dedupe (gives the execution id) | `DEDUPE#<TARGET_ID>#<REQUEST_ID>` | `DEDUPE` |
| Rejection (every rejected `DEPLOY_REQUESTED`, AC-02 V1) | `REJECT#MSG#<SQS_MESSAGE_ID>` | `META` |
| Deploy window | `WINDOW#<TARGET_ID>` | `WINDOW` |
| Per-target sequence | `DEPLOYMENT#<TARGET_ID>` | `SEQ` |
| Target state (`lastDeployed`, `highestAccepted`, `unresolved[]`) | `TARGET#<TARGET_ID>` | `STATE` |
| Distributed lock | `LOCK#<TARGET_ID>` | `LOCK` |
| Event mark | `EXEC#<EXECUTION_ID>` | `EVT#<EVENT_KEY>` |
| Target record (registry table `<REGISTRY_TABLE_NAME>`, not the executions table) | `TARGET#<TARGET_ID>` | `META` |

`<REQUEST_ID>` is `<RUN_ID>-<RUN_ATTEMPT>` of the GitHub run (the request id equals `ci.runId-ci.runAttempt`).

### Commands (Git Bash syntax)

```bash
aws dynamodb get-item --table-name <EXECUTIONS_TABLE_NAME> --consistent-read --key '{"pk":{"S":"DEDUPE#<TARGET_ID>#<REQUEST_ID>"},"sk":{"S":"DEDUPE"}}'
aws dynamodb get-item --table-name <EXECUTIONS_TABLE_NAME> --consistent-read --key '{"pk":{"S":"EXEC#<EXECUTION_ID>"},"sk":{"S":"META"}}'
aws dynamodb query --table-name <EXECUTIONS_TABLE_NAME> --index-name GSI2 --key-condition-expression "activeStatus = :s" --expression-attribute-values '{":s":{"S":"EXECUTION"}}'
```

The first returns the `executionId`. The third lists non-terminal executions (use `"WINDOW"` for open windows). Executions have no secondary index by target, so to list them (and the rejections) in this small PoC table:

```bash
aws dynamodb scan --table-name <EXECUTIONS_TABLE_NAME> --filter-expression "begins_with(pk, :p) AND sk = :m" --expression-attribute-values '{":p":{"S":"EXEC#"},":m":{"S":"META"}}' --projection-expression "executionId, targetId, #s, #e, requestId, senderRef" --expression-attribute-names '{"#s":"status","#e":"error"}'
aws dynamodb scan --table-name <EXECUTIONS_TABLE_NAME> --filter-expression "begins_with(pk, :p)" --expression-attribute-values '{":p":{"S":"REJECT#MSG#"}}'
```

The last one lists the rejection records (reason, sender reference, and the target and request ids when the body carried them).

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

Expected: an `Item` with `status`, `targetId`, `targetSnapshot`, `requestId`, `senderRef`, `commitSha`, `artifacts`, `order`, `ci` and timestamps (the fields are described in [`../runbook.md`](../runbook.md), "Reconstructing an execution"). An empty response means the key is wrong.

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
| Stack outputs | [01](01-aws-sam.md) | `CREATE_COMPLETE` or `UPDATE_COMPLETE`, 17 outputs (including `RegistryTableName`) |
| Secrets exist | `describe-secret` per ref ([02](02-secrets.md)) | All present |
| Startup | Executor console ([05](05-run-executor-node22.md)) | `executor started` (AC-02 V1: no definitions are loaded, zero targets is valid); no refusal |
| Heartbeat | Console heartbeat lines; the healthcheck file's timestamp | Updated about every minute. The CloudWatch heartbeat metric has **no data** in this run (EMF not shipped); do not treat the alarm state as a failure |
| Scheduler-originated `RECONCILE_TICK` consumed | **Checkpoint.** Only when the Executor is running ([05](05-run-executor-node22.md)) and you decide to enable the schedule. In your local `executor/.local/gate-b/samconfig.toml`, change `ReconcileScheduleState=DISABLED` to `ReconcileScheduleState=ENABLED` in `parameter_overrides` (keep every other value), then run the checkpoint D deploy command of [01](01-aws-sam.md) unchanged. The changeset must show only `Modify` on `ReconcileSchedule`; answer `n` otherwise. Wait at least 5 minutes. To stop ticks, set it back to `DISABLED` in the same file and redeploy the same way | Executor console shows the line `RECONCILE_TICK consumed` (with a generated `correlationId`) about every 5 minutes; `aws scheduler get-schedule --name cicd-reconcile-dev --query State --output text` prints `ENABLED`; the DLQ stays empty. G-8 is resolved: the tick carries no `eventId` |
| Negative: the Executor role cannot read an application secret | with `$env:AWS_CONFIG_FILE` / `$env:AWS_SHARED_CREDENTIALS_FILE` set to the isolated files of [05](05-run-executor-node22.md) section 3: `aws secretsmanager get-secret-value --secret-id <APPLICATION_SECRET_NAME> --profile cicd-executor` and `aws ecr describe-repositories --profile cicd-executor` | `AccessDeniedException` for both |

## B2. GitHub OIDC to SQS to the local Executor

| Evidence | How | Expected |
|---|---|---|
| Session-name probe (P-R1, P-R2, P-G10, P-G11) | [03](03-github.md), section 7 | `session = repository_id: ALLOWED`, both other session names `DENIED`; claims equal the stack parameters |
| Public-safe workflow log | [03](03-github.md), section 8 | No credential-like value; the role ARN and account id are expected (G-10); masking of the registry host and queue URL is hygiene only |
| Stage 1: no record, `TARGET_UNKNOWN` | [03](03-github.md), section 8; the `REJECT#MSG#` scan above | One rejection item with reason `TARGET_UNKNOWN` and `senderRef` = the CI role id (stack output `CiRoleId`, without the session suffix); no `DEDUPE#<TARGET_ID>#<REQUEST_ID>`, `DEPLOYMENT#<TARGET_ID>`, `TARGET#<TARGET_ID>` or `LOCK#<TARGET_ID>` item. Executor console: the message acknowledged |
| Stage 2: record registered, request accepted (P-A4) | `DEDUPE#<TARGET_ID>#<REQUEST_ID>` then `EXEC#<EXECUTION_ID>` | The execution exists with `senderRef` = the CI role id and `targetSnapshot.version` = the record version. Being accepted proves the `SenderId` session suffix equalled the record's `sourceRepositoryId` |
| Window closed outcome | Execution item (record `deployWindowPolicy: required`, no window open) | `status` `FAILED` and `error.code` `DEPLOY_WINDOW_CLOSED`; no `LOCK#<TARGET_ID>` item; no SSH connection was made |
| Negative: another repository as the source | [03](03-github.md), section 10 | `TARGET_NOT_AUTHORIZED`, no target state change; the record restored afterwards |
| Negative: untrusted triggers | [03](03-github.md), section 9 | `pull_request`, `pull_request_target`, `workflow_run` never reach `push-and-send` and never obtain credentials |
| Negative: wrong sender | "Wrong sender" below | A schema-valid `DEPLOY_REQUESTED` sent by the operator role is `REJECTED` with `UNAUTHORIZED_SENDER` |
| Pinned premises | [03](03-github.md), sections 4 and 7 | P-R1, P-R2, P-A4, P-G10, P-G11, P-G14, G-3, P-A3 each recorded as observed, with the real claim strings sanitized |

## B3. State, dedupe, locks

Common setup: the target has `deployWindowPolicy: required` and **no window open**, so each accepted request ends `FAILED (DEPLOY_WINDOW_CLOSED)` quickly, with no SSH. **Stop if** the definition says `not-required` or a window is open: do not trigger any workflow ([04](04-definitions-and-target.md)). Ordering still applies.

| Test | Steps | Expected evidence |
|---|---|---|
| Re-run of the same run | In GitHub, **Re-run all jobs** on a finished run | A GitHub re-run increments the run attempt, so the request id is `<RUN_ID>-<NEXT_ATTEMPT>`: a **new** dedupe key and a new execution with the **same** `runNumber` (equal order is not older). It is not `SUPERSEDED`. A true duplicate (the same request id delivered twice) is logged as `duplicate DEPLOY_REQUESTED ignored` and creates no second execution; you cannot force it from outside (the queue accepts requests only from the CI role). Record what you observe |
| Older build after a newer one | Run the workflow twice (run N, then run N+1) and wait until N+1 is accepted; then **Re-run all jobs** on run N | The re-run of N has a lower order than `highestAccepted` on `TARGET#<LOCK_KEY>`: its execution is `SUPERSEDED`. Read the target state item to see `highestAccepted` |
| Reconciler activity | Requires the schedule enabled as in the checkpoint above | `RECONCILE_TICK consumed` lines appear and the reconciler acts on overdue executions; record what you observe. If you did not enable the schedule, record as not executed |
| Poison message to the DLQ | Below | Message lands in the DLQ after 5 receives; the DLQ alarm fires |

### Wrong sender (negative; send as the operator role)

The operator role may enqueue, but it has no right to request a deploy: a `DEPLOY_REQUESTED` from it must be rejected before any target is read. Create a schema-valid body with obviously fake values (use your real `<TARGET_ID>` and unit name so the rejection is about the sender):

```powershell
[System.IO.File]::WriteAllText((Join-Path $PWD "executor/.local/wrong-sender.json"), '{"specVersion":1,"eventType":"DEPLOY_REQUESTED","requestId":"900000001-1","targetId":"<TARGET_ID>","commitSha":"0000000000000000000000000000000000000000","artifacts":{"<UNIT>":"sha256:0000000000000000000000000000000000000000000000000000000000000000"},"ci":{"repository":"<GITHUB_ORG>/<APP_REPO>","workflowRef":"<WORKFLOW_REF>","runId":"900000001","runAttempt":1,"runNumber":1}}', (New-Object System.Text.UTF8Encoding $false))
aws sqs send-message --queue-url <DEPLOY_QUEUE_URL> --message-body file://executor/.local/wrong-sender.json --profile <OPERATOR_PROFILE_NAME> --region <AWS_REGION> --query MessageId --output text
```

Expected: a `MessageId` `<SQS_MESSAGE_ID>`. Then read the rejection item:

```powershell
Get-CicdItem "REJECT#MSG#<SQS_MESSAGE_ID>" "META"
```

Expected: an `Item` whose reason is `UNAUTHORIZED_SENDER` and whose `senderRef` is the operator role id (stack output `OperatorRoleId`), without a session suffix. No `DEDUPE#<TARGET_ID>#900000001-1` item exists and the target state is unchanged. The platform Slack channel receives `Request rejected: UNAUTHORIZED_SENDER`. The `RejectedRequests{reason=UNAUTHORIZED_SENDER}` metric is emitted as EMF to stdout only, so its alarm has **no data** on the workstation ([05](05-run-executor-node22.md), section 8): do not wait for it.

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

## Account resource-policy check (SR-7)

**Owner-executed, later (after the stack exists; not a B1 precondition).** The stack's queue policy and roles are scoped, but other resource policies already in the account (queues, repositories, secrets, roles) can grant access that this stack does not control. This check is read-only and looks for external or wildcard grants. Use your administrator profile.

1. Is an IAM Access Analyzer already enabled for the account?

   ```powershell
   aws accessanalyzer list-analyzers --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
   ```

2. **Only if** an analyzer of type `ACCOUNT` exists, list its active findings (external access to queues, secrets, roles, repositories):

   ```powershell
   [System.IO.File]::WriteAllText((Join-Path $PWD "executor/.local/aa-filter.json"), '{"status":{"eq":["ACTIVE"]}}', (New-Object System.Text.UTF8Encoding $false))
   aws accessanalyzer list-findings --analyzer-arn <ANALYZER_ARN> --filter file://executor/.local/aa-filter.json --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
   ```

   Expected: no active finding that names the stack's queue, the CI role or the Executor role. Record any finding you do not recognize.

   Creating an analyzer is a **mutation** that you may choose to make (external-access analysis has no charge); it is deliberately not part of B1 and is not instructed here. If none exists, use the spot checks below instead.

3. Read-only spot checks (look for `"Principal":"*"`, `"Principal":{"AWS":"*"}` without a restrictive `Condition`, or the CI role ARN in a resource policy it should not have):

   ```powershell
   aws sqs list-queues --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
   aws sqs get-queue-attributes --queue-url <QUEUE_URL> --attribute-names Policy --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
   aws ecr describe-repositories --query "repositories[].repositoryName" --output text --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
   aws ecr get-repository-policy --repository-name <REPOSITORY_NAME> --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
   ```

   Repeat `get-queue-attributes` for each queue in the list and `get-repository-policy` for each existing repository (`RepositoryPolicyNotFoundException` means the repository has no resource policy, which is fine).

### Documented residual risks (SR-6, SR-7)

- **SR-6:** documented residual risk; it is accepted for the PoC as raised in the Gate B security review and is not remediated here.
- **SR-7:** documented residual risk. A resource policy elsewhere in the account that grants the CI role (or `*`) access outside this stack is not visible to the stack's own tests; the checks above reduce, but do not eliminate, that risk, and they are a point-in-time observation only.

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
