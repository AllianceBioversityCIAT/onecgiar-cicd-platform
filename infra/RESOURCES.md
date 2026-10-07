# Infrastructure Resources — CI/CD Executor PoC (DEV, Model B)

<!-- @akili-spec changes/cicd-executor-poc design DD-17, DD-23, DD-24, DD-25, DD-29, §4.1, §5.1, §11, §12; proposal §14.1; requirements FR-17, FR-18, FR-25, NFR-06, NFR-09 -->

This is the **DEV resource contract** for the PoC (design DD-17): what must exist, with what
configuration and permissions, and why. **OD-Q7 is resolved (owner decision D-1, 2026-10-06):
the PoC infrastructure is AWS SAM / CloudFormation**, defined in `infra/sam/template.yaml`
(stack for Gate B DEV; names derive from the `Stage` parameter, default `dev`, e.g.
`cicd-events-${Stage}`, `cicd-executions-${Stage}`). This file stays the contract the template is
reconciled against; the owner-run deployment steps are in `docs/gate-b/`.

Not in the SAM template (created by hand or by a later gate): the Executor ECR repository (#5), the
GitHub-side configuration (#8), every Secrets Manager secret value (#13, #14; the owner creates them
with documented commands), the Logs Insights saved query (#18), the target profile and host (#19, #20).
Differences to note: the ECR repository for CI pushes is an owner-chosen parameter (or an optional
probe repository), and the reconcile schedule (#10) is created **DISABLED** until spec gap G-8 is
decided (the Scheduler event id is not a UUID).

**Model B (AC-01):** CI runs in GitHub Actions and builds and pushes images itself; the
Executor only coordinates the deploy. The following Model A resources no longer exist and must
not be created: the S3 artifacts bucket, the CodeBuild project, its role and buildspec, the
quality-worker Lambda alias with async invocation and Destinations, the EventBridge CodeBuild
state rule, the GitHub webhook ingress Lambda with its Function URL and role, the `/work`
volume, the Executor's GitHub credential, and the Executor's S3, Lambda and CodeBuild
permissions (design §10.3, §11.2; proposal §14.1 "Removed vs v2").

**Publication policy (design §4.1, DD-23):** no account ID, host, IP, credential ID, secret
name, ARN or Jenkins job name appears here. Logical references (`<AWS_ACCOUNT_ID>`,
`<AWS_REGION>`, `<PRMS_REPORTING_DEV_TARGET>`, …) stand in for them; real values live in
Secrets Manager, IAM, GitHub Environment secrets and deployment configuration, never in Git.
Semantic names already used throughout the approved, sanitized spec (e.g. `cicd-executions-dev`)
are not secrets and are kept as-is, per DD-23.

**AC-02 V1 (owner decisions 2026-10-07, design v5.0):** no Deployment Definitions; the Target Registry becomes a runtime DynamoDB table `cicd-registry-<stage>` (one item per `targetId`: host, port, user, host key, script path on the target, window policy, `credentialRef` to Secrets Manager; on-demand, no TTL, PITR, `Retain`, tagged `Project=ONECGIAR-CICD-Platform`). The Executor role gets `dynamodb:GetItem` on it **only**; writes come from the administrative onboarding principal; the CI role has no access. Not yet in `infra/sam/template.yaml` (task R-2).

## Quick path

1. Read the **Resources** table for what to provision and in which gate.
2. Read **OIDC trust shape** and **IAM by component** for exactly which permissions each
   principal needs — no more.
3. Before declaring a gate's infrastructure done, run the **Verification checklist** at the end.

## Resources

| # | Logical name | Type | Key configuration | Requirement / design | Gate | Open decision |
|---|---|---|---|---|---|---|
| 1 | `cicd-events-dev` | SQS Standard queue | Visibility 120 s base, extended every 60 s while a handler is alive (DD-14); max per-message delay 900 s (P-22); redrive to #2 after `maxReceiveCount`; **queue policy #3 attached** | design §6.4, §7.6, DD-25; proposal §14.1 | B | — |
| 2 | `cicd-events-dev-dlq` | SQS DLQ | Receives messages that exhausted `maxReceiveCount` on #1. Alarm: depth > 0 (#17) | design §12; FR-17 | B | — |
| 3 | Queue policy on #1 | SQS resource policy | `SendMessage` is allowed **only** to: the CI role(s) #9, the Executor role #15 (lock retries), the Scheduler target role #11, and the operator principal #12. Every other principal is denied. `ReceiveMessage`/`DeleteMessage` stay with the Executor role only. Defense in depth behind the consumer's per-type sender binding (DD-25 "Defense in depth"). **Per-type sender rule** the consumer enforces on top of it: `DEPLOY_REQUESTED` ← the definition's `allowedSender` only; `LOCK_RETRY_REQUESTED` ← Executor; `RECONCILE_TICK` ← Scheduler; `DEPLOY_WINDOW_*` and `TARGET_RESOLUTION_RECORDED` ← operator. Mismatch → `REJECTED (UNAUTHORIZED_SENDER)` | design DD-25, §11.1, §6.4; FR-21; proposal §14.1 | B | — |
| 4 | `cicd-executions-dev` | DynamoDB table, on-demand | Single table, PK/SK, TTL attribute `expiresAt`. Item types and TTLs (design §5.1): `Execution` 180 d; `Rejection` (`REJECT#…`) 30 d; `Dedupe` 7 d; `Event mark` 7 d; `Lock` (`expiresAt`); `Sequence`; `Target state` (`TARGET#{lockKey}`: `highestDispatched`, `highestAccepted`, `unresolved[]`); `Deploy window` (+ `LOG#` items). **Only index: GSI2** (sparse, `activeStatus` ∈ `EXECUTION`/`WINDOW` + `deadlineAt`; reconciler `Query`, no scans). **No GSI1; no Step or Instance-lease items** | design §5.1; FR-03, FR-05, FR-15, FR-17, FR-18 | B | — |
| 5 | `cicd-executor` | ECR repository | The Executor's own image (DD-19: `definitionRef` baked in at build time). Not pulled by application code | design §4.2, DD-19 | B | — |
| 6 | `<ECR_REPOSITORY>` (server, client) | ECR repository (existing, reused) | Application images, **pushed by the CI role #9** and pulled by the target's instance profile (#19). Deploys use digests only (DD-26); tag immutability is OD-A7; CI must not push tags that collide with Jenkins's integer tags (FR-22, P-16) | proposal §14.1; DD-26 | B/C (reused, not created) | OD-A7 |
| 7 | GitHub IAM OIDC provider | IAM OIDC identity provider | Issuer `<GITHUB_OIDC_ISSUER>`, audience `<STS_AUDIENCE>`. One provider per account; referenced as `<GITHUB_OIDC_PROVIDER>` in #9's trust | design DD-24; proposal §14.1; FR-25 | B | — |
| 8 | GitHub-side configuration for `<PRMS_REPORTING_REPO>` | GitHub Environment `<GITHUB_ENVIRONMENT>` + variables (no secret) | Environment deployment branch rules = the bound branch (plan-dependent, P-G7/OD-A9); production environments (later waves) add required reviewers. **Value classification (design DD-24, v4.7):** **no GitHub secret**. The CI role ARN, region, ECR repository name and queue name are **Environment variables**; registry host and queue URL are **derived after OIDC**. The role ARN and account ID may appear in public logs (owner-accepted; not credentials). No static AWS keys; OIDC only. **Environment variable `CICD_BOUND_REF`**: admin-only (P-G13), visible only to the Environment-bound job (P-G14); never a workflow input, never read from the request body, the caller's files or a repository-level variable; missing or empty fails closed. **Event allowlist** enforced inside the pinned reusable workflow (not an IAM key, P-G6): `push` or `workflow_dispatch` only, both only on the bound ref; `pull_request`, `pull_request_target` and `workflow_run` are rejected by the `guard` job. Callers reference the platform reusable workflow at `<PINNED_COMMIT_SHA>` (DD-29); every action inside it is pinned by a full 40-hex commit SHA (guard 7); `docker://` references by image digest, `./` exempt | design DD-24, DD-29, §11.1; FR-25 | A (static) / C (first run) | OD-A6, OD-A9 |
| 9 | CI role shared by the authorized repositories (AC-02 V1; PoC: one repository; a second one is gated on open point V1-R1) | IAM role | **Trust: exactly the shape in "OIDC trust shape" below.** `MaxSessionDuration` 1 h. Permissions: `ecr:GetAuthorizationToken`; layer upload and `PutImage` on the application `<ECR_REPOSITORY>` repositories only (with several repositories this scope is shared, part of open point V1-R1); `sqs:SendMessage` and `sqs:GetQueueUrl` on #1 only. Nothing else | design DD-24, §11.1; FR-25; NFR-09; proposal §14.1 | B | — |
| 10 | `cicd-reconcile-dev` | EventBridge Scheduler schedule | Sends `RECONCILE_TICK` to #1 every 5 min (DD-13). Any Executor instance may handle it. Target role: #11 | design DD-13; FR-15 | B | — |
| 11 | `<SCHEDULER_TARGET_ROLE>` (`schedulerPrincipalRef`) | IAM role (EventBridge Scheduler target) | Trust: the Scheduler service principal, scoped to #10 only. Permissions: `sqs:SendMessage` on #1 only. Its role ID is the identity the consumer accepts for `RECONCILE_TICK` (DD-25) | design DD-13, DD-25, §11.1 | B | — |
| 12 | `<OPERATOR_PRINCIPAL>` (`operatorPrincipalRef`) | IAM role or user for the operator CLI | `sqs:SendMessage` on #1 only, used for `DEPLOY_WINDOW_*` and `TARGET_RESOLUTION_RECORDED` (runbook §12.2). Any other sender of those types is `REJECTED`. It confers **no** deploy right: `DEPLOY_REQUESTED` from it is `UNAUTHORIZED_SENDER` (an operator redeploy path is OD-A8, open) | design DD-25, §6.4, §12.2; FR-24 | B | OD-A8 |
| 13 | `<SSH_CREDENTIAL_REF>` (+ `<SSH_HOST_KEY_REF>` — *superseded by AC-02 v4.9 (task R-9)*: the host key becomes an inline target-record field; AC-02 V1) | Secrets Manager secret | SSH credential for `<PRMS_REPORTING_DEV_TARGET>`, read only by the SSH handler at point of use, kept in memory only, never logged. Host key inline in the target record (AC-02 V1) | design DD-23, §7.5; NFR-02 | B/C | OD-Q5 |
| 14 | `<SLACK_TOKEN_REF>` and identifier references (identifier references: open point AC2-7) | Secrets Manager secrets | Slack Web API token for `NotificationService` (DD-12). Plus **non-sensitive identifier references** (DD-23, DD-25) resolved at startup to role IDs: `ciPrincipalRef` (AC-02 V1: one CI role shared by the authorized repositories; replaces the per-definition `allowedSenderRef`), `executorPrincipalRef`, `schedulerPrincipalRef`, `operatorPrincipalRef`. No role ID or ARN is committed. A recreated role gets a new role ID → requests are rejected and alarmed until the reference is updated (fail-closed) | design DD-12, DD-23, DD-25 | B | — |
| 15 | `cicd-executor-dev` | IAM role (Executor) | See **IAM by component**. Reduced: SQS on #1, DynamoDB #4 and GSI2, Secrets Manager (#13, #14) and CloudWatch only; **AC-02 adds `dynamodb:GetItem` only on `cicd-registry-<stage>` (task R-2)** | design §11.2, DD-16; NFR-01, NFR-02 | B | OD-Q12 |
| 16 | CloudWatch Log groups | Log groups (Executor) | 30-day retention. Entries carry `executionId`, `requestId`, `targetId` (AC-02 V1) | design §12; FR-17 | B | — |
| 17 | CloudWatch alarms | Alarms | See **Alarms** below | design §12; FR-17 | B | — |
| 18 | CloudWatch Logs Insights saved query | Saved query ("execution timeline") | The operator's read surface alongside DynamoDB (design §8: no UI) | design §8, §12 | B | — |
| 19 | `<PRMS_REPORTING_DEV_TARGET>` instance profile / deploy user | Existing host, new IAM role/profile + OS-level deploy user | ECR pull on #6 only; read of the DEV runtime secret only. Authorized key (or temporary password) for the deploy user, SSH only. Existing Jenkins-used static keys are **not deleted** (NFR-10) | design §6.5, §7.5, DD-11, DD-22; FR-13 | C | OD-Q5 |
| 20 | Microservices server host | Existing host (not provisioned by this spec) | Runs the `cicd-executor` container; unique stable `instanceId`; CPU/memory limits; Docker; egress 443 (AWS, Slack) and 22 (`<PRMS_REPORTING_DEV_TARGET>`); **no GitHub egress** (DD-27); no Docker socket mounted (NFR-01); no Swarm (DD-18); **no `/work` volume**. Healthcheck `start-period` must be ≥ the first heartbeat tick (60 s) plus the healthcheck-file write | design DD-18, §12 "Liveness"; NFR-04 | B | OD-Q11, OD-Q12 |

### Runtime state (not independently provisioned)

| Item | Where | Note |
|---|---|---|
| Delivered deploy script, `runtime-<container>.env` | `/tmp/cicd-{executionId}/` on the target, deleted at the end | Created per execution by the SSH handler (design §5.2) |
| Local mutex lock file | Per-`lockKey` file in a deploy-user directory on the target | Kernel `flock`; the file's existence is diagnostic only, never the lock itself (design §5.2, §12.1) |

## OIDC trust shape

Trust policy of every CI role (#9), per design DD-24 and FR-25. **Every condition is an exact
`StringEquals`. `StringLike`, wildcards and custom subject templates are never used.**

```text
Principal: Federated = <GITHUB_OIDC_PROVIDER>
Action:    sts:AssumeRoleWithWebIdentity
Condition: StringEquals <GITHUB_OIDC_ISSUER>:aud                 = <STS_AUDIENCE>
           StringEquals <GITHUB_OIDC_ISSUER>:repository_id       = <PRMS_REPORTING_REPO_ID>
           StringEquals <GITHUB_OIDC_ISSUER>:repository_owner_id = <GITHUB_ORG_ID>
           StringEquals <GITHUB_OIDC_ISSUER>:environment         = <GITHUB_ENVIRONMENT>
           StringEquals <GITHUB_OIDC_ISSUER>:job_workflow_ref    = <GITHUB_ORG>/<PLATFORM_REPO>/.github/workflows/deploy-request.reusable.yml@<PINNED_COMMIT_SHA>
           StringEquals <GITHUB_OIDC_ISSUER>:sub                 = <ENVIRONMENT_FORM_SUB>
           StringEquals <GITHUB_OIDC_ISSUER>:ref                 = <BOUND_REF>   (SR-4; equals CICD_BOUND_REF)
MaxSessionDuration: 1 h
```

Rules:

- `repository_id` and `repository_owner_id` are immutable IDs (robust to rename and transfer,
  P-G10); they are logical placeholders here and resolved outside Git (DD-23).
- `job_workflow_ref` admits only jobs inside the platform reusable workflow at the pinned
  **commit SHA** (never a tag or branch). Moving the pin requires changing this trust policy in
  the same change. The exact claim value for a SHA-pinned call is P-G11 (`UNVERIFIED`, observed
  in N-24/N-32).
- `sub` is a **redundant** check with the default environment-form value; which string format
  applies (P-G10) is observed at N-24. The binding does not depend on it.
- `event_name` is not an IAM condition key (P-G6); the event and bound-ref allowlist lives in
  the pinned reusable workflow (DD-24 item 2), with the bound ref taken from the admin-only
  Environment variable `CICD_BOUND_REF` (#8).
- `ref` (SR-4): since 2026-10-07 the bound ref is ALSO an exact IAM condition (stack parameter
  `GitHubBoundRef`, never caller-controlled); it must equal `CICD_BOUND_REF`. The event allowlist stays
  in the pinned workflow, because the `ref` of `pull_request_target`/`workflow_run` is the default branch.
- Not relied upon: environment-only `sub`, branch-based `sub`, P-A3 for fork safety.

## Alarms (#17)

| Alarm | Signal | Threshold | Source |
|---|---|---|---|
| DLQ not empty | `ApproximateNumberOfMessagesVisible` on #2 | **> 0** | design §12; FR-17 |
| Oldest message age | `ApproximateAgeOfOldestMessage` on #1 | **> 10 min** | design §12; FR-17 |
| Executor inactive | `ExecutorHeartbeat` EMF metric absent | within **5 min**. **Configure dimensionless**: the Executor emits it with no dimensions (`Dimensions: [[]]`), so an alarm that expects a dimension never sees data | design §12 "Liveness"; FR-17 |
| Rejected sender | `RejectedRequests` with reason `UNAUTHORIZED_SENDER` | **> 0** | design §12, DD-25; FR-17 |
| Executions past deadline | `ExecutionsPastDeadline` | **> 0** | FR-17. **Forward note, not yet existing:** design §12 does not name this metric. Once the reconciler emits `ExecutionsPastDeadline` (count of overdue GSI2 `activeStatus = EXECUTION` items returned with `deadlineAt < now` on a reconcile tick, raw rows before the per-item re-read; expired `WINDOW` items are closed by the reconciler and are NOT counted; the metric is emitted on every tick, 0 included), wire this alarm; this row is a placeholder for that wiring, not a present alarm |
| `UNKNOWN_TARGET_STATE` unresolved | Count of `unresolved[]` entries on `TARGET#{lockKey}` (design §5.1) | **> 0** until cleared by runbook §12.2 | **Forward note, not yet existing:** design §12 names no metric for this. Until the Executor emits one, the signal is the Slack thread reply with the runbook link (design §6.6) plus the `unresolved[]` entry in DynamoDB; wire the alarm once a metric exists |

## IAM by component

Least privilege, scoped to this PoC's own resources only. One AWS account holds every
environment (P-7, **UNVERIFIED**); separation between DEV and any other environment is by
**IAM policy, not account boundary**, until P-7 is settled (NFR-09's "IAM review").

| Component | Principal (resource #) | Permissions (least privilege) | Explicitly excluded |
|---|---|---|---|
| **Executor** | `cicd-executor-dev` (#15) | SQS on #1 only: `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` (visibility extension, DD-14) and `SendMessage` (its own internal events: lock retries). DynamoDB on #4: item operations (`GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, and the transactional writes built from them) and `Query` on GSI2 only, conditional writes. Secrets Manager: `DescribeSecret` for existence checks on the SSH credential, Slack token and identifier references; `GetSecretValue` **at point of use** for the SSH credential (#13, SSH handler), the Slack token (#14, `NotificationService`) and the non-sensitive identifier references (#14) — **never** application secrets (`envSecretRef`, DD-23). CloudWatch: `PutMetricData` and log write on #16 | S3, Lambda, CodeBuild, ECR, IAM, GitHub (design §11.2); `docker build`, any application database connection, any Jenkins API or credential (NFR-01) |
| **CI role** | `<PRMS_REPORTING_CI_ROLE>` (#9) | `ecr:GetAuthorizationToken` (resource `*`: **accepted least-privilege exception**, AWS does not scope this action by resource; it returns only a short-lived token). Layer upload (`BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`) and `PutImage` on **its** `<ECR_REPOSITORY>` repositories only. `sqs:SendMessage` and `sqs:GetQueueUrl` on #1 only. Trust per **OIDC trust shape**; session ≤ 1 h | Every other repository, queue, secret or service; static keys; any permission on #4 or the Executor's resources |
| **Scheduler target role** | `<SCHEDULER_TARGET_ROLE>` (#11) | `sqs:SendMessage` on #1 only | Everything else |
| **Operator principal** | `<OPERATOR_PRINCIPAL>` (#12) | `sqs:SendMessage` on #1 only (window events, `TARGET_RESOLUTION_RECORDED`) | Deploy requests; resetting order or editing `TARGET` state (OD-A8) |
| **Target instance profile** (host-side, not the Executor) | #19 | ECR pull on #6 only, plus `ecr:GetAuthorizationToken` on resource `*` (same accepted exception). Secrets Manager: `GetSecretValue` on the DEV runtime secret (`envSecretRef`) only, resolved by the **target's own role**, never by the Executor (DD-23) | Any other environment's ECR repository or secret; `aws configure set` (NFR-10) |

## Verification checklist

**Derived from design §11 (and the DD-24/DD-25/DD-29 text it cites)**: every control in §11.1,
every permission token in §11.2, every trust-policy key in the DD-24 block and every alarm in
§12 must be present in this file. The checklist is generated by reading `design.md` — nothing
is hand-listed — and run by a script (kept outside Git as it belongs to no owned module of
this task; re-create from the table below when needed). Result of the last run is in
`docs/specs/changes/cicd-executor-poc/execution.md` by the Leader.

| Design source | Item that must appear in this file | Where |
|---|---|---|
| §11.1 / DD-24 trust policy | `aud`, `repository_id`, `repository_owner_id`, `environment`, `job_workflow_ref`, `sub`; exact `StringEquals`; no `StringLike`/wildcard in the trust shape | OIDC trust shape; #9 |
| §11.1 / DD-24, DD-29 | Event allowlist and bound ref `CICD_BOUND_REF`; No GitHub secret; role ARN and four other values as Environment variables; registry and queue URL derived after OIDC (DD-24 v4.7) | #8 |
| §11.1 / DD-24 | CI role permissions: ECR push to its repos + `SendMessage` + `GetQueueUrl` | #9; IAM by component |
| §11.1 / DD-25 | Queue policy: only CI roles, Executor, Scheduler, operator | #3 |
| §11.1 / DD-25 | Sender binding per message type, fail-closed | #3, #14 |
| §11.1 / DD-26 | Digest only; repository from config | #6 |
| §11.1 / DD-29 | Actions pinned by full commit SHA; guard 7 | #8 |
| §11.1 / DD-20 | Dedupe item and its TTL | #4 |
| §11.1 / DD-21, DD-24 | Production approval before the request; windows after | #8; runbook |
| §11.1 / DD-23 | No GitHub secret; role ARN and the other values as Environment variables; registry and queue URL derived after OIDC; no static keys (DD-24 v4.7) | #8 |
| §11.2 | `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `SendMessage` | #15; IAM by component |
| §11.2 | DynamoDB item operations + `Query` on GSI2 | #4; IAM by component |
| §11.2 | `GetSecretValue` on SSH credential, Slack token, identifier references; `DescribeSecret` | #13, #14; IAM by component |
| §11.2 | CloudWatch logs/metrics | #16; IAM by component |
| §11.2 | **No** S3, Lambda, CodeBuild, ECR, IAM, GitHub | IAM by component "Explicitly excluded" |
| §5.1 | Item types and TTLs (180 d, 30 d, 7 d, 7 d); GSI2 only | #4 |
| §12 | DLQ > 0, oldest message > 10 min, no heartbeat 5 min, `RejectedRequests{reason=UNAUTHORIZED_SENDER}` > 0 | Alarms |
| FR-17 | `ExecutionsPastDeadline` alarm with forward note; `UNKNOWN_TARGET_STATE` unresolved | Alarms |
| §12 / proposal §14.1 | EventBridge Scheduler `cicd-reconcile-dev`, target role | #10, #11 |
| proposal §14.1 | OIDC provider, CI role, secrets, log groups, host, target profile | #7, #9, #13, #14, #16, #20, #19 |
| Model B removals | S3 bucket, CodeBuild, Lambda Destinations, CodeBuild rule, ingress Lambda + URL, `/work`, GitHub credential, S3/Lambda/CodeBuild permissions | Header paragraph; #15, #20 |

**First-pass and falsifier results** are recorded in the report of task N-20 (red run, then
mutation: a `StringLike` or wildcard `sub`/`job_workflow_ref` in the trust shape fails the
checklist).
