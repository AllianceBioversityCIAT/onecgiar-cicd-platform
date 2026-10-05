# Infrastructure Resources — CI/CD Executor PoC (DEV)

<!-- @akili-spec changes/cicd-executor-poc design DD-17, §4.1, §5.2, §6.2, §6.3, §6.6, §10, §12, DD-12, DD-23; proposal §10.7, §14.1; requirements FR-17, FR-18, FR-19, NFR-06, NFR-09 -->

This is the **DEV resource contract** for the PoC (design DD-17): what must exist, with what
configuration and permissions, and why. It is **tool-agnostic on purpose** — the IaC tool
(CDK, Terraform, or something else) is **OD-Q7, an open decision**. Nothing here chooses it.
Until OD-Q7 is resolved, this file **is** the infrastructure: every resource below is created
by hand or by a one-off script, and this table is the source of truth to reconcile against.

**Publication policy (design §4.1, DD-23):** no account ID, host, IP, credential ID, secret
name, or Jenkins job name appears here. Logical references (`<AWS_ACCOUNT_ID>`,
`<AWS_REGION>`, `<PRMS_REPORTING_DEV_TARGET>`, …) stand in for them; real values live in
Secrets Manager, IAM, and deployment configuration, never in Git. Resource *names* that are
semantic/logical identifiers already used throughout the approved, sanitized spec (e.g.
`cicd-executions-dev`, `prms-reporting-dev`) are not secrets and are kept as-is, per DD-23.

## Quick path

1. Read the **Resources** table below for what to provision and in which gate.
2. Read **IAM by component** for exactly which permissions each principal needs — no more.
3. Before declaring a gate's infrastructure done, run the **Verification checklist** at the
   end of this file.

## Resources

