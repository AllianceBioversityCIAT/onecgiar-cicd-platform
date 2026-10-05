# Resources at a Glance — CI/CD Executor PoC (DEV)

<!-- @akili-spec changes/cicd-executor-poc design DD-17, §4.1; proposal §14.1 -->

A one-page, operator-facing index of what exists for the PoC in DEV (account
`<AWS_ACCOUNT_ID>`, region `<AWS_REGION>`) and why. This is a **summary**: the authoritative,
IaC-agnostic contract — full configuration, IAM, gates, and the verification checklist — is
`infra/RESOURCES.md` (design DD-17). When the two disagree, `infra/RESOURCES.md` wins.

**Publication policy:** logical references only (design §4.1/DD-23); no real account, host,
IP, credential ID, or job name.

## Quick path

- Looking for a resource's exact permissions or lifecycle config → `infra/RESOURCES.md`.
- Looking for what to *do* when something breaks → `docs/runbook.md`.
- Looking for the Jenkins coexistence window history → `docs/jenkins-coexistence-log.md`.
- Just need to know what exists and roughly what it's for → stay here.

## Resource index

| Resource | Type | Purpose |
|---|---|---|
| `cicd-events-dev` / `cicd-events-dev-dlq` | SQS | The Executor's single event queue, plus its DLQ |
| `cicd-executions-dev` | DynamoDB | Single source of truth: executions, steps, locks, dedupe, deploy windows, the reconciler's index |
| `cicd-artifacts-dev` | S3 | Source ZIPs and quality logs/reports, time-limited by lifecycle rules |
| `cicd-executor` | ECR | The Executor's own container image |
| `<ECR_REPOSITORY>` (server, client) | ECR (existing, reused) | `<PRMS_REPORTING_DEV_TARGET>`'s application images, built by CodeBuild |
| `prms-reporting-dev` | CodeBuild | Builds the server and client application images (DD-08) |
| `<QUALITY_WORKER_FUNCTION>` `cicd` alias | Lambda alias | Runs the existing quality worker asynchronously for the PoC, without touching its Jenkins-used unqualified function |
| `cicd-github-ingress-dev` (Gate C, Inc 8) | Lambda + Function URL | GitHub push webhook intake (FR-20, SHOULD) |
| `cicd-codebuild-state-dev` | EventBridge rule | Routes terminal CodeBuild build-status events into the queue |
| `cicd-reconcile-dev` | EventBridge Scheduler | Ticks the reconciler every 5 minutes |
| `<SSH_CREDENTIAL_REF>`, `<GITHUB_CREDENTIAL_REF>`, `<SLACK_TOKEN_REF>`, `<WEBHOOK_SECRET_REF>` | Secrets Manager | Credentials and tokens the Executor or ingress need, read at point of use only |
| `cicd-executor-dev`, CodeBuild service role, Destinations permission, ingress role | IAM | One least-privilege principal per component — see `infra/RESOURCES.md`'s **IAM by component** table |
| Log groups, alarms, saved queries | CloudWatch | 30-day logs; alarms on DLQ depth, oldest-message age, and Executor heartbeat; the "execution timeline" saved query. **Planned, not yet wired:** an alarm on executions alive past their deadline (FR-17), pending the reconciler's (T-11) `ExecutionsPastDeadline` metric — see `infra/RESOURCES.md` #20 |
| Microservices server | Existing host | Runs the `cicd-executor` container (DD-18) |
| `<PRMS_REPORTING_DEV_TARGET>` | Existing host | Where real deploys land, inside Jenkins-coexistence windows (DD-21) |

## What's still open

| Open decision | Blocks |
|---|---|
| OD-Q7 | Choosing the IaC tool (this file and `infra/RESOURCES.md` stay the contract until then) |
| OD-Q11 | Confirming the Executor's host |
| OD-Q12 | How the Executor's AWS credentials are delivered on that host |
| OD-Q5 | How `<PRMS_REPORTING_DEV_TARGET>` obtains its own AWS permissions |
| P-7 (`UNVERIFIED`) | Whether DEV truly sits in a single AWS account with every other environment (affects whether isolation is by account or only by IAM, NFR-09) |

## Next step

New to the incident? Start at `docs/runbook.md`'s Quick path. New to the PoC's
Jenkins-coexistence procedure? See `docs/jenkins-coexistence-log.md`.
