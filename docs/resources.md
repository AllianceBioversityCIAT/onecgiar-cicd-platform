# Resources at a Glance — CI/CD Executor PoC (DEV, Model B)

<!-- @akili-spec changes/cicd-executor-poc design DD-17, DD-24, DD-25, §4.1; proposal §14.1 -->

A one-page, operator-facing index of what exists for the PoC in DEV (account
`<AWS_ACCOUNT_ID>`, region `<AWS_REGION>`) and why. This is a **summary**: the authoritative,
IaC-agnostic contract — full configuration, trust shape, IAM, alarms and the verification
checklist — is `infra/RESOURCES.md` (design DD-17). When the two disagree,
`infra/RESOURCES.md` wins.

**Publication policy:** logical references only (design §4.1/DD-23); no real account, host,
IP, credential ID, ARN or job name.

## Quick path

- Looking for a resource's exact permissions, trust or alarms → `infra/RESOURCES.md`.
- Looking for what to *do* when something breaks → `docs/runbook.md`.
- Looking for the Jenkins coexistence window history → `docs/jenkins-coexistence-log.md`.
- Just need to know what exists and roughly what it's for → stay here.

## Resource index

| Resource | Type | Purpose |
|---|---|---|
| `cicd-events-dev` / `cicd-events-dev-dlq` | SQS | The single event queue, plus its DLQ |
| Queue policy on `cicd-events-dev` | SQS policy | `SendMessage` only for the CI roles, the Executor, the Scheduler target role and the operator principal |
| `cicd-executions-dev` | DynamoDB | Single source of truth: executions, rejections, dedupe, locks, target state, deploy windows; GSI2 for the reconciler |
| `cicd-executor` | ECR | The Executor's own container image |
| `<ECR_REPOSITORY>` (server, client) | ECR (existing, reused) | Application images, pushed by CI, pulled by `<PRMS_REPORTING_DEV_TARGET>` |
| GitHub IAM OIDC provider | IAM | Lets GitHub Actions obtain short-lived AWS credentials (DD-24) |
| CI role per repository and environment | IAM | ECR push to its repositories and `SendMessage` to the queue; trust bound to repository and owner IDs, Environment and the SHA-pinned reusable workflow |
| `cicd-reconcile-dev` + Scheduler target role | EventBridge Scheduler + IAM | Ticks the reconciler every 5 minutes (`RECONCILE_TICK`) |
| Operator principal | IAM | Sends window and `TARGET_RESOLUTION_RECORDED` events through the operator CLI |
| `<SSH_CREDENTIAL_REF>`, `<SLACK_TOKEN_REF>` and identifier references | Secrets Manager | SSH and Slack credentials read at point of use; non-sensitive principal references |
| `cicd-executor-dev` | IAM | The reduced Executor role: SQS, its table, those secrets, CloudWatch |
| Log groups, alarms, saved queries | CloudWatch | 30-day logs; alarms on DLQ depth, oldest-message age, heartbeat, rejected sender. **Planned, not yet wired:** `ExecutionsPastDeadline` and an unresolved-`UNKNOWN_TARGET_STATE` signal (see `infra/RESOURCES.md` **Alarms**) |
| GitHub Environment configuration | GitHub | Branch rules; one Environment secret (`CICD_ROLE_ARN`); Environment variables `CICD_BOUND_REF` (admin-only), `CICD_AWS_REGION`, `CICD_ECR_REPOSITORY`, `CICD_DEPLOY_QUEUE_NAME`; registry, queue URL and account ID derived after OIDC (design DD-24 v4.6) |
| Microservices server | Existing host | Runs the `cicd-executor` container (DD-18); no `/work` volume |
| `<PRMS_REPORTING_DEV_TARGET>` | Existing host | Where real deploys land, inside Jenkins-coexistence windows (DD-21) |

**Removed in Model B:** S3 artifacts bucket, CodeBuild project/role/buildspec, Lambda
async/Destinations, the EventBridge CodeBuild rule, the webhook ingress Lambda and Function
URL, the `/work` volume, the Executor's GitHub credential and its S3/Lambda/CodeBuild
permissions.

## What's still open

| Open decision | Blocks |
|---|---|
| OD-Q7 | **Resolved (owner, 2026-10-06, Gate B decision D-1):** AWS SAM / CloudFormation for the PoC — `infra/sam/template.yaml` |
| OD-Q11 | Confirming the Executor's host |
| OD-Q12 | How the Executor's AWS credentials are delivered on that host |
| OD-Q5 | How `<PRMS_REPORTING_DEV_TARGET>` obtains its own AWS permissions |
| OD-A6, OD-A9 | Adding callers of the reusable workflow; Environment protection per organization plan |
| OD-A7 | Tag immutability on the shared ECR repository |
| OD-A8 | Operator redeploy of an older digest or reset of order state (not available in the PoC) |
| P-7 (`UNVERIFIED`) | Whether DEV truly sits in a single AWS account with every other environment (isolation by account or only by IAM, NFR-09) |

## Next step

New to the incident? Start at `docs/runbook.md`'s Quick path. New to the PoC's
Jenkins-coexistence procedure? See `docs/jenkins-coexistence-log.md`.