| # | Logical name | Type | Key configuration | Requirement / design | Gate | Open decision |
|---|---|---|---|---|---|---|
| 1 | `cicd-events-dev` | SQS Standard queue | Visibility 120 s base, extended every 60 s while a handler is alive (DD-14); max per-message delay 900 s (P-22); redrive to #2 after the DLQ's `maxReceiveCount` | design §6.1, §7.6; proposal §14.1 | B | — |
| 2 | `cicd-events-dev-dlq` | SQS DLQ | Receives messages that exhausted `maxReceiveCount` on #1. Alarm: depth > 0 (§12) | design §12; FR-17 | B | — |
| 3 | `cicd-executions-dev` | DynamoDB table, on-demand | PK/SK single-table design: `Execution`, `Step`, `Dedupe`, `Deploy window`, `Executor instance`, `Sequence`, `Target`, `Lock`, `Event mark` items (design §5.1); TTL on `expiresAt`; **GSI1** (`pipelineId` + `startedAt`, per-pipeline history, FR-17); **GSI2** sparse (`activeStatus` ∈ `EXECUTION`/`STEP`/`WINDOW` + `deadlineAt`, reconciler query-only, no scans) | design §5.1; FR-03, FR-05, FR-15, FR-17, FR-18 | B | — |
| 4 | `cicd-artifacts-dev` | S3 bucket | Prefixes: `executions/{id}/source/{package}.zip` (no secrets), `executions/{id}/quality/` (worker logs/reports). **Lifecycle:** source has explicit deletion-on-finish **and**, independently, a **7-day expiration counted from object creation** as a safety net — not "7 days after deletion": for FR-19's "abandoned execution" scenario the execution never finishes, so there is no deletion event to count from, only the object's own creation time; `quality/` expires **30 days**; incomplete multipart uploads abort after **1 day**. **SSE enabled** (SSE-S3 or SSE-KMS), **Block Public Access** on, and a **bucket policy restricted to this PoC's own roles** (the Executor role #15 and the quality worker's execution role, #17) — proposal §10.7 | design §5.2; proposal §10.7; FR-19 | B | — |
| 5 | `cicd-executor` | ECR repository | Holds the Executor's own image (DD-19's `definitionRef` is baked in at build time). Not pulled by application code | design §4.2, DD-19 | B | — |
| 6 | `<ECR_REPOSITORY>` (server, client) | ECR repository (existing, reused) | Server and client application images, pushed by CodeBuild (#7), pulled by the target's instance profile (#23). Tag format depends on P-8b (non-numeric tags accepted) | proposal §14.1; P-8, P-8b, P-16 | B/C (reused, not created) | — |
| 7 | `prms-reporting-dev` | CodeBuild project (new, privileged) | One project builds both `<SERVER_CONTAINER>` and `<CLIENT_CONTAINER>` as two parallel builds, `COMPONENT` env override (DD-08). S3 source = execution ZIP; env `EXECUTION_ID, STEP_ID, IMAGE_TAG, COMPONENT`; `idempotencyToken = dispatchToken`. Buildspec versioned in `buildspecs/`, associated in infra (not shipped in the ZIP). Build secrets: Secrets-Manager-type project variables, read-only, DEV only | design §6.3, DD-08; FR-10 | B | — |
| 8 | `<QUALITY_WORKER_FUNCTION>` `cicd` alias | Lambda alias (existing function, new alias) | Dedicated alias with its own async invocation config: `MaximumRetryAttempts=0`, `onSuccess`/`onFailure` Destinations → #1. The **unqualified** function and its existing (Jenkins-used) invocations are never touched (DD-07) | design §6.2, DD-07; P-1, P-2, P-15, P-17 | B | OD-Q13 (secrets in the quality ZIP) |
| 9 | `cicd-codebuild-state-dev` | EventBridge rule | Source `aws.codebuild`, `detail-type = CodeBuild Build State Change`, scoped to #7's project ARN only → target #1. **Filter MUST match only terminal `build-status` values** (`SUCCEEDED`, `FAILED`, `STOPPED`, `TIMED_OUT`); CodeBuild also emits non-terminal states (`IN_PROGRESS`) on the same `detail-type`, and those are not valid envelope inputs for the normalization step (design §6.1) — an unfiltered rule turns every build's in-progress events into orphan/poison traffic for the queue | design §6.3, §6.1; FR-04 | B | — |
| 10 | `cicd-reconcile-dev` | EventBridge Scheduler | Publishes `RECONCILE_TICK` to #1 every 5 min (DD-13). Any Executor instance may handle it | design DD-13; FR-15 | B | — |
| 11 | `<SSH_CREDENTIAL_REF>` (+ host key) | Secrets Manager secret | SSH credential for `<PRMS_REPORTING_DEV_TARGET>`, read only by the SSH handler at point of use, kept in memory only, never logged. Host key pinned separately (`hostKeyRef`) | design DD-23, §7.5; NFR-02 | B/C | OD-Q5 (target credential mechanism) |
| 12 | `<GITHUB_CREDENTIAL_REF>` | Secrets Manager secret | Credential for `GitClient` commit resolution / clone, if the repository requires one (P-10) | design §7, DD-23 | B | OD-Q15 (sizing; conditional on P-10) |
| 13 | `<SLACK_TOKEN_REF>` | Secrets Manager secret | Slack Web API token for `NotificationService` (DD-12) | design DD-12, DD-23 | B | — |
| 14 | `<WEBHOOK_SECRET_REF>` | Secrets Manager secret | HMAC-SHA256 secret for the GitHub webhook signature (§6.6, FR-20). **A missing or unresolvable secret here must fail closed** (see `docs/runbook.md`'s ingress note; T-30) | design §6.6; FR-20 | C (Inc 8) | — |
| 15 | `cicd-executor-dev` | IAM role (Executor) | See **IAM by component** below | design DD-16, §7; NFR-01, NFR-02 | B | OD-Q12 (credential delivery mechanism) |
| 16 | `prms-reporting-dev` service role | IAM role (CodeBuild) | See **IAM by component** below | design DD-08 | B | — |
| 17 | Lambda alias Destinations permission + S3 read/write | IAM policy statements (added to the existing function's execution role) | See **IAM by component** below — Destinations `sqs:SendMessage` plus S3 read on `source/` and write on `quality/` (design §6.2's `sourceRef`/`logS3Uri`) | design DD-07, §6.2; proposal §10.7 | B | — |
| 18 | `cicd-github-ingress-dev` role | IAM role (ingress) | See **IAM by component** below | design §6.6; FR-20 | C (Inc 8) | — |
| 19 | CloudWatch Log groups | Log groups (Executor, CodeBuild, Lambda, ingress) | 30-day retention | design §12 | B | — |
| 20 | CloudWatch alarms | Alarms | `ApproximateNumberOfMessagesVisible` on #2 (DLQ) **> 0**; `ApproximateAgeOfOldestMessage` on #1 **> 10 min**; absence of the `ExecutorHeartbeat` EMF metric within **5 min**. **The `ExecutorHeartbeat` alarm must be configured dimensionless**: the Executor emits it with no dimensions (EMF `Dimensions: [[]]`, `executor/src/observability/metrics/index.ts`), so an alarm that expects a dimension (e.g. per-`instanceId`) will never see data and will either never fire or always fire — match the metric's own shape. **Forward pointer, not yet existing:** FR-17 also requires an alarm for "executions alive past their deadline"; design §12 does not name this metric. Once the reconciler (T-11) emits an EMF metric named `ExecutionsPastDeadline` (count of GSI2 `activeStatus = EXECUTION`/`STEP` items found with `deadlineAt < now` on a reconcile pass), add an alarm on that metric **> 0** here — this row is a placeholder for that future wiring, not a present alarm | design §12; FR-17 | B | — |
| 21 | CloudWatch Logs Insights saved query | Saved query ("execution timeline") | Operator's read surface alongside DynamoDB (design §8: "there is no UI") | design §8, §12 | B | — |
| 22 | Microservices server host | Existing host (not provisioned by this spec) | Runs the `cicd-executor` container; `/work/{instanceId}/` volume (local to the container recommended; shared is safe by construction too, §7.4); unique stable `instanceId` per container; CPU/memory limits; Docker, egress 443 (AWS, GitHub, Slack) and 22 (`<PRMS_REPORTING_DEV_TARGET>`); no Docker socket mounted (NFR-01); no Swarm (DD-18). **Container healthcheck**: if a Docker `HEALTHCHECK` is configured, its `start-period` MUST be ≥ the time to the first heartbeat tick (60 s, `DEFAULT_INTERVAL_MS` in `executor/src/observability/heartbeat/index.ts`) plus the healthcheck-file write — a shorter `start-period` marks the container unhealthy before it ever had a chance to write the file | design DD-18, §7.4, §12 "Liveness"; NFR-04 | B | OD-Q11 (the host itself), OD-Q12 (credentials) |
| 23 | `<PRMS_REPORTING_DEV_TARGET>` instance profile / deploy user | Existing host, new IAM role/profile + OS-level deploy user | ECR pull on #6 only; read of the DEV runtime secret only. Authorized key (or temporary password) for the deploy user, SSH only. Existing Jenkins-used static keys are **not deleted** (NFR-10) — the script just stops depending on them | design §6.4, §7.5, DD-11, DD-22; FR-13 | C | OD-Q5 |
| 24 | `cicd-github-ingress-dev` + Function URL | Lambda function + Function URL (Inc 8) | The platform's only exposed component (the Executor exposes no ports). Verifies `X-Hub-Signature-256` against `<WEBHOOK_SECRET_REF>` (#14); missing/invalid signature → 401, nothing queued; a missing/unresolvable secret fails closed with 5xx (T-30, see `docs/runbook.md`). Maps repository + `ref` to definitions via the bundled `DefinitionSource` (DD-19); on a match, enqueues one `PIPELINE_REQUESTED` per matching definition to #1 with `requestId = X-GitHub-Delivery + ":" + pipelineId`. Runs under role #18 | design §6.6; proposal §14.1 "Lambda (Inc 8)"; FR-20 | C (Inc 8) | — |

### Runtime state (not independently provisioned)

| Item | Where | Note |
|---|---|---|
| Delivered deploy script, `runtime.env` | `/tmp/cicd-{executionId}/` on the target, deleted at the end | Created per-execution by the SSH handler, not pre-provisioned infra (design §5.3) |
| Local mutex lock file | `/var/lock/cicd/{lockKey}.lock` on the target, owned by the deploy user | Kernel file lock; the file's existence is diagnostic only, never the lock itself (design §5.3, §12.1) |

## IAM by component

Least privilege, scoped to this PoC's own resources only. One AWS account holds every
environment (P-7, **UNVERIFIED** — see Premise Ledger); separation between DEV and any other
environment in this account is by **IAM policy, not account boundary**, until P-7 is settled
or contradicted (NFR-09's "IAM review" verification method).

| Component | Principal (resource #) | Permissions (least privilege) | Explicitly excluded |
|---|---|---|---|
| **Executor** | `cicd-executor-dev` (#15) | DynamoDB: `GetItem/PutItem/UpdateItem/Query` on #3 and its indexes only, conditional writes. SQS: `ReceiveMessage/DeleteMessage/ChangeMessageVisibility/GetQueueAttributes/SendMessage` on #1 only (`ChangeMessageVisibility` extends visibility per DD-14's heartbeat while a handler is alive; `GetQueueAttributes` for queue-depth/age checks). S3: `PutObject/GetObject/DeleteObject` scoped to `executions/*` on #4 only. Lambda: `InvokeFunction` on #8's `cicd` alias ARN only (never the unqualified function). CodeBuild: `StartBuild/BatchGetBuilds` on #7's project ARN only. Secrets Manager: `DescribeSecret` (existence-check only, DD-23 amendment) on **#11–#13's** reference names only (not #14, the webhook secret, which only the ingress role (#18) reads); `GetSecretValue` **at point of use** for the SSH credential (#11, SSH handler, DD-23 amendment: startup only checks existence, the value is read when the handler actually connects), the GitHub credential (#12, `GitClient` commit resolution/clone, proposal §10.7), the Slack token (#13, `NotificationService`, DD-12), and non-sensitive identifier references (e.g. a resolved `connectionRef`) — **never** for `envSecretRef` (application secrets, DD-23). CloudWatch: `PutMetricData`/log write on #19 | `docker build`, any ECR push/pull, any application database connection, any Jenkins API or credential (NFR-01 boundary); `GetSecretValue` on #14 (ingress-only) |
| **CodeBuild per app+env** | `prms-reporting-dev` service role (#16) | S3: `GetObject` on the execution's source ZIP prefix only. ECR: push/pull scoped to #6's two repos only, plus `ecr:GetAuthorizationToken` on resource `*` (**accepted least-privilege exception**: AWS does not support resource-level scoping for this action; it only returns a short-lived auth token, no repository access by itself). Secrets Manager: `GetSecretValue` only for the build secrets declared **on this project**, DEV only. CloudWatch Logs: write to its own log group | Any other CodeBuild project's resources; any Secrets Manager entry not declared on this project; `<LEGACY_CODEBUILD_PROJECT>` (rejected per DD-08) |
| **Lambda alias destinations** | Addition to the existing `<QUALITY_WORKER_FUNCTION>` execution role (#17) | Added statements: `sqs:SendMessage` on #1 only, for the `cicd` alias's `onSuccess`/`onFailure` Destinations; S3 `GetObject` on `executions/*/source/*` only (reads `sourceRef`, design §6.2) and `PutObject` on `executions/*/quality/*` only (writes `logS3Uri` logs/reports, design §6.2) on #4. No other change to the function or its role (DD-07: "the unqualified function is not touched") | Any permission used by the function's existing (Jenkins) invocations; broadening beyond the one queue or the two S3 prefixes |
| **Ingress** | `cicd-github-ingress-dev` role (#18) | Secrets Manager: `GetSecretValue` on #14 (`<WEBHOOK_SECRET_REF>`) only. SQS: `SendMessage` on #1 only. CloudWatch Logs: write to its own log group | DynamoDB, S3, CodeBuild, Lambda invoke, any other secret — the ingress Lambda only verifies the signature and enqueues (design §6.6) |
| **Target instance profile** (`<PRMS_REPORTING_DEV_TARGET>`, host-side, not the Executor) | #23 | ECR: pull on #6 only, plus `ecr:GetAuthorizationToken` on resource `*` (**accepted least-privilege exception**, same reasoning as the CodeBuild role above). Secrets Manager: `GetSecretValue` on the DEV runtime secret (`envSecretRef`) only, resolved by the **target's own role**, never by the Executor (DD-23) | Any other environment's ECR repo or secret; `aws configure set` (rejected: FA §12.2.1, NFR-10) |

## Verification checklist

Derived from design §5 (data model) and proposal §14.1 (PoC resources table) — every row in
either source must map to a present resource above, or be explicitly marked as not yet
created with its blocking gate/OD.

| Source row | Mapped to # | Present? |
|---|---|---|
| design §5.1 `cicd-executions-dev` table (all item types: Execution, Step, Dedupe, Deploy window, Executor instance, Sequence, Target, Lock, Event mark) | #3 | yes |
| design §5.1 GSI1 (`pipelineId` + `startedAt`) | #3 | yes |
| design §5.1 GSI2 (sparse, `activeStatus` + `deadlineAt`, incl. `WINDOW` partition) | #3 | yes |
| design §5.2 S3 `cicd-artifacts-dev`, `executions/{id}/source/` | #4 | yes |
| design §5.2 S3 `executions/{id}/quality/` | #4 | yes |
| design §5.2 S3 lifecycle — source 7-day expiration | #4 | **yes — 7 d from object creation, independent of the deletion-on-finish event, declared explicitly above** |
| design §5.2 S3 lifecycle — quality/reports 30-day expiration | #4 | yes — 30 d declared |
| design §5.2 S3 lifecycle — incomplete multipart 1-day abort | #4 | yes — 1 d declared |
| design §5.3 state on the target (script, `runtime.env`, local mutex) | runtime state table | yes, marked as not independently provisioned |
| proposal §10.7 S3 SSE, Block Public Access, bucket policy restricted to the PoC's roles | #4 | yes — declared explicitly above |
| proposal §14.1 SQS Standard + DLQ | #1, #2 | yes |
| proposal §14.1 DynamoDB | #3 | yes |
| proposal §14.1 S3 | #4 | yes |
| proposal §14.1 ECR (`cicd-executor` + reused app repos) | #5, #6 | yes |
| proposal §14.1 CodeBuild + service role | #7, #16 | yes |
| proposal §14.1 Lambda (quality worker, async + Destinations) | #8, #17 | yes |
| proposal §14.1 Lambda (Inc 8, GitHub ingress) | #24 | yes — Gate C, Inc 8 (not yet physically created; row present for traceability per DD-17, same status as #14/#18/#23) |
| proposal §14.1 EventBridge (CodeBuild rule + Scheduler) | #9, #10 | yes |
| proposal §14.1 Secrets Manager (SSH, GitHub, Slack, webhook) | #11–#14 | yes |
| proposal §14.1 IAM (Executor, CodeBuild, Destinations, ingress) | #15–#18 | yes |
| proposal §14.1 CloudWatch (log groups, alarms, saved queries) | #19, #20, #21 | yes |
| proposal §14.1 microservices server (container, volume, credentials) | #22 | yes |
| proposal §14.1 `<PRMS_REPORTING_DEV_TARGET>` (instance profile, deploy user, key) | #23 | yes |

**First-pass note (kept for traceability):** on a first draft of this checklist that omitted
the 7-day source-artifact lifecycle, the `design §5.2 S3 lifecycle — source 7-day expiration`
row above would read **missing**, which is exactly the falsifier this checklist is built to
catch — it is declared in resource #4's configuration and the row now reads `yes`.

**Second-pass note (T-22 rework falsifier, kept for traceability):** with resource #24 removed
from the Resources table, the `proposal §14.1 Lambda (Inc 8, GitHub ingress)` row above has no
`#` to map to and must read **MISSING** (there is no resource to point at, which is exactly
what "every resource of §14.1 present" is meant to catch) — confirmed by deleting #24 and
re-deriving this checklist, then reverted; #24 is restored above and the row again reads `yes`.
